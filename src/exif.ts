/**
 * exif.ts — Custom JPEG/EXIF binary parser
 *
 * Parses EXIF metadata from a JPEG image buffer without any third-party libraries.
 * Implements the EXIF 2.3 specification on top of the TIFF 6.0 binary format.
 *
 * How EXIF is stored inside a JPEG file:
 *
 *   JPEG file = sequence of "segments", each starting with a 2-byte marker (FF XX).
 *   EXIF lives inside the APP1 segment (marker FF E1).
 *   APP1 payload layout:
 *     6 bytes  "Exif\0\0"   — identifies this APP1 as EXIF (not XMP, etc.)
 *     N bytes  TIFF block   — the actual metadata in TIFF binary format
 *
 *   TIFF block layout:
 *     2 bytes  byte order   "II" (Intel, little-endian) or "MM" (Motorola, big-endian)
 *     2 bytes  magic        0x002A (= 42)
 *     4 bytes  IFD0 offset  byte offset from start of TIFF block to the first IFD
 *     ...      IFDs         each is a list of 12-byte tag entries
 */

// ─── EXIF Tag IDs ─────────────────────────────────────────────────────────────
// These are the official numeric IDs assigned to EXIF/TIFF tags in the spec.
// Full list: https://www.exif.org/Exif2-2.PDF (Appendix A)

// IFD0 — main image metadata
const TAG_MAKE        = 0x010F; // Camera manufacturer name, ASCII
const TAG_MODEL       = 0x0110; // Camera model name, ASCII
const TAG_ORIENTATION = 0x0112; // Image rotation (1–8; 1 = normal, 3 = 180°, 6 = 90° CW, …)
const TAG_EXIF_IFD   = 0x8769; // Byte offset to the Exif Sub-IFD (LONG)
const TAG_GPS_IFD    = 0x8825; // Byte offset to the GPS Sub-IFD (LONG)

// Exif Sub-IFD — photography details (pointed to by TAG_EXIF_IFD)
const TAG_EXPOSURE_TIME  = 0x829A; // Shutter speed in seconds (RATIONAL, e.g. 1/500)
const TAG_F_NUMBER       = 0x829D; // Aperture f-number (RATIONAL, e.g. 2.8)
const TAG_ISO            = 0x8827; // ISO sensitivity (SHORT, e.g. 800)
const TAG_DATE_ORIGINAL  = 0x9003; // Date/time photo was captured (ASCII "YYYY:MM:DD HH:MM:SS")
const TAG_DATE_DIGITIZED = 0x9004; // Date/time image was digitised (ASCII)
const TAG_FOCAL_LENGTH   = 0x920A; // Focal length in mm (RATIONAL)

// GPS Sub-IFD (pointed to by TAG_GPS_IFD)
const GPS_LATITUDE_REF  = 0x0001; // "N" or "S" (ASCII, 2 bytes including null)
const GPS_LATITUDE      = 0x0002; // [degrees, minutes, seconds] each RATIONAL
const GPS_LONGITUDE_REF = 0x0003; // "E" or "W" (ASCII)
const GPS_LONGITUDE     = 0x0004; // [degrees, minutes, seconds] each RATIONAL
const GPS_ALTITUDE_REF  = 0x0005; // 0 = above sea level, 1 = below (BYTE)
const GPS_ALTITUDE      = 0x0006; // Altitude in metres above/below sea level (RATIONAL)

// ─── EXIF Data Type Codes ─────────────────────────────────────────────────────
// Each IFD entry declares the type of its data using one of these codes.
// The type determines how many bytes each "value" occupies.

