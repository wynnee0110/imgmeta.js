/**
 * metadata/jpeg.ts — JPEG-specific EXIF write/update/remove operations
 *
 * Contains all byte-level binary logic for manipulating EXIF inside JPEG files:
 *   • Splitting a JPEG into header segments + raw image data
 *   • Encoding user-supplied string EXIF tags into a TIFF/APP1 binary block
 *   • Merging new tags with existing ones (for insert / update semantics)
 *   • Reassembling a modified JPEG and writing it to disk
 *
 * Key JPEG concepts:
 *
 *   JPEG segment  — A self-contained block inside a JPEG file.
 *                   Format: FF <marker byte> <2-byte length> <payload>
 *                   The length field includes itself but not the 2-byte marker.
 *
 *   APP1 (0xE1)   — The segment that carries EXIF metadata.
 *                   Its payload starts with "Exif\0\0" followed by a TIFF block.
 *
 *   TIFF block    — The binary encoding of EXIF tags.
 *                   Uses IFDs (Image File Directories): sorted lists of 12-byte entries.
 *
 *   IFD entry     — 12 bytes: tag ID (2) + type (2) + count (4) + value/offset (4)
 */

import fs from "node:fs/promises";
import type { ExifData } from "../metadata.js";

// ─── Tag Name → Numeric ID Tables ─────────────────────────────────────────────
// Maps the string tag names used in ExifData to the numeric IDs in the TIFF spec.

/** IFD0 — main image directory tags */
const IFD0_TAG_IDS: Record<string, number> = {
    ImageDescription: 0x010E, // Free-text description of the image content
    Make:             0x010F, // Camera manufacturer, e.g. "Sony"
    Model:            0x0110, // Camera model, e.g. "A7 IV"
    Software:         0x0131, // Software/firmware that created or processed the image
    DateTime:         0x0132, // Date/time the image was last modified ("YYYY:MM:DD HH:MM:SS")
    Artist:           0x013B, // Name of the photographer or copyright holder
    Copyright:        0x8298, // Copyright notice, e.g. "© 2024 Jane Doe"
};

/** ExifIFD — Exif-specific tags stored in a sub-IFD (pointed to by tag 0x8769 in IFD0) */
const EXIF_IFD_TAG_IDS: Record<string, number> = {
    DateTimeOriginal:  0x9003, // Date/time the shutter was pressed ("YYYY:MM:DD HH:MM:SS")
    DateTimeDigitized: 0x9004, // Date/time the image was scanned/digitised
    UserComment:       0x9286, // Free-form comment (first 8 bytes = charset; rest = text)
};

// Special "pointer" tag that links IFD0 to the ExifIFD sub-IFD:
const TAG_EXIF_IFD_POINTER = 0x8769; // LONG offset in IFD0 pointing to ExifIFD

// ─── JPEG Segment Utilities ───────────────────────────────────────────────────

/** A parsed JPEG segment (one element of the pre-SOS header chain). */
interface JpegSegment {
    marker:  number; // e.g. 0xE1 for APP1, 0xE0 for APP0, 0xFE for comment
    payload: Buffer; // bytes between the length field and the next segment
}

/**
 * Parsed representation of a JPEG file split into two parts:
 *   segments  — all metadata segments before the Start of Scan
 *   imageData — the raw compressed pixel data from SOS onwards (never modified)
 */
interface ParsedJpeg {
    segments:  JpegSegment[];
    imageData: Buffer; // starts with FF DA (SOS marker), ends with FF D9 (EOI)
}

/**
 * Parse a JPEG buffer into its header segments and raw image data.
 *
 * Why we split at SOS:
 *   Everything before the SOS marker is metadata (APP0, APP1, DQT, DHT, etc.)
 *   and can be safely rearranged or replaced. The SOS segment and everything
 *   after it is the compressed Huffman-coded image data and must be preserved
 *   byte-for-byte.
 *
 * @throws If the buffer does not start with the JPEG SOI marker FF D8.
 */
