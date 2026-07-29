# Types

Below are the main types exposed by `imgmeta-js`.

## `ImageInfo`

Returned by `read()`.

```ts
export interface ImageInfo {
    /** Detected format: "jpeg" | "png" | "gif" | "webp" | "bmp" | "tiff" | null */
    format:  string | null;
    /** Image width in pixels. undefined if the format is unrecognised. */
    width:   number | undefined;
    /** Image height in pixels. undefined if the format is unrecognised. */
    height:  number | undefined;
    /** Parsed EXIF metadata. null if the image has no EXIF or EXIF parsing failed. */
    exif:    ExifResult | null;
}
```

## `ExifResult`

The parsed EXIF data returned in `ImageInfo.exif`.

```ts
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
     * Keyed by the numeric TIFF tag ID.
     */
    raw: Record<number, any>;
}
```

## `GpsCoordinates`

```ts
export interface GpsCoordinates {
    /** Decimal degrees. Negative = South. */
    latitude: number;
    /** Decimal degrees. Negative = West. */
    longitude: number;
    /** Metres above sea level. Negative = below sea level. Optional. */
    altitude?: number;
}
```

## `ExifData`

Data to write when using `insert()` or `update()`.

```ts
export interface ExifData {
    IFD0?: Record<string, string>; // Main image IFD (Make, Model, Artist, Copyright, ...)
    IFD1?: Record<string, string>; // Exif Sub-IFD (DateTimeOriginal, UserComment, ...)
    IFD2?: Record<string, string>; // reserved: GPS IFD (future)
    IFD3?: Record<string, string>; // reserved: thumbnail IFD (future)
}
```
