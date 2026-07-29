# `insert()`

Adds metadata to a JPEG image without replacing existing values.

## Signature

```ts
function insert(input: string, output: string, exif: ExifData): Promise<void>
```

## Example

```ts
import { insert } from "imgmeta-js";

await insert("input.jpg", "output.jpg", {
  IFD0: {
    Artist: "Alice Smith",
    Copyright: "2026 Alice Smith"
  },
  IFD1: {
    DateTimeOriginal: "2026:07:28 17:00:00"
  }
});
```

See the [`ExifData`](/api/types#exifdata) type for the structure of the `exif` argument.