function parseJpeg(buf: Buffer): ParsedJpeg {
    if (buf[0] !== 0xFF || buf[1] !== 0xD8) {
        throw new Error("Not a valid JPEG: missing SOI marker (FF D8)");
    }

    const segments: JpegSegment[] = [];
    // SOI (Start of Image) — the mandatory first marker, has no payload
    segments.push({ marker: 0xD8, payload: Buffer.alloc(0) });

    let offset = 2; // start after the 2-byte SOI

    while (offset + 2 <= buf.length) {
        if (buf[offset] !== 0xFF) {
            throw new Error(`JPEG segment sync lost at byte offset ${offset}`);
        }

        const marker = buf[offset + 1];

        // SOS (FF DA) — everything from this point is raw compressed image data.
        // We save it wholesale and stop segment parsing.
        if (marker === 0xDA) {
            return { segments, imageData: buf.subarray(offset) };
        }

        // EOI (FF D9) — end of image, no payload
        if (marker === 0xD9) {
            segments.push({ marker: 0xD9, payload: Buffer.alloc(0) });
            offset += 2;
            continue;
        }

        // RST markers (FF D0–FF D7) — restart markers inserted between MCU rows,
        // no length field, no payload
        if (marker >= 0xD0 && marker <= 0xD7) {
            segments.push({ marker, payload: Buffer.alloc(0) });
            offset += 2;
            continue;
        }

        // Standard segment: 2-byte big-endian length (includes the length bytes)
        if (offset + 4 > buf.length) break;
        const segLen     = buf.readUInt16BE(offset + 2);
        const payloadLen = segLen - 2; // payload length = total length - 2 length bytes
        const payload    = Buffer.from(buf.subarray(offset + 4, offset + 4 + payloadLen));
        segments.push({ marker, payload });
        offset += 2 + segLen;
    }

    return { segments, imageData: Buffer.alloc(0) };
}

/**
 * Reassemble a ParsedJpeg back into a complete JPEG Buffer.
 *
 * Output byte layout for each segment:
 *   FF <marker>           (2 bytes, always)
 *   <length>              (2 bytes big-endian: payload.length + 2) — for non-SOI/EOI/RST
 *   <payload>             (payload.length bytes)
 *
 * Followed by imageData verbatim (FF DA SOS + compressed data + FF D9 EOI).
 */
function assembleJpeg(parsed: ParsedJpeg): Buffer {
    const parts: Buffer[] = [];

    for (const seg of parsed.segments) {
        parts.push(Buffer.from([0xFF, seg.marker]));

        // Markers without payload: SOI (D8), EOI (D9), RST (D0–D7)
        if (seg.marker === 0xD8 || seg.marker === 0xD9 ||
            (seg.marker >= 0xD0 && seg.marker <= 0xD7)) {
            continue; // no length or payload bytes
        }

        // Regular segment: emit 2-byte length then payload
        const lenBuf = Buffer.allocUnsafe(2);
        lenBuf.writeUInt16BE(seg.payload.length + 2); // +2 because length includes itself
        parts.push(lenBuf, seg.payload);
    }

    // Append the unchanged compressed image data (SOS → EOI)
    if (parsed.imageData.length > 0) {
        parts.push(parsed.imageData);
    }

    return Buffer.concat(parts);
}

// ─── TIFF / APP1 Encoder ──────────────────────────────────────────────────────

/**
 * Encode a map of (tagId → asciiString) as a TIFF IFD0 binary block.
 *
 * Output TIFF block layout (all values little-endian — "II" byte order):
 *
 *   Offset        Content
 *   ─────────     ──────────────────────────────────────────────────────────
 *   0–1           Byte order mark: "II" (49 49)
 *   2–3           TIFF magic: 0x002A
 *   4–7           IFD0 offset = 8 (right after the header)
 *   8–9           Number of IFD entries (N)
 *   10–(10+12N−1) N × 12-byte IFD entries (sorted by tag ID ascending)
 *   10+12N–13+12N Next IFD pointer = 0 (no second IFD)
 *   14+12N–…      String value data (for strings > 4 bytes)
 */
