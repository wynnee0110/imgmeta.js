/**
 * Image.ts — Custom image reader
 *
 * Opens an image file and extracts:
 *   • Format   — detected from the file's magic bytes (no extension guessing)
 *   • Width    — in pixels
 *   • Height   — in pixels
 *   • EXIF     — parsed metadata (JPEG only; see exif.ts)
 *
 * Supports: JPEG, PNG, GIF, WEBP, BMP, TIFF
 * No third-party libraries are used — only Node.js built-in fs and Buffer.
 */

import fs from "node:fs/promises";
import { parseExif }       from "./exif.js";
import type { ExifResult } from "./exif.js";

// ─── Format Detection ──────────────────────────────────────────────────────────
// Every image format begins with a unique sequence of "magic bytes".
// Reading the first 12 bytes of a file is enough to identify any common format.
// This is far more reliable than using file extensions, which can be wrong.

/**
 * Identify the image format from the file's opening bytes.
 *
 * Magic byte signatures:
 *
 *   JPEG   FF D8 FF
 *   PNG    89 50 4E 47 0D 0A 1A 0A          ("\x89PNG\r\n\x1a\n")
 *   GIF    47 49 46 38 xx xx               ("GIF8..." — "7a" or "9a" follows)
 *   WEBP   52 49 46 46 xx xx xx xx 57 45 42 50 ("RIFF....WEBP")
 *   BMP    42 4D                           ("BM")
 *   TIFF   49 49 2A 00  or  4D 4D 00 2A   ("II*\0" or "MM\0*")
 *
 * @param buf  File buffer. Only the first 12 bytes are examined.
 * @returns    Lowercase format string, or null if unrecognised.
 */
function detectFormat(buf: Buffer): string | null {

    // JPEG — starts with FF D8 FF
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
        return "jpeg";
    }

    // PNG — the 8-byte signature is: 89 50 4E 47 0D 0A 1A 0A
    // Bytes 1–3 are "PNG" in ASCII (50 4E 47).
    // The leading 0x89 is a non-ASCII byte to catch systems that strip high bits.
    // 0x0D 0x0A is a CRLF pair; 0x1A is a DOS EOF marker; 0x0A is a Unix LF.
    // These were chosen to detect common file corruption early.
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
        buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) {
        return "png";
    }

    // GIF — starts with "GIF8" followed by "7a" (GIF87a) or "9a" (GIF89a)
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
        return "gif";
    }

    // WEBP — uses the RIFF container format.
    // Bytes 0–3 = "RIFF" (52 49 46 46)
    // Bytes 4–7 = file size (little-endian DWORD) — varies, so we skip them
    // Bytes 8–11 = "WEBP" (57 45 42 50)
    if (buf[0]  === 0x52 && buf[1]  === 0x49 && buf[2]  === 0x46 && buf[3]  === 0x46 &&
        buf[8]  === 0x57 && buf[9]  === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
        return "webp";
    }

    // BMP — starts with "BM" (42 4D)
    if (buf[0] === 0x42 && buf[1] === 0x4D) {
        return "bmp";
    }

    // TIFF — two variants of byte order:
    //   "II" little-endian: 49 49 2A 00
    //   "MM" big-endian:    4D 4D 00 2A
    if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2A && buf[3] === 0x00) ||
        (buf[0] === 0x4D && buf[1] === 0x4D && buf[2] === 0x00 && buf[3] === 0x2A)) {
        return "tiff";
    }

    return null; // unrecognised
}

// ─── Dimension Readers ─────────────────────────────────────────────────────────
// Each image format stores its width and height in a different location and
// encoding within the file. We implement a small reader for each format.

interface Dimensions { width: number; height: number; }

/**
 * Read JPEG dimensions by scanning for an SOF (Start of Frame) marker.
 *
 * SOF markers embed the image dimensions directly in the JPEG bitstream.
 * There are several SOF marker types, each for a different encoding mode:
 *
 *   FF C0  SOF0  Baseline DCT       (most common — standard JPEG)
 *   FF C1  SOF1  Extended Sequential DCT
 *   FF C2  SOF2  Progressive DCT    (used by some web images)
 *   FF C3  SOF3  Lossless
 *   FF C5–C7, C9–CB, CD–CF  other SOF variants (less common)
 *
 * SOF segment layout (after the 2-byte FF Cx marker):
 *   2 bytes  length        (big-endian, includes these 2 bytes)
 *   1 byte   precision     (bits per sample, usually 8)
 *   2 bytes  height        (big-endian, in pixels)
 *   2 bytes  width         (big-endian, in pixels)
 *   1 byte   # components  (1 = grayscale, 3 = YCbCr colour)
 */
