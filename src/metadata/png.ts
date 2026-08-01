/**
 * metadata/png.ts — PNG-specific EXIF read/write/remove operations
 *
 * PNG stores EXIF inside a dedicated chunk of type "eXIf".
 * The binary layout of a PNG chunk is:
 *
 *   4 bytes  — data length (big-endian uint32, does NOT include type or CRC)
 *   4 bytes  — chunk type: "eXIf" (65 58 49 66)
 *   N bytes  — data: a raw TIFF block (same format as a JPEG APP1 TIFF block)
 *   4 bytes  — CRC-32 of (type + data)
 *
 * Reference: http://ftp-osl.osuosl.org/pub/libpng/documents/pngext-1.5.0.html#C.eXIf
 */

import fs from "node:fs/promises";
import type { ExifData } from "../metadata.js";

// ─── CRC-32 ───────────────────────────────────────────────────────────────────
// Standard PNG CRC-32 using the ISO 3309 polynomial 0xEDB88320.
// Pre-computed lookup table for performance.

const CRC_TABLE: Uint32Array = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        t[n] = c;
    }
    return t;
})();

function crc32(buf: Buffer): number {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF]! ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ─── PNG Chunk Utilities ──────────────────────────────────────────────────────

/** A parsed PNG chunk. */
interface PngChunk {
    type: string; // 4-character ASCII type, e.g. "IHDR", "eXIf", "IEND"
    data: Buffer; // raw chunk data (excludes length, type, and CRC fields)
}

/**
 * Parse a PNG buffer into its constituent chunks.
 *
 * @throws If the buffer does not start with the 8-byte PNG signature.
 */
function parsePng(buf: Buffer): PngChunk[] {
    const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) {
        throw new Error("Not a valid PNG: missing PNG signature.");
    }

    const chunks: PngChunk[] = [];
    let offset = 8; // skip the 8-byte signature

    while (offset + 12 <= buf.length) { // minimum chunk size: 4+4+0+4
        const dataLen = buf.readUInt32BE(offset);
        const type    = buf.subarray(offset + 4, offset + 8).toString("ascii");
        const data    = Buffer.from(buf.subarray(offset + 8, offset + 8 + dataLen));
        // CRC at offset + 8 + dataLen (4 bytes) — we skip validation on read
        chunks.push({ type, data });
        offset += 4 + 4 + dataLen + 4;

        if (type === "IEND") break; // always the last chunk
    }

    return chunks;
}

/**
 * Serialise a list of PNG chunks back into a complete PNG Buffer.
 * Computes a fresh CRC-32 for every chunk.
 */
function assemblePng(chunks: PngChunk[]): Buffer {
    const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const parts: Buffer[] = [PNG_SIG];

    for (const chunk of chunks) {
        const typeBuf = Buffer.from(chunk.type, "ascii");

        // Length field (4 bytes, big-endian) — length of data only
        const lenBuf = Buffer.allocUnsafe(4);
        lenBuf.writeUInt32BE(chunk.data.length, 0);

        // CRC covers type + data
        const crcInput = Buffer.concat([typeBuf, chunk.data]);
        const crcVal   = crc32(crcInput);
        const crcBuf   = Buffer.allocUnsafe(4);
        crcBuf.writeUInt32BE(crcVal, 0);

        parts.push(lenBuf, typeBuf, chunk.data, crcBuf);
    }

    return Buffer.concat(parts);
}

// ─── Tag Name → Numeric ID Tables ─────────────────────────────────────────────
// Mirrors the same tables used in metadata/jpeg.ts.

/** IFD0 — main image directory tags */
const IFD0_TAG_IDS: Record<string, number> = {
    ImageDescription: 0x010E,
    Make:             0x010F,
    Model:            0x0110,
    Software:         0x0131,
    DateTime:         0x0132,
    Artist:           0x013B,
    Copyright:        0x8298,
};

/** ExifIFD — Exif-specific tags stored in a sub-IFD (pointed to by tag 0x8769) */
const EXIF_IFD_TAG_IDS: Record<string, number> = {
    DateTimeOriginal:  0x9003,
    DateTimeDigitized: 0x9004,
    UserComment:       0x9286,
};

const TAG_EXIF_IFD_POINTER = 0x8769;

// ─── TIFF Block Encoder ───────────────────────────────────────────────────────
// Identical logic to jpeg.ts — PNG's eXIf data is a raw TIFF block with no
// "Exif\0\0" prefix (unlike JPEG's APP1 which prepends that 6-byte identifier).

