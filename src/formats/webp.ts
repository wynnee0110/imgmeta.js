/**
 * Read WEBP dimensions. WEBP has three sub-formats, each with different layouts.
 *
 * After the 12-byte RIFF/WEBP header, the chunk type tells us which:
 *
 *   "VP8 " (lossy)   — classic VP8 bitstream
 *   "VP8L" (lossless) — VP8L bitstream with a 1-byte signature + packed fields
 *   "VP8X" (extended) — container with canvas dimensions at fixed offsets
 */
export function readWebpDimensions(buf: Buffer): { width: number; height: number } | null {
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
