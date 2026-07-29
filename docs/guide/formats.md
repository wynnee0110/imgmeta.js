# Supported Formats

Below is a matrix of the image formats supported by `imgmeta-js` and the features available for each.

| Format | Read Dimensions | Read EXIF | Write EXIF |
| :--- | :---: | :---: | :---: |
| **JPEG** | ✅ | ✅ | ✅ |
| **PNG** | ✅ | ❌ | ❌ |
| **GIF** | ✅ | ❌ | ❌ |
| **WebP** | ✅ | ❌ | ❌ |
| **BMP** | ✅ | ❌ | ❌ |
| **TIFF** | ❌ | ❌ | ❌ |

## Limitations

- Writing metadata is currently supported **only for JPEG** files.
- The custom TIFF merge engine preserves standard ASCII tags. Complex binary structures (such as embedded thumbnails or advanced GPS rational data) are removed unless explicitly rewritten.
