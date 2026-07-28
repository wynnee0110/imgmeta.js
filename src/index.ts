/**
 * index.ts — Public entry point for the imgmeta library.
 *
 * Re-exports everything a consumer needs:
 *   read()           — open an image and return its format, dimensions, and EXIF
 *   insert()         — add EXIF tags while preserving existing ones
 *   update()         — overwrite specific EXIF tags while preserving others
 *   remove()         — strip all EXIF metadata
 *   ExifData         — type for the exif argument to insert/update
 *   ExifResult       — type returned in the `exif` field of read()
 *   GpsCoordinates   — type for the `gps` field inside ExifResult
 *   ImageInfo        — type returned by read()
 */

import { openImage }                       from "./Image.js";
import { removeMetadata, insert, update }  from "./metadata.js";

// ── Type re-exports (TypeScript interfaces, erased at runtime) ────────────────
export type { ImageInfo }                  from "./Image.js";
export type { ExifResult, GpsCoordinates } from "./exif.js";
export type { ExifData }                   from "./metadata.js";

// ── Function exports ──────────────────────────────────────────────────────────

/** Open an image file and return its format, dimensions, and EXIF metadata. */
export async function read(path: string) {
    return openImage(path);
}

/** Add EXIF fields while preserving any existing EXIF fields in the source. */
export { insert };

/** Overwrite specified EXIF fields, preserving unrelated existing fields. */
export { update };

/**
 * Remove all EXIF metadata from a JPEG image.
 *
 * Usage:
 *   import { remove } from "./src/index.js";
 *   await remove(input, output);
 */
export { removeMetadata as remove };
