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
import { parseExif, parsePngExif } from "./exif.js";
import type { ExifResult } from "./exif.js";

// Import modular format-specific dimension readers
import { readJpegDimensions } from "./formats/jpeg.js";
import { readPngDimensions }  from "./formats/png.js";
import { readGifDimensions }  from "./formats/gif.js";
import { readWebpDimensions } from "./formats/webp.js";
import { readBmpDimensions }  from "./formats/bmp.js";

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

interface Dimensions { width: number; height: number; }

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
 *   2. Width/Height — read by a format-specific parser (imported from formats/ directory).
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
    }

    // ── 3. Parse EXIF ──────────────────────────────────────────────────────────
    // EXIF is most commonly found in JPEG files (APP1 segment).
    // PNG can carry EXIF in an "eXIf" chunk — parsePngExif handles that.
    let exif: ExifResult | null = null;
    if (format === "jpeg") exif = parseExif(buf);
    if (format === "png")  exif = parsePngExif(buf);

    return {
        format,
        width:  dims?.width,
        height: dims?.height,
        exif,
    };
}