function encodeTiffBlock(ifd0Tags: Map<number, string>, exifTags: Map<number, string>): Buffer {
    const hasExifIfd = exifTags.size > 0;

    const ifd0Entries  = [...ifd0Tags.entries()].sort(([a], [b]) => a - b);
    const exifEntries  = [...exifTags.entries()].sort(([a], [b]) => a - b);

    const ifd0Count    = ifd0Entries.length + (hasExifIfd ? 1 : 0);
    const exifCount    = exifEntries.length;

    const TIFF_HEADER_SIZE = 8;
    const IFD0_SIZE        = 2 + ifd0Count  * 12 + 4;
    const EXIF_IFD_SIZE    = hasExifIfd ? (2 + exifCount * 12 + 4) : 0;

    const IFD0_OFFSET      = TIFF_HEADER_SIZE;
    const EXIF_IFD_OFFSET  = IFD0_OFFSET + IFD0_SIZE;
    let   valueAreaOffset  = EXIF_IFD_OFFSET + EXIF_IFD_SIZE;

    const encodeStr = (v: string) => Buffer.from(v + "\0", "ascii");

    function assignOffsets(entries: [number, string][]): { buf: Buffer; offset: number }[] {
        return entries.map(([, v]) => {
            const buf = encodeStr(v);
            if (buf.length <= 4) return { buf, offset: -1 }; // -1 = inline
            const off = valueAreaOffset;
            valueAreaOffset += buf.length;
            return { buf, offset: off };
        });
    }

    const ifd0Vals = assignOffsets(ifd0Entries);
    const exifVals = assignOffsets(exifEntries);

    const totalSize = valueAreaOffset;
    const out = Buffer.alloc(totalSize, 0);

    // Write TIFF header
    out.write("II", 0, "ascii");        // Intel (little-endian) byte order
    out.writeUInt16LE(0x002A, 2);       // TIFF magic: 42
    out.writeUInt32LE(IFD0_OFFSET, 4); // offset to IFD0

    // Write IFD0
    let pos = IFD0_OFFSET;
    out.writeUInt16LE(ifd0Count, pos); pos += 2;

    for (let i = 0; i < ifd0Entries.length; i++) {
        const [tagId] = ifd0Entries[i];
        const { buf, offset } = ifd0Vals[i];
        writeIfdEntry(out, pos, tagId, buf, offset);
        pos += 12;
    }

    if (hasExifIfd) {
        // ExifIFD pointer entry
        out.writeUInt16LE(TAG_EXIF_IFD_POINTER, pos + 0);
        out.writeUInt16LE(4,                    pos + 2); // type: LONG
        out.writeUInt32LE(1,                    pos + 4); // count: 1
        out.writeUInt32LE(EXIF_IFD_OFFSET,      pos + 8);
        pos += 12;
    }

    out.writeUInt32LE(0, pos); pos += 4; // next IFD pointer = 0

    // Write ExifIFD
    if (hasExifIfd) {
        pos = EXIF_IFD_OFFSET;
        out.writeUInt16LE(exifCount, pos); pos += 2;

        for (let i = 0; i < exifEntries.length; i++) {
            const [tagId] = exifEntries[i];
            const { buf, offset } = exifVals[i];
            writeIfdEntry(out, pos, tagId, buf, offset);
            pos += 12;
        }

        out.writeUInt32LE(0, pos); // next IFD pointer = 0
    }

    // Write string value data
    for (const { buf, offset } of [...ifd0Vals, ...exifVals]) {
        if (offset !== -1) {
            buf.copy(out, offset);
        }
    }

    return out;
}

/**
 * Write one 12-byte IFD entry into a buffer at a given position.
 *
 * @param out     Output buffer
 * @param pos     Byte position within `out` where the entry starts
 * @param tagId   TIFF tag ID
 * @param strBuf  The ASCII string bytes (including null terminator)
 * @param offset  -1 to store inline, or the byte offset into the TIFF block
 */
function writeIfdEntry(out: Buffer, pos: number, tagId: number, strBuf: Buffer, offset: number): void {
    out.writeUInt16LE(tagId,         pos + 0); // tag ID
    out.writeUInt16LE(2,             pos + 2); // data type: 2 = ASCII
    out.writeUInt32LE(strBuf.length, pos + 4); // count (includes null terminator)

    if (offset === -1) {
        strBuf.copy(out, pos + 8); // inline value
    } else {
        out.writeUInt32LE(offset, pos + 8); // pointer to value area
    }
}

