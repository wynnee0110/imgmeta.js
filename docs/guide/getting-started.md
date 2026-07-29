# Getting Started

**imgmeta-js** is a fast, lightweight, Node.js library for reading image dimensions and formats, as well as parsing and editing JPEG EXIF metadata. It is built entirely in **TypeScript** and requires zero runtime dependencies.

## Installation

```bash
npm install imgmeta-js
```

## Quick Example

Here's a quick example to read an image and extract its dimensions and EXIF metadata:

```ts
import { read } from "imgmeta-js";

const info = await read("photo.jpg");

console.log(info.format); // "jpeg"
console.log(info.width, info.height);

if (info.exif) {
  console.log(info.exif.make);
  console.log(info.exif.model);
  console.log(info.exif.dateTaken);

  const ARTIST_TAG = 0x013B;
  console.log(info.exif.raw[ARTIST_TAG]);
}
```

## Importing Methods

The library exposes the following core methods:
- `read`: Read image formats, dimensions, and EXIF metadata.
- `insert`: Insert EXIF metadata while preserving existing tags.
- `update`: Update existing EXIF metadata tags.
- `remove`: Completely strip EXIF metadata from an image.

Proceed to the [API Reference](/api/read) for more details.
