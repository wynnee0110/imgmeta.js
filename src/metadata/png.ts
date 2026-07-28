/**
 * metadata/png.ts — PNG-specific EXIF read/write/remove operations
 *
 * STATUS: Stub — not yet implemented.
 *
 * PNG stores EXIF inside a dedicated chunk of type "eXIf".
 * The binary layout of a PNG chunk is:
 *
 *   4 bytes  — data length (big-endian uint32, does NOT include type or CRC)
 *   4 bytes  — chunk type: "eXIf" (65 58 49 66)
 *   N bytes  — data: a raw TIFF block (same format as a JPEG APP1 TIFF block)
 *   4 bytes  — CRC-32 of (type + data)
 *
 * To implement these functions:
 *   1. Read all PNG chunks by iterating through the file from offset 8 (after the 8-byte PNG signature).
 *   2. For insert/update: find or create the eXIf chunk, encode a TIFF block into it,
 *      compute a fresh CRC-32 over ("eXIf" + tiff data), and write the file back.
 *   3. For remove: drop any chunk whose type is "eXIf" and write the rest back.
 *
 * Reference: http://ftp-osl.osuosl.org/pub/libpng/documents/pngext-1.5.0.html#C.eXIf
 */

import type { ExifData } from "../metadata.js";

/**
 * Add EXIF fields to a PNG image.
 *
 * @throws Always — not yet implemented.
 */
export async function insertPng(
    _input:  string,
    _output: string,
    _exif:   ExifData,
): Promise<void> {
    throw new Error("insert() is not yet supported for PNG images.");
}

/**
 * Replace specified EXIF fields in a PNG image.
 *
 * @throws Always — not yet implemented.
 */
export async function updatePng(
    _input:  string,
    _output: string,
    _exif:   ExifData,
): Promise<void> {
    throw new Error("update() is not yet supported for PNG images.");
}

/**
 * Strip all EXIF metadata from a PNG image.
 *
 * @throws Always — not yet implemented.
 */
export async function removePng(
    _input:  string,
    _output: string,
): Promise<void> {
    throw new Error("remove() is not yet supported for PNG images.");
}
