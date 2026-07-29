# `read()`

Read an image file and return its format, dimensions, and EXIF metadata.

## Signature

```ts
function read(path: string): Promise<ImageInfo>
```

## Example

```ts
import { read } from "imgmeta-js";

const info = await read("photo.jpg");

console.log(info.format);
console.log(info.width, info.height);

if (info.exif) {
  console.log(info.exif.make);
  console.log(info.exif.model);
  console.log(info.exif.dateTaken);

  const ARTIST_TAG = 0x013B;
  console.log(info.exif.raw[ARTIST_TAG]);
}
```

## Returns

Returns a Promise that resolves to an [`ImageInfo`](/api/types#imageinfo) object containing the image metadata.