function readJpegDimensions(buf: Buffer): Dimensions | null {
    // All SOF second-marker bytes (the XX in FF Cx)
    const sofMarkers = new Set([
        0xC0, 0xC1, 0xC2, 0xC3,
        0xC5, 0xC6, 0xC7,
        0xC9, 0xCA, 0xCB,
        0xCD, 0xCE, 0xCF,
    ]);

    let offset = 2; // skip the SOI marker (FF D8) at the start

    while (offset + 4 <= buf.length) {
        if (buf[offset] !== 0xFF) break; // lost segment sync

        const marker = buf[offset + 1];

        // SOI and EOI: no length field — step over
        if (marker === 0xD8 || marker === 0xD9) { offset += 2; continue; }
        // SOS (Start of Scan): pixel data begins — no SOF after this
        if (marker === 0xDA) break;

        // Standard segment: read 2-byte length (includes the 2 length bytes)
        const segLen = buf.readUInt16BE(offset + 2);

        if (sofMarkers.has(marker)) {
            // SOF found!
            // Within the SOF segment (starting at offset):
            //   offset+0 : FF
            //   offset+1 : Cx  (SOF marker type)
            //   offset+2 : length high byte
            //   offset+3 : length low byte
            //   offset+4 : precision (1 byte) — skip
            //   offset+5 : height high byte ┐ big-endian
            //   offset+6 : height low byte  ┘
            //   offset+7 : width  high byte ┐ big-endian
            //   offset+8 : width  low byte  ┘
            if (offset + 9 > buf.length) break;
            const height = buf.readUInt16BE(offset + 5);
            const width  = buf.readUInt16BE(offset + 7);
            return { width, height };
        }

        offset += 2 + segLen; // advance to the next segment
    }

    return null; // no SOF found (malformed JPEG)
}

/**
 * Read PNG dimensions from its IHDR chunk.
 *
 * PNG file structure:
 *   8 bytes  PNG signature (89 50 4E 47 0D 0A 1A 0A)
 *   Then chunks, each:
 *     4 bytes  data length (big-endian, NOT including type and CRC)
 *     4 bytes  chunk type  (ASCII, e.g. "IHDR", "IDAT", "IEND")
 *     N bytes  data
 *     4 bytes  CRC-32 checksum
 *
 * The IHDR chunk is always the first chunk after the signature and contains:
 *   4 bytes  width   (big-endian, pixels)
 *   4 bytes  height  (big-endian, pixels)
 *   1 byte   bit depth
 *   1 byte   colour type
 *   ... more fields
 *
 * IHDR data starts at byte 16:
 *   sig(8) + IHDR_length(4) + IHDR_type(4) = 16
 */
function readPngDimensions(buf: Buffer): Dimensions | null {
    if (buf.length < 24) return null;
    const width  = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return { width, height };
}

/**
 * Read GIF dimensions from the Logical Screen Descriptor.
 *
 * GIF file structure:
 *   6 bytes  Header ("GIF87a" or "GIF89a")
 *   Logical Screen Descriptor:
 *     2 bytes  canvas width   (little-endian)
 *     2 bytes  canvas height  (little-endian)
 *     ...
 *
 * Note: GIF uses little-endian byte order (uncommon among image formats).
 */
function readGifDimensions(buf: Buffer): Dimensions | null {
    if (buf.length < 10) return null;
    const width  = buf.readUInt16LE(6); // bytes 6–7 after the 6-byte "GIF89a" header
    const height = buf.readUInt16LE(8); // bytes 8–9
    return { width, height };
}

/**
 * Read WEBP dimensions. WEBP has three sub-formats, each with different layouts.
 *
 * After the 12-byte RIFF/WEBP header, the chunk type tells us which:
 *
 *   "VP8 " (lossy)   — classic VP8 bitstream
 *   "VP8L" (lossless) — VP8L bitstream with a 1-byte signature + packed fields
 *   "VP8X" (extended) — container with canvas dimensions at fixed offsets
 */
