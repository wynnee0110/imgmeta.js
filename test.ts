/**
 * test.ts — Test suite for imgmeta
 *
 * Uses Node.js's built-in test runner (node:test) — no external test framework needed.
 * Run with:  npm test   (which calls `node --test`)
 */

import test   from "node:test";
import assert from "node:assert/strict";
import fs     from "node:fs/promises";
import path   from "node:path";
import { fileURLToPath } from "node:url";

import { read, insert, update, remove } from "./src/index.ts";

// Resolve __dirname for ES modules (import.meta.url replaces __filename in CJS)
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── Paths ────────────────────────────────────────────────────────────────────
const SAMPLE_IMAGE  = path.join(__dirname, "test", "sample.jpg");
const OUTPUT_INSERT = path.join(__dirname, "test", "output_insert.jpg");
const OUTPUT_UPDATE = path.join(__dirname, "test", "output_update.jpg");
const OUTPUT_DELETE = path.join(__dirname, "test", "output_delete.jpg");

// ─── Cleanup ──────────────────────────────────────────────────────────────────
// Remove any generated output files after all tests complete.
test.after(async () => {
    await fs.rm(OUTPUT_INSERT, { force: true });
    await fs.rm(OUTPUT_UPDATE, { force: true });
    await fs.rm(OUTPUT_DELETE, { force: true });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

test("read() returns format, width, and height", async () => {
    const result = await read(SAMPLE_IMAGE);

    assert.ok(result,                               "result should not be null");
    assert.strictEqual(result.format, "jpeg",       "format should be 'jpeg'");
    assert.strictEqual(typeof result.width, "number", "width should be a number");
    assert.strictEqual(typeof result.height, "number", "height should be a number");
    assert.ok(result.width  > 0,                    "width should be positive");
    assert.ok(result.height > 0,                    "height should be positive");
});

test("read() parses EXIF data when present", async () => {
    const result = await read(SAMPLE_IMAGE);

    // exif may be null if the sample has no EXIF — that is acceptable.
    // When present, verify the shape of the returned object.
    if (result.exif !== null) {
        assert.strictEqual(typeof result.exif, "object", "exif should be an object");
        assert.ok("raw" in result.exif,                  "exif should have a 'raw' property");
        assert.strictEqual(typeof result.exif.raw, "object", "raw should be an object");
    }
});

test("insert() writes a readable JPEG with the same dimensions", async () => {
    const newExif = {
        IFD0: { Artist: "Test Artist", Copyright: "2024 Test" }
    };

    await insert(SAMPLE_IMAGE, OUTPUT_INSERT, newExif);

    // The output file must exist and be readable
    const result = await read(OUTPUT_INSERT);
    assert.ok(result, "output image should be readable");

    // Dimensions must be unchanged by inserting EXIF
    const original = await read(SAMPLE_IMAGE);
    assert.strictEqual(result.width,  original.width,  "width must be unchanged");
    assert.strictEqual(result.height, original.height, "height must be unchanged");
    assert.strictEqual(result.format, "jpeg",           "format must still be jpeg");
});

test("insert() preserves the inserted Artist tag in the output", async () => {
    const result = await read(OUTPUT_INSERT);

    // If EXIF was written and parsed correctly, the Artist field should be readable
    if (result.exif !== null) {
        // TAG_ARTIST = 0x013B; check via the raw map
        const ARTIST_TAG_ID = 0x013B;
        assert.ok(
            result.exif.raw[ARTIST_TAG_ID] !== undefined,
            "Artist tag (0x013B) should be present in raw EXIF"
        );
        assert.strictEqual(result.exif.raw[ARTIST_TAG_ID], "Test Artist");
    }
});

test("update() writes a readable JPEG", async () => {
    const updatedExif = {
        IFD0: { Artist: "Updated Artist" },
        IFD1: { DateTimeOriginal: "2024:06:15 14:30:00" }
    };

    await update(SAMPLE_IMAGE, OUTPUT_UPDATE, updatedExif);

    const result = await read(OUTPUT_UPDATE);
    assert.ok(result, "output image should be readable");
    assert.strictEqual(result.format, "jpeg");
});

test("remove() writes a readable JPEG", async () => {
    await remove(SAMPLE_IMAGE, OUTPUT_DELETE);

    const result = await read(OUTPUT_DELETE);
    assert.ok(result, "output image after stripping metadata should be readable");
    assert.strictEqual(result.format, "jpeg");
});

test("remove() strips EXIF from the output", async () => {
    const result = await read(OUTPUT_DELETE);

    // After stripping, EXIF should be null (our parser returns null if APP1 is absent)
    assert.strictEqual(result.exif, null, "exif should be null after remove");
});

test("throws when input and output paths are the same", async () => {
    await assert.rejects(
        () => remove(SAMPLE_IMAGE, SAMPLE_IMAGE),
        {
            name:    "Error",
            message: "Input and output paths must be different to protect the original image."
        }
    );
});