const TYPE_BYTE      = 1;  // 1 byte, unsigned
const TYPE_ASCII     = 2;  // 1 byte per character, null-terminated
const TYPE_SHORT     = 3;  // 2 bytes, unsigned (big- or little-endian per byte order)
const TYPE_LONG      = 4;  // 4 bytes, unsigned
const TYPE_RATIONAL  = 5;  // 8 bytes: two LONG values (numerator, denominator)
const TYPE_SBYTE     = 6;  // 1 byte, signed   (unused here, included for completeness)
const TYPE_UNDEFINED = 7;  // 1 byte, meaning depends on the tag
const TYPE_SSHORT    = 8;  // 2 bytes, signed
const TYPE_SLONG     = 9;  // 4 bytes, signed
const TYPE_SRATIONAL = 10; // 8 bytes: two SLONG values (signed rational)
const TYPE_FLOAT     = 11; // 4 bytes, IEEE 754 single precision (uncommon in EXIF)
const TYPE_DOUBLE    = 12; // 8 bytes, IEEE 754 double precision (uncommon in EXIF)

// Byte size of a single value for each data type
const TYPE_SIZES: Record<number, number> = {
    [TYPE_BYTE]:      1,
    [TYPE_ASCII]:     1,
    [TYPE_SHORT]:     2,
    [TYPE_LONG]:      4,
    [TYPE_RATIONAL]:  8,
    [TYPE_SBYTE]:     1,
    [TYPE_UNDEFINED]: 1,
    [TYPE_SSHORT]:    2,
    [TYPE_SLONG]:     4,
    [TYPE_SRATIONAL]: 8,
    [TYPE_FLOAT]:     4,
    [TYPE_DOUBLE]:    8,
};

// ─── Public Result Types ───────────────────────────────────────────────────────

/** GPS coordinates decoded from EXIF GPS Sub-IFD. */
export interface GpsCoordinates {
    /** Decimal degrees. Negative = South. */
    latitude: number;
    /** Decimal degrees. Negative = West. */
    longitude: number;
    /** Metres above sea level. Negative = below sea level. Optional. */
    altitude?: number;
}

/** All decoded EXIF fields returned by parseExif(). */
export interface ExifResult {
    make?:         string;          // Camera manufacturer, e.g. "Canon"
    model?:        string;          // Camera model, e.g. "EOS R5"
    orientation?:  number;          // EXIF orientation code (1–8)
    dateTaken?:    Date;            // When the shutter was pressed
    dateDigi?:     Date;            // When the image was digitised
    exposureTime?: number;          // Shutter speed in seconds, e.g. 0.002 = 1/500s
    fNumber?:      number;          // Aperture, e.g. 2.8
    iso?:          number;          // ISO sensitivity, e.g. 400
    focalLength?:  number;          // Focal length in mm
    gps?:          GpsCoordinates;
    /**
     * Raw decoded tag values for every tag we encountered.
     * Keyed by the numeric TIFF tag ID. Useful for accessing tags this
     * library does not explicitly decode (see the EXIF spec for IDs).
     */
    raw: Record<number, unknown>;
}

// ─── Low-level Buffer Readers ──────────────────────────────────────────────────
// All TIFF data uses either little-endian ("II") or big-endian ("MM") byte order.
// We pass a boolean `le` (littleEndian) throughout to choose the correct read method.

/** Read a 16-bit unsigned integer respecting the TIFF byte order. */
function readU16(buf: Buffer, offset: number, le: boolean): number {
    return le ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset);
}

/** Read a 32-bit unsigned integer respecting the TIFF byte order. */
function readU32(buf: Buffer, offset: number, le: boolean): number {
    return le ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);
}

/** Read a 32-bit signed integer respecting the TIFF byte order. */
function readI32(buf: Buffer, offset: number, le: boolean): number {
    return le ? buf.readInt32LE(offset) : buf.readInt32BE(offset);
}

// ─── IFD Entry Value Decoder ───────────────────────────────────────────────────

