/**
 * types.ts — Shared public type definitions for imgmeta.
 *
 * These are re-exported through index.ts for library consumers.
 * The actual implementations live in Image.ts, exif.ts, and metadata.ts.
 *
 * Note: all exports here are `export type` because they are TypeScript interfaces
 * that have no runtime representation — they are erased after compilation.
 */
export type { ImageInfo }                  from "./Image.js";
export type { ExifResult, GpsCoordinates } from "./exif.js";
export type { ExifData }                   from "./metadata.js";
