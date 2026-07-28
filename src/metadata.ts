/**
 * metadata.ts — Format-aware EXIF metadata router
 *
 * This file is the public entry point for all metadata write operations.
 * It detects the image format from the file's magic bytes and dispatches to
 * the appropriate format-specific handler in the metadata/ directory.
 *
 * ┌─────────────────────────────────────────┐
 * │  Public API (this file)                 │
 * │    insert()  update()  removeMetadata() │
 * └───────────────────┬─────────────────────┘
 *                     │ format detection
 *          ┌──────────┴──────────┐
 *          ▼                     ▼
 *   metadata/jpeg.ts      metadata/png.ts  ← (stub, future)
 *   Full implementation    Not yet implemented
 *
 * To add support for a new image format (e.g. WebP EXIF write):
 *   1. Create src/metadata/<format>.ts
 *   2. Export insert<Format>(), update<Format>(), remove<Format>() from it
 *   3. Add a case for the format in the router functions below
 */

import path from "node:path";
import fs   from "node:fs/promises";

import { insertJpeg, updateJpeg, removeJpeg } from "./metadata/jpeg.js";
import { insertPng,  updatePng,  removePng  } from "./metadata/png.js";

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

// ─── Format Detection ──────────────────────────────────────────────────────────

/** Read the first 12 bytes of a file to determine its format from magic bytes. */
async function detectFormatFromFile(filePath: string): Promise<string | null> {
    const fd  = await fs.open(filePath, "r");
    const buf = Buffer.alloc(12);
    await fd.read(buf, 0, 12, 0);
    await fd.close();

    // JPEG: FF D8
    if (buf[0] === 0xFF && buf[1] === 0xD8) return "jpeg";
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return "png";
    // GIF: 47 49 46 38
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "gif";
    // WebP: 52 49 46 46 ?? ?? ?? ?? 57 45 42 50
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x41 && buf[11] === 0x50) return "webp";
    // BMP: 42 4D
    if (buf[0] === 0x42 && buf[1] === 0x4D) return "bmp";

    return null;
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

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Add EXIF fields to an image, preserving any already-existing EXIF fields.
 *
 * Merge semantics for insert():
 *   • If a tag is already present in the source image, its existing value is kept.
 *   • Tags supplied in `exif` that are NOT already present are added.
 *
 * @param input   Path to the source image.
 * @param output  Path where the result is written. Must differ from `input`.
 * @param exif    Tags to insert.
 * @throws If the format is not supported for write operations.
 */
export async function insert(input: string, output: string, exif: ExifData): Promise<void> {
    assertDistinctPaths(input, output);
    const format = await detectFormatFromFile(input);

    if (format === "jpeg") return insertJpeg(input, output, exif);
    if (format === "png")  return insertPng(input, output, exif);

    throw new Error(
        `insert() is not supported for format: ${format ?? "unknown"}. ` +
        `Supported formats: jpeg.`
    );
}

/**
 * Replace specified EXIF fields in an image, preserving unrelated fields.
 *
 * Merge semantics for update():
 *   • Tags supplied in `exif` OVERWRITE their existing counterparts in the source.
 *   • Existing tags NOT mentioned in `exif` are kept as-is.
 *
 * @param input   Path to the source image.
 * @param output  Path where the result is written. Must differ from `input`.
 * @param exif    Tags to update.
 * @throws If the format is not supported for write operations.
 */
export async function update(input: string, output: string, exif: ExifData): Promise<void> {
    assertDistinctPaths(input, output);
    const format = await detectFormatFromFile(input);

    if (format === "jpeg") return updateJpeg(input, output, exif);
    if (format === "png")  return updatePng(input, output, exif);

    throw new Error(
        `update() is not supported for format: ${format ?? "unknown"}. ` +
        `Supported formats: jpeg.`
    );
}

/**
 * Strip all EXIF metadata from an image.
 *
 * @param input   Path to the source image.
 * @param output  Path where the stripped image is written. Must differ from `input`.
 * @throws If the format is not supported for write operations.
 */
export async function removeMetadata(input: string, output: string): Promise<void> {
    assertDistinctPaths(input, output);
    const format = await detectFormatFromFile(input);

    if (format === "jpeg") return removeJpeg(input, output);
    if (format === "png")  return removePng(input, output);

    throw new Error(
        `remove() is not supported for format: ${format ?? "unknown"}. ` +
        `Supported formats: jpeg.`
    );
}
