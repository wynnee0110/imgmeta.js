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
export function readBmpDimensions(buf: Buffer): { width: number; height: number } | null {
    if (buf.length < 26) return null;
    const width  = buf.readInt32LE(18);
    const height = Math.abs(buf.readInt32LE(22)); // height can be negative (top-down BMP)
    return { width, height };
}
