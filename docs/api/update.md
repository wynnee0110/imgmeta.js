# `update()`

Updates only the specified tags in a JPEG image while preserving all others.

## Signature

```ts
function update(input: string, output: string, exif: ExifData): Promise<void>
```

## Example

```ts
import { update } from "imgmeta-js";

await update("input.jpg", "output.jpg", {
  IFD0: {
    Artist: "Bob Jones"
  }
});
```

See the [`ExifData`](/api/types#exifdata) type for the structure of the `exif` argument.
