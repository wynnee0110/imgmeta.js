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
export function readJpegDimensions(buf: Buffer): { width: number; height: number } | null {
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
