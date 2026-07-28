<img width="1024" height="338" alt="1daab24d-a3e7-4bd4-be37-6ff9849abaf2" src="https://github.com/user-attachments/assets/b2c24e9f-4ab6-4f2e-8561-5b94e4ae8af6" />


A fast, lightweight, and **zero-dependency** Node.js library to read image dimensions/formats and manage JPEG EXIF metadata. Written in pure TypeScript with zero third-party library dependencies (`sharp` and `exif-parser` are not used).

## Features

- **Zero dependencies**: Extremely lightweight, small package size, and highly secure.
- **Fast format & dimension detection**: Fast detection for major image formats by checking magic bytes directly (not by file extension).
- **Comprehensive EXIF parser**: Full byte-level scan for APP1 markers and custom TIFF parser to extract EXIF data.
- **Byte-level metadata editing**: Insert, update, or remove EXIF tags from JPEGs with safe merge semantics and distinct-path protection.

---

## Supported Formats

| Format | Read Dimensions | Read EXIF | Write EXIF |
| :--- | :---: | :---: | :---: |
| **JPEG** | ✅ | ✅ | ✅ |
| **PNG** | ✅ | ❌ | ❌ |
| **GIF** | ✅ | ❌ | ❌ |
| **WEBP** | ✅ | ❌ | ❌ |
| **BMP** | ✅ | ❌ | ❌ |
| **TIFF** | ❌ | ❌ | ❌ |

---

## Installation

```bash
npm install imgmeta-js
```

---

## Usage Examples

### 1. Reading Image Information and EXIF Metadata

```javascript
import { read } from 'imgmeta';

const info = await read('photo.jpg');
console.log(`Format: ${info.format}`); // 'jpeg'
console.log(`Dimensions: ${info.width}x${info.height}`);

if (info.exif) {
  console.log(`Camera Make: ${info.exif.make}`);
  console.log(`Camera Model: ${info.exif.model}`);
  console.log(`Date Taken: ${info.exif.dateTaken}`);
  
  // Access raw EXIF tags using their spec IDs:
  const ARTIST_TAG = 0x013B;
  console.log(`Artist: ${info.exif.raw[ARTIST_TAG]}`);
}
```

### 2. Inserting EXIF Metadata

Adds new fields. If a tag is already present in the source image, its existing value is preserved.

```javascript
import { insert } from 'imgmeta';

await insert('input.jpg', 'output.jpg', {
  IFD0: {
    Artist: 'Alice Smith',
    Copyright: '2026 Alice Smith'
  },
  IFD1: {
    DateTimeOriginal: '2026:07:28 17:00:00'
  }
});
```

### 3. Updating EXIF Metadata

Replaces specified fields. Mentioned fields are overwritten, while other existing fields are preserved.

```javascript
import { update } from 'imgmeta';

await update('input.jpg', 'output.jpg', {
  IFD0: {
    Artist: 'Bob Jones' // Overwrites the existing Artist tag
  }
});
```

### 4. Stripping EXIF Metadata

Removes all EXIF metadata from the JPEG image.

```javascript
import { remove } from 'imgmeta';

await remove('input.jpg', 'stripped.jpg');
```

---

## Limitations

- **JPEG Only for Writes**: Modifying metadata (`insert`, `update`, `delete`) is only supported on JPEG format files.
- **ASCII Tags Only for Custom Merges**: The custom binary TIFF merge logic preserves existing ASCII tags, but other complex binary properties (like embedded thumbnails or complex GPS rational structures) are stripped during write operations unless explicitly overwritten.

## License

MIT License.
# imgmeta.js
