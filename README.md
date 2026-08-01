<img width="1024" height="338" alt="imgmeta-js banner" src="https://github.com/user-attachments/assets/b2c24e9f-4ab6-4f2e-8561-5b94e4ae8af6" />

# imgmeta-js

A fast, lightweight, Node.js library for reading image dimensions and formats, as well as parsing and editing EXIF metadata.

Built entirely in **TypeScript**.

---

## ✨ Features

- 🚀 **Zero Dependencies** — Lightweight, secure, and easy to install.
- ⚡ **Fast Image Detection** — Detects image formats using magic bytes instead of file extensions.
- 📏 **Read Image Dimensions** — Supports multiple common image formats.
- 📸 **Comprehensive JPEG EXIF Parser** — Parses EXIF metadata directly from binary data using a custom TIFF parser.
- ✏️ **Byte-Level EXIF Editing** — Insert, update, or remove JPEG EXIF metadata while preserving existing tags whenever possible.
- 🛡️ **Pure TypeScript** — No native bindings, no external binaries, and works anywhere Node.js runs.

---

## 📦 Supported Formats

| Format | Read Dimensions | Read EXIF | Write EXIF |
| :--- | :---: | :---: | :---: |
| **JPEG** | ✅ | ✅ | ✅ |
| **PNG** | ✅ | ✅  | ✅  |
| **GIF** | ✅ | ❌ | ❌ |
| **WebP** | ✅ | ❌ | ❌ |
| **BMP** | ✅ | ❌ | ❌ |
| **TIFF** | ❌ | ❌ | ❌ |

---

## 📥 Installation

```bash
npm install imgmeta-js
```

---

# Usage

## Reading Image Information and EXIF Metadata

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

---

## Insert EXIF Metadata

Adds metadata without replacing existing values.

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

---

## Update EXIF Metadata

Updates only the specified tags while preserving all others.

```ts
import { update } from "imgmeta-js";

await update("input.jpg", "output.jpg", {
  IFD0: {
    Artist: "Bob Jones"
  }
});
```

---

## Remove EXIF Metadata

Completely removes EXIF metadata from a JPEG image.

```ts
import { remove } from "imgmeta-js";

await remove("input.jpg", "stripped.jpg");
```

---

# Limitations

- Writing metadata is currently supported **only for JPEG** files.
- The custom TIFF merge engine preserves standard ASCII tags. Complex binary structures (such as embedded thumbnails or advanced GPS rational data) are removed unless explicitly rewritten.

---

# 🤝 Contributing

Contributions are always welcome!

Whether it's fixing bugs, improving documentation, adding support for new image formats, optimizing performance, or suggesting new features, every contribution helps make **imgmeta-js** better.

Please read **[CONTRIBUTING.md](CONTRIBUTING.md)** before opening an issue or submitting a pull request. It contains the project's development guidelines, coding standards, and contribution workflow.

If you're unsure where to start, check the open issues or start a discussion—we'd be happy to help.

---

# 📄 License

Released under the **MIT License**.