/**
 * Decode the value stored in one 12-byte IFD entry.
 *
 * A TIFF IFD entry is always exactly 12 bytes:
 *
 *   Bytes  Size  Meaning
 *   ─────  ────  ────────────────────────────────────────────────────────────
 *   0–1    2     Tag ID
 *   2–3    2     Data type (see TYPE_* constants above)
 *   4–7    4     Count — number of values of the given type
 *   8–11   4     Value OR offset:
 *                  • If count × typeSize ≤ 4: the value(s) are stored directly
 *                    in bytes 8–11, left-aligned, remaining bytes zero-padded.
 *                  • Otherwise: bytes 8–11 are a LONG offset (from the start of
 *                    the TIFF block) pointing to where the value data lives.
 *
 * @param tiff   The full TIFF block (from "II"/"MM" to end of APP1)
 * @param entry  A 12-byte slice already positioned at the IFD entry
 * @param le     Whether the TIFF block uses little-endian byte order
 */
function decodeIfdValue(tiff: Buffer, entry: Buffer, le: boolean): unknown {
    const type      = readU16(entry, 2, le);
    const count     = readU32(entry, 4, le);
    const typeSize  = TYPE_SIZES[type] ?? 1;
    const totalSize = count * typeSize;

    // Determine whether the value is inline or offset-referenced
    let valueBuf: Buffer;
    if (totalSize <= 4) {
        // Value fits in the 4-byte inline field (bytes 8–11 of the entry)
        valueBuf = entry.subarray(8);
    } else {
        // The 4-byte field holds an offset into the TIFF block
        const offset = readU32(entry, 8, le);
        if (offset + totalSize > tiff.length) return null; // guard against bad offsets
        valueBuf = tiff.subarray(offset);
    }

    // Decode based on type
    switch (type) {
        case TYPE_ASCII: {
            // ASCII strings are null-terminated; strip trailing nulls/whitespace
            return valueBuf.subarray(0, count).toString("ascii").replace(/\0+$/, "").trim();
        }

        case TYPE_BYTE:
        case TYPE_SBYTE:
        case TYPE_UNDEFINED: {
            // Return as an array of raw byte values
            return Array.from(valueBuf.subarray(0, count));
        }

        case TYPE_SHORT: {
            const vals: number[] = [];
            for (let i = 0; i < count; i++) vals.push(readU16(valueBuf, i * 2, le));
            return count === 1 ? vals[0] : vals; // unwrap single values
        }

        case TYPE_LONG: {
            const vals: number[] = [];
            for (let i = 0; i < count; i++) vals.push(readU32(valueBuf, i * 4, le));
            return count === 1 ? vals[0] : vals;
        }

        case TYPE_RATIONAL: {
            // RATIONAL = two unsigned 32-bit integers (numerator / denominator)
            // Example: focal length 50mm = [50, 1], exposure 1/500s = [1, 500]
            const vals: number[] = [];
            for (let i = 0; i < count; i++) {
                const num = readU32(valueBuf, i * 8,     le);
                const den = readU32(valueBuf, i * 8 + 4, le);
                vals.push(den === 0 ? 0 : num / den);
            }
            return count === 1 ? vals[0] : vals;
        }

        case TYPE_SRATIONAL: {
            // SRATIONAL = two signed 32-bit integers (numerator / denominator)
            const vals: number[] = [];
            for (let i = 0; i < count; i++) {
                const num = readI32(valueBuf, i * 8,     le);
                const den = readI32(valueBuf, i * 8 + 4, le);
                vals.push(den === 0 ? 0 : num / den);
            }
            return count === 1 ? vals[0] : vals;
        }

        case TYPE_SLONG: {
            const vals: number[] = [];
            for (let i = 0; i < count; i++) vals.push(readI32(valueBuf, i * 4, le));
            return count === 1 ? vals[0] : vals;
        }

        default:
            // Unknown type — return raw bytes (up to 64 for safety)
            return Array.from(valueBuf.subarray(0, Math.min(totalSize, 64)));
    }
}

// ─── IFD Walker ───────────────────────────────────────────────────────────────

