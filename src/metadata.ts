/**
 * metadata.ts — Custom JPEG EXIF writer
 *
 * Implements insert(), update(), and deleteMetadata() without any third-party
 * libraries. All JPEG manipulation is done at the byte/segment level using
 * Node.js built-ins (fs, Buffer, path).
 *
 * Key concepts used here:
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
 *
 * This file handles:
 *   • Splitting a JPEG into header segments + raw image data
 *   • Encoding user-supplied string EXIF tags into a TIFF/APP1 binary block
 *   • Merging new tags with existing ones (for insert / update semantics)
 *   • Reassembling a modified JPEG and writing it to disk
 */

import path from "node:path";
import fs   from "node:fs/promises";

// ─── Public Interface ──────────────────────────────────────────────────────────

/**
 * EXIF values to write, grouped by IFD (Image File Directory).
 * All values must be strings.
 *
 * IFD mapping used by this library:
 *   IFD0 — Main image IFD   (Make, Model, Artist, Copyright, DateTime, …)
 *   IFD1 — Exif Sub-IFD     (DateTimeOriginal, DateTimeDigitized, UserComment, …)
 *   IFD2 — GPS IFD          (not yet supported — requires RATIONAL encoding)
 *   IFD3 — Thumbnail IFD    (not yet implemented)
 *
 * Example:
 *   { IFD0: { Artist: "Alice", Copyright: "2024 Alice" },
 *     IFD1: { DateTimeOriginal: "2024:06:15 14:30:00" } }
 */
export interface ExifData {
    IFD0?: Record<string, string>;
    IFD1?: Record<string, string>; // mapped to ExifIFD (sub-IFD within IFD0)
    IFD2?: Record<string, string>; // reserved: GPS IFD (future)
    IFD3?: Record<string, string>; // reserved: thumbnail IFD (future)
}

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