/**
 * Wrap a TIFF block in an APP1 EXIF payload.
 *
 * APP1 payload format:
 *   6 bytes  EXIF identifier: "Exif\0\0"  (hex: 45 78 69 66 00 00)
 *   N bytes  TIFF block
 */
function buildApp1Payload(tiffBlock: Buffer): Buffer {
    const exifId = Buffer.from("Exif\0\0", "ascii");
    return Buffer.concat([exifId, tiffBlock]);
}

// ─── Existing EXIF Extraction ──────────────────────────────────────────────────

/** Find the APP1 EXIF segment and return its raw TIFF block, or null. */
function findExistingTiff(segments: JpegSegment[]): Buffer | null {
    for (const seg of segments) {
        if (seg.marker !== 0xE1) continue;
        if (seg.payload.length < 6) continue;
        if (seg.payload.subarray(0, 6).toString("ascii") !== "Exif\0\0") continue;
        return seg.payload.subarray(6);
    }
    return null;
}

/**
 * Extract all ASCII-typed tags from an existing TIFF block's IFD0 and ExifIFD.
 * Returns [ifd0Tags, exifTags] as Maps of numeric tag ID → string value.
 */
function readExistingStringTags(tiff: Buffer): [Map<number, string>, Map<number, string>] {
    const ifd0Tags = new Map<number, string>();
    const exifTags = new Map<number, string>();

    if (tiff.length < 8) return [ifd0Tags, exifTags];

    const byteOrder = tiff.subarray(0, 2).toString("ascii");
    const le = byteOrder === "II";

    const magic = le ? tiff.readUInt16LE(2) : tiff.readUInt16BE(2);
    if (magic !== 0x002A) return [ifd0Tags, exifTags];

    const ifd0Offset = le ? tiff.readUInt32LE(4) : tiff.readUInt32BE(4);

    function extractAscii(ifdOffset: number, into: Map<number, string>): void {
        if (ifdOffset + 2 > tiff.length) return;
        const count = le ? tiff.readUInt16LE(ifdOffset) : tiff.readUInt16BE(ifdOffset);
        for (let i = 0; i < count; i++) {
            const ep = ifdOffset + 2 + i * 12;
            if (ep + 12 > tiff.length) break;

            const tagId  = le ? tiff.readUInt16LE(ep)     : tiff.readUInt16BE(ep);
            const type   = le ? tiff.readUInt16LE(ep + 2) : tiff.readUInt16BE(ep + 2);
            const nChars = le ? tiff.readUInt32LE(ep + 4) : tiff.readUInt32BE(ep + 4);

            if (type !== 2) continue; // only ASCII

            let strBuf: Buffer;
            if (nChars <= 4) {
                strBuf = tiff.subarray(ep + 8, ep + 8 + nChars);
            } else {
                const valOff = le ? tiff.readUInt32LE(ep + 8) : tiff.readUInt32BE(ep + 8);
                if (valOff + nChars > tiff.length) continue;
                strBuf = tiff.subarray(valOff, valOff + nChars);
            }

            const str = strBuf.toString("ascii").replace(/\0+$/, "").trim();
            if (str.length > 0) into.set(tagId, str);
        }
    }

    extractAscii(ifd0Offset, ifd0Tags);

    // Follow the ExifIFD pointer (tag 0x8769) if present
    const entryCount = le ? tiff.readUInt16LE(ifd0Offset) : tiff.readUInt16BE(ifd0Offset);
    for (let i = 0; i < entryCount; i++) {
        const ep = ifd0Offset + 2 + i * 12;
        if (ep + 12 > tiff.length) break;
        const tagId = le ? tiff.readUInt16LE(ep) : tiff.readUInt16BE(ep);
        if (tagId === 0x8769) {
            const exifOffset = le ? tiff.readUInt32LE(ep + 8) : tiff.readUInt32BE(ep + 8);
            extractAscii(exifOffset, exifTags);
            break;
        }
    }

    return [ifd0Tags, exifTags];
}

// ─── ExifData → Tag Maps ───────────────────────────────────────────────────────