/**
 * Walk an IFD (Image File Directory) and return all tag values as a Map.
 *
 * IFD layout (all byte offsets measured from the start of the TIFF block):
 *
 *   2 bytes   entry count N
 *   12×N bytes IFD entries (sorted by tag ID, ascending)
 *   4 bytes   offset to next IFD (0 = no next IFD in this chain)
 *
 * @param tiff      The full TIFF block buffer
 * @param ifdOffset Byte offset within `tiff` where this IFD begins
 * @param le        Whether byte order is little-endian
 */
function walkIfd(tiff: Buffer, ifdOffset: number, le: boolean): Map<number, unknown> {
    const tags = new Map<number, unknown>();

    // Bounds check: we need at least 2 bytes for the entry count
    if (ifdOffset + 2 > tiff.length) return tags;

    const entryCount = readU16(tiff, ifdOffset, le);
    // Entries start immediately after the 2-byte count field
    const entriesStart = ifdOffset + 2;

    for (let i = 0; i < entryCount; i++) {
        const entryStart = entriesStart + i * 12; // each entry is exactly 12 bytes
        if (entryStart + 12 > tiff.length) break; // truncated IFD — stop

        const entry = tiff.subarray(entryStart, entryStart + 12);
        const tagId = readU16(entry, 0, le);
        const value = decodeIfdValue(tiff, entry, le);
        tags.set(tagId, value);
    }

    return tags;
}

// ─── Helper: GPS Decimal Degrees ──────────────────────────────────────────────

/**
 * Convert GPS [degrees, minutes, seconds] rational values to decimal degrees.
 *
 * EXIF stores GPS coordinates as an array of three RATIONAL values:
 *   [degrees, minutes, seconds]
 *   e.g. 51°30′26.4″N = [51, 30, 26.4]
 *
 * The decimal degree formula is:
 *   decimal = degrees + minutes / 60 + seconds / 3600
 *
 * South latitude and West longitude are represented as negative decimals.
 *
 * @param vals  Array of exactly three numbers [deg, min, sec]
 * @param ref   Hemisphere reference: "N" | "S" for lat, "E" | "W" for lon
 */
function gpsToDecimal(vals: number[], ref: string): number {
    if (vals.length < 3) return 0;
    const [deg, min, sec] = vals;
    const decimal = deg + min / 60 + sec / 3600;
    return (ref === "S" || ref === "W") ? -decimal : decimal;
}

// ─── Helper: EXIF Date String → JS Date ──────────────────────────────────────

/**
 * Parse an EXIF date/time string into a JavaScript Date.
 *
 * EXIF dates use the format: "YYYY:MM:DD HH:MM:SS"
 * Note the colons in the date part — this differs from ISO 8601 ("YYYY-MM-DD"),
 * which is what JavaScript's Date constructor expects.
 *
 * @param str  EXIF date string, e.g. "2024:06:15 14:30:00"
 * @returns    A Date object, or undefined if the string is malformed
 */