function readWebpDimensions(buf: Buffer): Dimensions | null {
    if (buf.length < 30) return null;

    // Chunk type is the 4 ASCII bytes starting at offset 12
    const chunk = buf.subarray(12, 16).toString("ascii");

    if (chunk === "VP8 ") {
        // Lossy VP8 bitstream.
        // The VP8 chunk data starts at offset 20 (12 RIFF header + 4 chunk type + 4 chunk size).
        // At offsets 26–27 and 28–29 within the file are the display width and height,
        // each packed as a 14-bit unsigned integer in the lower bits of a 16-bit LE word.
        // The upper 2 bits are a horizontal/vertical scale factor.
        const width  = buf.readUInt16LE(26) & 0x3FFF; // mask off the 2 scale bits
        const height = buf.readUInt16LE(28) & 0x3FFF;
        return { width, height };
    }

    if (chunk === "VP8L") {
        // Lossless VP8L.
        // At offset 20 there must be the VP8L signature byte: 0x2F.
        // Then 4 bytes encode width-1 (14 bits) and height-1 (14 bits), packed together.
        if (buf[20] !== 0x2F) return null;
        // Read the 4 bytes as a 32-bit little-endian integer
        const packed = buf.readUInt32LE(21);
        // Lower 14 bits = (width  - 1)
        // Next  14 bits = (height - 1)
        const width  = (packed & 0x3FFF) + 1;
        const height = ((packed >> 14) & 0x3FFF) + 1;
        return { width, height };
    }

    if (chunk === "VP8X") {
        // Extended WEBP container.
        // Canvas width  - 1: 24-bit LE at offset 24
        // Canvas height - 1: 24-bit LE at offset 27
        const width  = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1;
        const height = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1;
        return { width, height };
    }

    return null; // unknown WEBP sub-format
}

/**
 * Read BMP dimensions from the DIB (Device Independent Bitmap) header.
 *
 * BMP file structure:
 *   14 bytes  BITMAPFILEHEADER
 *     2 bytes  signature "BM"
 *     4 bytes  file size
 *     4 bytes  reserved
 *     4 bytes  pixel data offset
 *   Then the DIB header (one of several formats; BITMAPINFOHEADER is most common):
 *     4 bytes  header size
 *     4 bytes  width   (signed 32-bit, little-endian)
 *     4 bytes  height  (signed 32-bit, little-endian)
 *              — a negative height means the bitmap is stored top-down,
 *                which is unusual but valid. We take the absolute value.
 */
function readBmpDimensions(buf: Buffer): Dimensions | null {
    if (buf.length < 26) return null;
    const width  = buf.readInt32LE(18);
    const height = Math.abs(buf.readInt32LE(22)); // height can be negative (top-down BMP)
    return { width, height };
}

// ─── Public API ────────────────────────────────────────────────────────────────

/** Result returned by openImage(). */
export interface ImageInfo {
    /** Detected format: "jpeg" | "png" | "gif" | "webp" | "bmp" | "tiff" | null */
    format:  string | null;
    /** Image width in pixels. undefined if the format is unrecognised. */
    width:   number | undefined;
    /** Image height in pixels. undefined if the format is unrecognised. */
    height:  number | undefined;
    /** Parsed EXIF metadata. null if the image has no EXIF or EXIF parsing failed. */
    exif:    ExifResult | null;
}

/**
 * Read an image file from disk and return its format, dimensions, and EXIF data.
 *
 * All three properties (format, dimensions, EXIF) are determined independently:
 *
 *   1. Format   — detected from the first 12 bytes (magic bytes), NOT the extension.
 *   2. Width/Height — read by a format-specific parser (see the readers above).
 *   3. EXIF     — parsed from the JPEG APP1 segment by the custom parser in exif.ts.
 *                 Other formats (PNG, GIF, etc.) return null for EXIF.
 *
 * @param filePath  Absolute or relative path to the image file.
 */
export async function openImage(filePath: string): Promise<ImageInfo> {
    // Read the entire file into memory as a raw Buffer.
    // For large images this is straightforward since we need random access to the bytes.
    const buf = await fs.readFile(filePath);

    // ── 1. Detect format ───────────────────────────────────────────────────────
    const format = detectFormat(buf);

    // ── 2. Read dimensions ─────────────────────────────────────────────────────
    // Each format hides its dimensions in a different place in the file.
    let dims: Dimensions | null = null;
    switch (format) {
        case "jpeg": dims = readJpegDimensions(buf); break;
        case "png":  dims = readPngDimensions(buf);  break;
        case "gif":  dims = readGifDimensions(buf);  break;
        case "webp": dims = readWebpDimensions(buf); break;
        case "bmp":  dims = readBmpDimensions(buf);  break;
        // TIFF dimensions can also be read via a TIFF IFD walk, but since EXIF
        // is already TIFF-based, you could reuse the IFD walker from exif.ts.
        // Left as a future exercise.
    }

    // ── 3. Parse EXIF ──────────────────────────────────────────────────────────
    // EXIF is most commonly found in JPEG files (in the APP1 segment).
    // PNG can technically carry EXIF in an "eXIf" chunk, but that is uncommon
    // and not yet implemented here.
    const exif = (format === "jpeg") ? parseExif(buf) : null;

    return {
        format,
        width:  dims?.width,
        height: dims?.height,
        exif,
    };
}