/** Convert user-supplied ExifData into (ifd0TagMap, exifIfdTagMap). */
function flattenExifData(exif: ExifData): [Map<number, string>, Map<number, string>] {
    const ifd0  = new Map<number, string>();
    const exif1 = new Map<number, string>();

    for (const [name, val] of Object.entries(exif.IFD0 ?? {})) {
        const id = IFD0_TAG_IDS[name];
        if (id !== undefined) ifd0.set(id, val);
    }

    for (const [name, val] of Object.entries(exif.IFD1 ?? {})) {
        const id = EXIF_IFD_TAG_IDS[name];
        if (id !== undefined) exif1.set(id, val);
    }

    return [ifd0, exif1];
}

// ─── EXIF Segment Filter ───────────────────────────────────────────────────────

/** Returns true if a segment is an APP1 EXIF segment (Exif\0\0 header). */
function isExifApp1(seg: JpegSegment): boolean {
    return seg.marker === 0xE1 &&
           seg.payload.length >= 6 &&
           seg.payload.subarray(0, 6).toString("ascii") === "Exif\0\0";
}

// ─── Public Functions ──────────────────────────────────────────────────────────

/**
 * Add EXIF fields to a JPEG image, preserving any already-existing EXIF fields.
 * Existing tags win — new tags are only added if not already present.
 */
export async function insertJpeg(input: string, output: string, exif: ExifData): Promise<void> {
    const buf    = await fs.readFile(input);
    const parsed = parseJpeg(buf);

    const existingTiff = findExistingTiff(parsed.segments);
    const [existingIfd0, existingExif] = existingTiff
        ? readExistingStringTags(existingTiff)
        : [new Map<number, string>(), new Map<number, string>()];

    const [newIfd0, newExif] = flattenExifData(exif);

    // Merge: existing wins over new (insert semantics)
    const mergedIfd0 = new Map([...newIfd0, ...existingIfd0]);
    const mergedExif = new Map([...newExif, ...existingExif]);

    const tiffBlock   = encodeTiffBlock(mergedIfd0, mergedExif);
    const app1Payload = buildApp1Payload(tiffBlock);

    const filtered = parsed.segments.filter(s => !isExifApp1(s));
    filtered.splice(1, 0, { marker: 0xE1, payload: app1Payload }); // after SOI

    await fs.writeFile(output, assembleJpeg({ segments: filtered, imageData: parsed.imageData }));
}

/**
 * Replace specified EXIF fields in a JPEG image, preserving unrelated fields.
 * Caller's tags win — they overwrite any existing values for those tags.
 */
export async function updateJpeg(input: string, output: string, exif: ExifData): Promise<void> {
    const buf    = await fs.readFile(input);
    const parsed = parseJpeg(buf);

    const existingTiff = findExistingTiff(parsed.segments);
    const [existingIfd0, existingExif] = existingTiff
        ? readExistingStringTags(existingTiff)
        : [new Map<number, string>(), new Map<number, string>()];

    const [newIfd0, newExif] = flattenExifData(exif);

    // Merge: new wins over existing (update semantics)
    const mergedIfd0 = new Map([...existingIfd0, ...newIfd0]);
    const mergedExif = new Map([...existingExif, ...newExif]);

    const tiffBlock   = encodeTiffBlock(mergedIfd0, mergedExif);
    const app1Payload = buildApp1Payload(tiffBlock);

    const filtered = parsed.segments.filter(s => !isExifApp1(s));
    filtered.splice(1, 0, { marker: 0xE1, payload: app1Payload });

    await fs.writeFile(output, assembleJpeg({ segments: filtered, imageData: parsed.imageData }));
}

/**
 * Strip all EXIF metadata from a JPEG image.
 * Removes APP1 segments with "Exif\0\0" header. All other data is preserved.
 */
export async function removeJpeg(input: string, output: string): Promise<void> {
    const buf    = await fs.readFile(input);
    const parsed = parseJpeg(buf);

    const stripped = parsed.segments.filter(s => !isExifApp1(s));

    await fs.writeFile(output, assembleJpeg({ segments: stripped, imageData: parsed.imageData }));
}
