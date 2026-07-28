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
export function readPngDimensions(buf: Buffer): { width: number; height: number } | null {
    if (buf.length < 24) return null;
    const width  = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return { width, height };
}