function parseExifDate(str: string): Date | undefined {
    // Strict match: exactly "YYYY:MM:DD HH:MM:SS"
    const m = str.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
    if (!m) return undefined;
    const [, y, mo, d, h, mi, s] = m;
    // Reformat as ISO 8601 "YYYY-MM-DDTHH:MM:SS" which Date can parse correctly
    return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`);
}

// ─── Main Parser ──────────────────────────────────────────────────────────────

/**
 * Parse EXIF metadata from a JPEG image file buffer.
 *
 * Steps:
 *   1. Verify the buffer starts with the JPEG SOI marker (FF D8 FF)
 *   2. Scan JPEG segments looking for the APP1 marker (FF E1)
 *   3. Within APP1, verify the "Exif\\0\\0" header
 *   4. Parse the embedded TIFF structure:
 *        a. Read byte order ("II" or "MM") and validate magic 0x2A
 *        b. Walk IFD0 → collect all main-image tags
 *        c. Walk ExifIFD → collect photography-specific tags
 *        d. Walk GPS IFD → collect GPS tags
 *   5. Decode known tags into a structured ExifResult object
 *
 * @param buffer  Raw bytes of a JPEG image file
 * @returns       Decoded EXIF data, or null if no EXIF found or buffer is invalid
 */
export function parseExif(buffer: Buffer): ExifResult | null {
    try {

        // ── 1. Validate JPEG magic ─────────────────────────────────────────────
        // Every JPEG starts with FF D8 (SOI) and the very next byte must be FF
        // (the start of the first real segment marker).
        if (buffer.length < 3 || buffer[0] !== 0xFF || buffer[1] !== 0xD8 || buffer[2] !== 0xFF) {
            return null; // not a JPEG
        }

        // ── 2. Scan for the APP1 segment (FF E1) ──────────────────────────────
        // A JPEG is a chain of segments. Each segment:
        //   2 bytes  FF <marker>
        //   2 bytes  segment length L  (big-endian, includes these 2 length bytes)
        //   L-2 bytes payload
        //
        // We start scanning at byte 2 (right after the SOI marker FF D8).
        let offset = 2;
        let app1Payload: Buffer | null = null;

        while (offset + 4 <= buffer.length) {
            if (buffer[offset] !== 0xFF) break; // lost segment sync

            const marker = buffer[offset + 1];

            // SOI (D8) and EOI (D9) have no length field — step over them
            if (marker === 0xD8 || marker === 0xD9) { offset += 2; continue; }

            // SOS (DA) = Start of Scan — compressed pixel data follows, no more metadata
            if (marker === 0xDA) break;

            // Standard segment: read the 2-byte length field
            const segLen      = buffer.readUInt16BE(offset + 2); // includes 2 length bytes
            const payloadStart = offset + 4;                     // payload starts after length
            const nextOffset   = offset + 2 + segLen;            // offset of next segment

            if (marker === 0xE1) {
                // APP1 — check for EXIF identifier: "Exif" followed by two null bytes
                // (0x45 0x78 0x69 0x66 0x00 0x00)
                if (payloadStart + 6 <= buffer.length) {
                    const id = buffer.subarray(payloadStart, payloadStart + 6).toString("ascii");
                    if (id === "Exif\0\0") {
                        // Found it. The TIFF block starts 6 bytes into the APP1 payload.
                        app1Payload = buffer.subarray(payloadStart + 6, nextOffset);
                        break;
                    }
                }
            }

            offset = nextOffset; // advance to next segment
        }

        if (!app1Payload || app1Payload.length < 8) return null;

        // ── 3. Parse TIFF header ───────────────────────────────────────────────
        // The TIFF block always starts with an 8-byte header:
        //   bytes 0–1  byte order: "II" (0x4949) = little-endian,
        //                          "MM" (0x4D4D) = big-endian
        //   bytes 2–3  TIFF magic number: must be 0x002A (42)
        //   bytes 4–7  offset (from start of TIFF block) to IFD0
        const tiff = app1Payload;
        const byteOrderMark = tiff.subarray(0, 2).toString("ascii");

        if (byteOrderMark !== "II" && byteOrderMark !== "MM") return null;
        const le = byteOrderMark === "II"; // true = Intel (little-endian)

        const magic = readU16(tiff, 2, le);
        if (magic !== 0x002A) return null; // not a valid TIFF block

        const ifd0Offset = readU32(tiff, 4, le);

        // ── 4a. Walk IFD0 ─────────────────────────────────────────────────────
        const ifd0 = walkIfd(tiff, ifd0Offset, le);

        // ── 4b. Walk Exif Sub-IFD ─────────────────────────────────────────────
        // IFD0 may contain tag 0x8769 whose value is a LONG offset to the ExifIFD.
        // ExifIFD holds photography details like exposure, ISO, focal length, etc.
        let exifIfd = new Map<number, unknown>();
        if (ifd0.has(TAG_EXIF_IFD)) {
            const exifOffset = ifd0.get(TAG_EXIF_IFD) as number;
            exifIfd = walkIfd(tiff, exifOffset, le);
        }

        // ── 4c. Walk GPS Sub-IFD ──────────────────────────────────────────────
        // IFD0 may contain tag 0x8825 whose value is a LONG offset to the GPS IFD.
        let gpsIfd = new Map<number, unknown>();
        if (ifd0.has(TAG_GPS_IFD)) {
            const gpsOffset = ifd0.get(TAG_GPS_IFD) as number;
            gpsIfd = walkIfd(tiff, gpsOffset, le);
        }

        // ── 5. Build the structured result ────────────────────────────────────
        // Collect all raw tag/value pairs (for the `.raw` field)
        const raw: Record<number, unknown> = {};
        for (const [k, v] of ifd0)    raw[k] = v;
        for (const [k, v] of exifIfd) raw[k] = v;
        for (const [k, v] of gpsIfd)  raw[k] = v;

        const result: ExifResult = { raw };

        // Camera identity (from IFD0)
        if (ifd0.has(TAG_MAKE))  result.make  = ifd0.get(TAG_MAKE)  as string;
        if (ifd0.has(TAG_MODEL)) result.model = ifd0.get(TAG_MODEL) as string;

        // Orientation (from IFD0) — numeric code 1–8 defined in EXIF spec
        if (ifd0.has(TAG_ORIENTATION)) {
            result.orientation = ifd0.get(TAG_ORIENTATION) as number;
        }

        // Date photo was taken (from ExifIFD)
        if (exifIfd.has(TAG_DATE_ORIGINAL)) {
            result.dateTaken = parseExifDate(exifIfd.get(TAG_DATE_ORIGINAL) as string);
        }
        if (exifIfd.has(TAG_DATE_DIGITIZED)) {
            result.dateDigi = parseExifDate(exifIfd.get(TAG_DATE_DIGITIZED) as string);
        }

        // Photography exposure details (from ExifIFD)
        if (exifIfd.has(TAG_EXPOSURE_TIME)) result.exposureTime = exifIfd.get(TAG_EXPOSURE_TIME) as number;
        if (exifIfd.has(TAG_F_NUMBER))      result.fNumber      = exifIfd.get(TAG_F_NUMBER)      as number;
        if (exifIfd.has(TAG_ISO))           result.iso          = exifIfd.get(TAG_ISO)            as number;
        if (exifIfd.has(TAG_FOCAL_LENGTH))  result.focalLength  = exifIfd.get(TAG_FOCAL_LENGTH)   as number;

        // GPS coordinates (from GPS Sub-IFD)
        if (gpsIfd.has(GPS_LATITUDE) && gpsIfd.has(GPS_LONGITUDE)) {
            const latVals = gpsIfd.get(GPS_LATITUDE)  as number[];
            const lonVals = gpsIfd.get(GPS_LONGITUDE) as number[];
            const latRef  = (gpsIfd.get(GPS_LATITUDE_REF)  as string | undefined) ?? "N";
            const lonRef  = (gpsIfd.get(GPS_LONGITUDE_REF) as string | undefined) ?? "E";

            const gps: GpsCoordinates = {
                latitude:  gpsToDecimal(latVals, latRef),
                longitude: gpsToDecimal(lonVals, lonRef),
            };

            if (gpsIfd.has(GPS_ALTITUDE)) {
                const alt    = gpsIfd.get(GPS_ALTITUDE)     as number;
                const altRef = gpsIfd.get(GPS_ALTITUDE_REF) as number[] | undefined;
                // altRef[0] === 1 means the altitude is below sea level → negate
                gps.altitude = (Array.isArray(altRef) && altRef[0] === 1) ? -alt : alt;
            }

            result.gps = gps;
        }

        return result;

    } catch {
        // Any parse error (malformed buffer, out-of-bounds read, etc.) → return null
        return null;
    }
}