// Special "pointer" tags that link IFD0 to its sub-IFDs:
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
        const segLen    = buf.readUInt16BE(offset + 2);
        const payloadLen = segLen - 2; // payload length = total length - 2 length bytes
        const payload   = Buffer.from(buf.subarray(offset + 4, offset + 4 + payloadLen));
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
// Encodes a flat map of { tagId → asciiString } into a TIFF-format binary block,
// then wraps it in an APP1 payload ready to be spliced into a JPEG.

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
 *   14+12N–…      String value data (for strings > 4 bytes that can't fit inline)
 *
 * Each 12-byte IFD entry:
 *   bytes 0–1   Tag ID (uint16 LE)
 *   bytes 2–3   Type: 2 = ASCII (uint16 LE)
 *   bytes 4–7   Count = string.length + 1 (includes null terminator) (uint32 LE)
 *   bytes 8–11  Inline value (if count ≤ 4) OR offset to string data (uint32 LE)
 */
function encodeTiffBlock(ifd0Tags: Map<number, string>, exifTags: Map<number, string>): Buffer {
    // ── Determine whether we need an ExifIFD sub-IFD ──────────────────────────
    // If the caller supplied any IFD1 (ExifIFD) tags, we must:
    //   1. Add an extra IFD0 entry (tag 0x8769) whose value is the byte offset
    //      pointing to the ExifIFD block that follows IFD0.
    //   2. Encode the ExifIFD entries as a second IFD block.
    const hasExifIfd = exifTags.size > 0;

    // ── Sort entries by tag ID (TIFF spec requires ascending order) ────────────
    const ifd0Entries  = [...ifd0Tags.entries()].sort(([a], [b]) => a - b);
    const exifEntries  = [...exifTags.entries()].sort(([a], [b]) => a - b);

    // IFD0 entry count = user tags + optional ExifIFD pointer tag
    const ifd0Count    = ifd0Entries.length + (hasExifIfd ? 1 : 0);
    const exifCount    = exifEntries.length;

    // ── Calculate block offsets ────────────────────────────────────────────────
    const TIFF_HEADER_SIZE = 8;
    const IFD0_SIZE        = 2 + ifd0Count  * 12 + 4; // count + entries + next-ptr
    const EXIF_IFD_SIZE    = hasExifIfd ? (2 + exifCount * 12 + 4) : 0;

    // IFD0 starts right after the TIFF header
    const IFD0_OFFSET      = TIFF_HEADER_SIZE;
    // ExifIFD starts right after IFD0 (if present)
    const EXIF_IFD_OFFSET  = IFD0_OFFSET + IFD0_SIZE;
    // String value data starts right after all IFD blocks
    let   valueAreaOffset  = EXIF_IFD_OFFSET + EXIF_IFD_SIZE;

    // ── Assign offsets to string values ───────────────────────────────────────
    // Strings ≤ 4 bytes (including null terminator) fit "inline" in the IFD entry.
    // Longer strings are placed in the value area and the entry holds their offset.
    const encodeStr = (v: string) => Buffer.from(v + "\0", "ascii");

    function assignOffsets(entries: [number, string][]): { buf: Buffer; offset: number }[] {
        return entries.map(([, v]) => {
            const buf  = encodeStr(v);
            if (buf.length <= 4) return { buf, offset: -1 }; // -1 = inline
            const off  = valueAreaOffset;
            valueAreaOffset += buf.length;
            return { buf, offset: off };
        });
    }

    const ifd0Vals  = assignOffsets(ifd0Entries);
    const exifVals  = assignOffsets(exifEntries);

    // ── Allocate the output buffer ─────────────────────────────────────────────
    const totalSize = valueAreaOffset; // valueAreaOffset now = first byte PAST value area
    const out = Buffer.alloc(totalSize, 0);

    // ── Write TIFF header ──────────────────────────────────────────────────────
    out.write("II", 0, "ascii");          // Intel (little-endian) byte order
    out.writeUInt16LE(0x002A, 2);         // TIFF magic: 42
    out.writeUInt32LE(IFD0_OFFSET, 4);   // offset to IFD0 (= 8)

    // ── Write IFD0 ────────────────────────────────────────────────────────────
    let pos = IFD0_OFFSET;
    out.writeUInt16LE(ifd0Count, pos); pos += 2;

    // Write user-supplied IFD0 entries
    for (let i = 0; i < ifd0Entries.length; i++) {
        const [tagId] = ifd0Entries[i];
        const { buf, offset } = ifd0Vals[i];
        writeIfdEntry(out, pos, tagId, buf, offset);
        pos += 12;
    }

    // Write ExifIFD pointer entry (if we have ExifIFD tags)
    // This entry's "value" is the byte offset of the ExifIFD block.
    // Type = LONG (4), count = 1, value = EXIF_IFD_OFFSET.
    if (hasExifIfd) {
        out.writeUInt16LE(TAG_EXIF_IFD_POINTER, pos + 0); // tag 0x8769
        out.writeUInt16LE(4,                    pos + 2); // type: LONG
        out.writeUInt32LE(1,                    pos + 4); // count: 1
        out.writeUInt32LE(EXIF_IFD_OFFSET,      pos + 8); // value = ExifIFD offset
        pos += 12;
    }

    out.writeUInt32LE(0, pos); pos += 4; // next IFD pointer = 0 (no next IFD)

    // ── Write ExifIFD (if present) ────────────────────────────────────────────
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

    // ── Write string value data ────────────────────────────────────────────────
    for (const { buf, offset } of [...ifd0Vals, ...exifVals]) {
        if (offset !== -1) {
            buf.copy(out, offset); // copy string (including \0) to value area
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
        // Inline: copy string bytes directly into bytes 8–11 of the entry
        strBuf.copy(out, pos + 8);
        // Remaining bytes are already 0 (from Buffer.alloc)
    } else {
        // Offset: store the pointer to the string in the value area
        out.writeUInt32LE(offset, pos + 8);
    }
}

/**
 * Wrap a TIFF block in an APP1 EXIF payload.
 *
 * APP1 payload format:
 *   6 bytes  EXIF identifier: "Exif\0\0"  (hex: 45 78 69 66 00 00)
 *   N bytes  TIFF block
 *
 * (The caller is responsible for prepending the FF E1 marker and 2-byte length.)
 */
function buildApp1Payload(tiffBlock: Buffer): Buffer {
    const exifId = Buffer.from("Exif\0\0", "ascii"); // 6-byte EXIF identifier
    return Buffer.concat([exifId, tiffBlock]);
}

// ─── Existing EXIF Extraction ──────────────────────────────────────────────────
// For insert() and update(), we need to read any existing EXIF string tags
// so we can merge them with the caller's new tags.

/**
 * Find the first APP1 EXIF segment in a list of JPEG segments and return its
 * TIFF block (the payload after "Exif\0\0"), or null if none exists.
 */
function findExistingTiff(segments: JpegSegment[]): Buffer | null {
    for (const seg of segments) {
        if (seg.marker !== 0xE1) continue; // APP1 = 0xE1
        if (seg.payload.length < 6) continue;
        if (seg.payload.subarray(0, 6).toString("ascii") !== "Exif\0\0") continue;
        return seg.payload.subarray(6); // TIFF block starts after "Exif\0\0"
    }
    return null;
}

/**
 * Extract all ASCII-typed tags from an existing TIFF block's IFD0 and ExifIFD.
 *
 * We only read ASCII (type 2) tags because those are the ones we can safely
 * re-encode. Non-ASCII tags (orientation, GPS rationals, thumbnails, etc.) are
 * skipped to avoid lossy re-encoding. They will NOT be preserved through
 * insert()/update() unless explicitly provided by the caller.
 *
 * Returns two Maps:
 *   [ifd0Tags,  exifTags]
 *   The key is the numeric TIFF tag ID; the value is the decoded string.
 */
function readExistingStringTags(tiff: Buffer): [Map<number, string>, Map<number, string>] {
    const ifd0Tags = new Map<number, string>();
    const exifTags = new Map<number, string>();

    if (tiff.length < 8) return [ifd0Tags, exifTags];

    const byteOrder = tiff.subarray(0, 2).toString("ascii");
    const le = byteOrder === "II";

    // Validate TIFF magic
    const magic = le ? tiff.readUInt16LE(2) : tiff.readUInt16BE(2);
    if (magic !== 0x002A) return [ifd0Tags, exifTags];

    const ifd0Offset = le ? tiff.readUInt32LE(4) : tiff.readUInt32BE(4);

    // Helper: extract ASCII entries from one IFD
    function extractAscii(ifdOffset: number, into: Map<number, string>): void {
        if (ifdOffset + 2 > tiff.length) return;
        const count = le ? tiff.readUInt16LE(ifdOffset) : tiff.readUInt16BE(ifdOffset);
        for (let i = 0; i < count; i++) {
            const ep = ifdOffset + 2 + i * 12; // entry position
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

/**
 * Convert user-supplied ExifData into (ifd0TagMap, exifIfdTagMap).
 * Tag names that are not recognised are silently ignored.
 * To support additional tags, add them to IFD0_TAG_IDS or EXIF_IFD_TAG_IDS above.
 */
function flattenExifData(exif: ExifData): [Map<number, string>, Map<number, string>] {
    const ifd0 = new Map<number, string>();
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

// ─── Path Safety Guard ────────────────────────────────────────────────────────

/**
 * Throw if the input and output paths point to the same file.
 * This prevents accidentally overwriting the original image.
 */
function assertDistinctPaths(input: string, output: string): void {
    if (path.resolve(input) === path.resolve(output)) {
        throw new Error("Input and output paths must be different to protect the original image.");
    }
}

// ─── EXIF Segment Filter ───────────────────────────────────────────────────────

/**
 * Return true if a segment is an APP1 EXIF segment (to be removed before inserting
 * a new one). We identify EXIF APP1 segments by the "Exif\0\0" payload header.
 */
function isExifApp1(seg: JpegSegment): boolean {
    return seg.marker === 0xE1 &&
           seg.payload.length >= 6 &&
           seg.payload.subarray(0, 6).toString("ascii") === "Exif\0\0";
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Add EXIF fields to a JPEG image, preserving any already-existing EXIF fields.
 *
 * Merge semantics for insert():
 *   • If a tag is already present in the source image, its existing value is kept.
 *   • Tags supplied in `exif` that are NOT already present are added.
 *
 * Note: only ASCII string tags are preserved from the existing EXIF (see
 * readExistingStringTags for the reasoning). Binary tags such as orientation,
 * GPS rationals, and thumbnails are not carried over.
 *
 * @param input   Path to the source JPEG image.
 * @param output  Path where the result is written. Must differ from `input`.
 * @param exif    Tags to insert.
 */
export async function insert(input: string, output: string, exif: ExifData): Promise<void> {
    assertDistinctPaths(input, output);

    const buf    = await fs.readFile(input);
    const parsed = parseJpeg(buf);

    // Read existing ASCII EXIF tags (if any) from the source image
    const existingTiff = findExistingTiff(parsed.segments);
    const [existingIfd0, existingExif] = existingTiff
        ? readExistingStringTags(existingTiff)
        : [new Map<number, string>(), new Map<number, string>()];

    // Flatten the caller's ExifData into tag maps
    const [newIfd0, newExif] = flattenExifData(exif);

    // Merge: existing wins — only add new tags that aren't already in the source
    const mergedIfd0 = new Map([...newIfd0, ...existingIfd0]); // existingIfd0 overwrites newIfd0 for duplicates
    const mergedExif = new Map([...newExif, ...existingExif]);

    // Build and splice in the new APP1 segment
    const tiffBlock   = encodeTiffBlock(mergedIfd0, mergedExif);
    const app1Payload = buildApp1Payload(tiffBlock);

    // Remove any existing EXIF APP1 segment, then insert the new one after SOI
    const filtered = parsed.segments.filter(s => !isExifApp1(s));
    filtered.splice(1, 0, { marker: 0xE1, payload: app1Payload }); // position 1 = after SOI

    await fs.writeFile(output, assembleJpeg({ segments: filtered, imageData: parsed.imageData }));
}

/**
 * Replace specified EXIF fields in a JPEG image, preserving unrelated fields.
 *
 * Merge semantics for update():
 *   • Tags supplied in `exif` OVERWRITE their existing counterparts in the source.
 *   • Existing tags NOT mentioned in `exif` are kept as-is.
 *
 * @param input   Path to the source JPEG image.
 * @param output  Path where the result is written. Must differ from `input`.
 * @param exif    Tags to update.
 */
export async function update(input: string, output: string, exif: ExifData): Promise<void> {
    assertDistinctPaths(input, output);

    const buf    = await fs.readFile(input);
    const parsed = parseJpeg(buf);

    // Read existing ASCII EXIF tags from the source image
    const existingTiff = findExistingTiff(parsed.segments);
    const [existingIfd0, existingExif] = existingTiff
        ? readExistingStringTags(existingTiff)
        : [new Map<number, string>(), new Map<number, string>()];

    // Flatten the caller's ExifData into tag maps
    const [newIfd0, newExif] = flattenExifData(exif);

    // Merge: new wins — caller's tags overwrite any existing values
    const mergedIfd0 = new Map([...existingIfd0, ...newIfd0]); // newIfd0 overwrites for duplicates
    const mergedExif = new Map([...existingExif, ...newExif]);

    // Build and splice in the new APP1 segment
    const tiffBlock   = encodeTiffBlock(mergedIfd0, mergedExif);
    const app1Payload = buildApp1Payload(tiffBlock);

    const filtered = parsed.segments.filter(s => !isExifApp1(s));
    filtered.splice(1, 0, { marker: 0xE1, payload: app1Payload });

    await fs.writeFile(output, assembleJpeg({ segments: filtered, imageData: parsed.imageData }));
}

/**
 * Strip all EXIF metadata from a JPEG image.
 *
 * This removes any APP1 segments whose payload begins with "Exif\0\0".
 * All other segments (APP0 JFIF, DQT quantisation tables, DHT Huffman tables,
 * comments, etc.) and the pixel data are preserved exactly.
 *
 * @param input   Path to the source JPEG image.
 * @param output  Path where the stripped image is written. Must differ from `input`.
 */
export async function removeMetadata(input: string, output: string): Promise<void> {
    assertDistinctPaths(input, output);

    const buf    = await fs.readFile(input);
    const parsed = parseJpeg(buf);

    // Remove EXIF APP1 segments; keep everything else (APP0 JFIF, DQT, DHT, …)
    const stripped = parsed.segments.filter(s => !isExifApp1(s));

    await fs.writeFile(output, assembleJpeg({ segments: stripped, imageData: parsed.imageData }));
}
