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
export function readGifDimensions(buf: Buffer): { width: number; height: number } | null {
    if (buf.length < 10) return null;
    const width  = buf.readUInt16LE(6); // bytes 6–7 after the 6-byte "GIF89a" header
    const height = buf.readUInt16LE(8); // bytes 8–9
    return { width, height };
}