function encodeTiffBlock(ifd0Tags: Map<number, string>, exifTags: Map<number, string>): Buffer {
    const hasExifIfd = exifTags.size > 0;

    const ifd0Entries = [...ifd0Tags.entries()].sort(([a], [b]) => a - b);
    const exifEntries = [...exifTags.entries()].sort(([a], [b]) => a - b);

    const ifd0Count = ifd0Entries.length + (hasExifIfd ? 1 : 0);
    const exifCount = exifEntries.length;

    const TIFF_HEADER_SIZE = 8;
    const IFD0_SIZE        = 2 + ifd0Count * 12 + 4;
    const EXIF_IFD_SIZE    = hasExifIfd ? (2 + exifCount * 12 + 4) : 0;

    const IFD0_OFFSET     = TIFF_HEADER_SIZE;
    const EXIF_IFD_OFFSET = IFD0_OFFSET + IFD0_SIZE;
    let   valueAreaOffset = EXIF_IFD_OFFSET + EXIF_IFD_SIZE;

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

    // TIFF header
    out.write("II", 0, "ascii");        // little-endian byte order
    out.writeUInt16LE(0x002A, 2);       // TIFF magic: 42
    out.writeUInt32LE(IFD0_OFFSET, 4); // offset to IFD0

    // IFD0
    let pos = IFD0_OFFSET;
    out.writeUInt16LE(ifd0Count, pos); pos += 2;

    for (let i = 0; i < ifd0Entries.length; i++) {
        const [tagId] = ifd0Entries[i]!;
        const { buf, offset } = ifd0Vals[i]!;
        writeIfdEntry(out, pos, tagId, buf, offset);
        pos += 12;
    }

    if (hasExifIfd) {
        out.writeUInt16LE(TAG_EXIF_IFD_POINTER, pos + 0);
        out.writeUInt16LE(4,                    pos + 2); // type: LONG
        out.writeUInt32LE(1,                    pos + 4); // count: 1
        out.writeUInt32LE(EXIF_IFD_OFFSET,      pos + 8);
        pos += 12;
    }

    out.writeUInt32LE(0, pos); pos += 4; // next IFD pointer = 0

    // ExifIFD
    if (hasExifIfd) {
        pos = EXIF_IFD_OFFSET;
        out.writeUInt16LE(exifCount, pos); pos += 2;

        for (let i = 0; i < exifEntries.length; i++) {
            const [tagId] = exifEntries[i]!;
            const { buf, offset } = exifVals[i]!;
            writeIfdEntry(out, pos, tagId, buf, offset);
            pos += 12;
        }

        out.writeUInt32LE(0, pos); // next IFD pointer = 0
    }

    // String value data
    for (const { buf, offset } of [...ifd0Vals, ...exifVals]) {
        if (offset !== -1) buf.copy(out, offset);
    }

    return out;
}

function writeIfdEntry(out: Buffer, pos: number, tagId: number, strBuf: Buffer, offset: number): void {
    out.writeUInt16LE(tagId,         pos + 0); // tag ID
    out.writeUInt16LE(2,             pos + 2); // data type: 2 = ASCII
    out.writeUInt32LE(strBuf.length, pos + 4); // count (includes null terminator)

    if (offset === -1) {
        strBuf.copy(out, pos + 8); // inline value (≤ 4 bytes)
    } else {
        out.writeUInt32LE(offset, pos + 8); // pointer to value area
    }
}

// ─── Existing TIFF Extraction ──────────────────────────────────────────────────

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

// ─── eXIf Chunk Helpers ───────────────────────────────────────────────────────

/** Find the eXIf chunk and return its raw TIFF block, or null. */
function findExistingTiff(chunks: PngChunk[]): Buffer | null {
    for (const chunk of chunks) {
        if (chunk.type === "eXIf") return chunk.data;
    }
    return null;
}

/** Inject (or replace) the eXIf chunk immediately after the IHDR chunk. */
function upsertExifChunk(chunks: PngChunk[], tiffBlock: Buffer): PngChunk[] {
    // Remove any existing eXIf chunks
    const filtered = chunks.filter(c => c.type !== "eXIf");

    // Insert new eXIf chunk after IHDR, before everything else
    const ihdrIdx  = filtered.findIndex(c => c.type === "IHDR");
    const insertAt = ihdrIdx >= 0 ? ihdrIdx + 1 : 1;
    filtered.splice(insertAt, 0, { type: "eXIf", data: tiffBlock });

    return filtered;
}

// ─── Public Functions ──────────────────────────────────────────────────────────

/**
 * Add EXIF fields to a PNG image, preserving any already-existing EXIF fields.
 * Existing tags win — new tags are only added if not already present.
 */
export async function insertPng(input: string, output: string, exif: ExifData): Promise<void> {
    const buf    = await fs.readFile(input);
    const chunks = parsePng(buf);

    const existingTiff = findExistingTiff(chunks);
    const [existingIfd0, existingExif] = existingTiff
        ? readExistingStringTags(existingTiff)
        : [new Map<number, string>(), new Map<number, string>()];

    const [newIfd0, newExif] = flattenExifData(exif);

    // Merge: existing wins over new (insert semantics)
    const mergedIfd0 = new Map([...newIfd0, ...existingIfd0]);
    const mergedExif = new Map([...newExif, ...existingExif]);

    const tiffBlock    = encodeTiffBlock(mergedIfd0, mergedExif);
    const outputChunks = upsertExifChunk(chunks, tiffBlock);

    await fs.writeFile(output, assemblePng(outputChunks));
}

/**
 * Replace specified EXIF fields in a PNG image, preserving unrelated fields.
 * Caller's tags win — they overwrite any existing values for those tags.
 */
export async function updatePng(input: string, output: string, exif: ExifData): Promise<void> {
    const buf    = await fs.readFile(input);
    const chunks = parsePng(buf);

    const existingTiff = findExistingTiff(chunks);
    const [existingIfd0, existingExif] = existingTiff
        ? readExistingStringTags(existingTiff)
        : [new Map<number, string>(), new Map<number, string>()];

    const [newIfd0, newExif] = flattenExifData(exif);

    // Merge: new wins over existing (update semantics)
    const mergedIfd0 = new Map([...existingIfd0, ...newIfd0]);
    const mergedExif = new Map([...existingExif, ...newExif]);

    const tiffBlock    = encodeTiffBlock(mergedIfd0, mergedExif);
    const outputChunks = upsertExifChunk(chunks, tiffBlock);

    await fs.writeFile(output, assemblePng(outputChunks));
}

/**
 * Strip all EXIF metadata from a PNG image.
 * Removes any chunk whose type is "eXIf". All other chunks are preserved.
 */
export async function removePng(input: string, output: string): Promise<void> {
    const buf    = await fs.readFile(input);
    const chunks = parsePng(buf);

    const stripped = chunks.filter(c => c.type !== "eXIf");

    await fs.writeFile(output, assemblePng(stripped));
}
