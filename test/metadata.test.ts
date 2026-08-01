import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { remove, insert, read, update } from "../src/index.ts";

const source = path.resolve("test/sample.jpg");
let directory = "";

beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "imgmeta-test-"));
});

afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
});

test("read returns image dimensions and EXIF data", async () => {
    const image = await read(source);

    assert.equal(image.format, "jpeg");
    assert.ok(image.width);
    assert.ok(image.height);
    // If the sample has EXIF, Model tag (0x0110) should be readable via .raw
    if (image.exif) {
        assert.equal(image.exif.raw[0x0110], "Pixel 2");
    }
});

test("insert adds EXIF metadata to a new image", async () => {
    const output = path.join(directory, "inserted.jpg");

    await insert(source, output, { IFD0: { Artist: "imgmeta test artist" } });

    const image = await read(output);
    // Artist tag = 0x013B in the raw EXIF map
    assert.equal(image.exif?.raw[0x013B], "imgmeta test artist");
});

test("update replaces supplied EXIF metadata in a new image", async () => {
    const inserted = path.join(directory, "inserted.jpg");
    const output = path.join(directory, "updated.jpg");

    await insert(source, inserted, { IFD0: { Artist: "first artist" } });
    await update(inserted, output, { IFD0: { Artist: "updated artist" } });

    const image = await read(output);
    assert.equal(image.exif?.raw[0x013B], "updated artist");
});

test("remove removes EXIF metadata from a new image", async () => {
    const inserted = path.join(directory, "inserted.jpg");
    const output = path.join(directory, "without-exif.jpg");

    await insert(source, inserted, { IFD0: { Artist: "remove me" } });
    await remove(inserted, output);

    const image = await read(output);
    assert.equal(image.exif?.raw[0x013B], undefined); // Artist should be gone
    assert.equal(image.exif?.raw[0x0110], undefined); // Model should be gone
    assert.equal(image.exif, null);                    // No EXIF at all
});

// ─── PNG Tests ────────────────────────────────────────────────────────────────

const pngSource = path.resolve("test/sample.png");

test("read() returns format and dimensions for a PNG", async () => {
    const image = await read(pngSource);

    assert.equal(image.format, "png");
    assert.ok(image.width  > 0, "width should be positive");
    assert.ok(image.height > 0, "height should be positive");
});

test("read() parses eXIf data from a PNG with an embedded eXIf chunk", async () => {
    const image = await read(pngSource);

    // sample.png is generated with Artist tag (0x013B) = "PNG EXIF Test"
    assert.notEqual(image.exif, null, "PNG should have EXIF data");
    assert.equal(image.exif?.raw[0x013B], "PNG EXIF Test");
});

test("insert() writes and read() retrieves EXIF from a PNG", async () => {
    const output = path.join(directory, "inserted.png");

    // insert() adds new tags; existing tags in source win over supplied ones.
    // sample.png already has Artist set, so use a tag that isn't in the source.
    await insert(pngSource, output, { IFD0: { Copyright: "png insert copyright" } });

    const image = await read(output);
    assert.equal(image.format, "png");
    assert.equal(image.exif?.raw[0x8298], "png insert copyright"); // Copyright tag
    assert.equal(image.exif?.raw[0x013B], "PNG EXIF Test");        // existing Artist preserved
});

test("update() overwrites an EXIF tag in a PNG", async () => {
    const inserted = path.join(directory, "inserted.png");
    const updated  = path.join(directory, "updated.png");

    await insert(pngSource, inserted, { IFD0: { Artist: "first png artist" } });
    await update(inserted,  updated,  { IFD0: { Artist: "updated png artist" } });

    const image = await read(updated);
    assert.equal(image.exif?.raw[0x013B], "updated png artist");
});

test("remove() strips eXIf from a PNG", async () => {
    const inserted = path.join(directory, "inserted.png");
    const stripped = path.join(directory, "stripped.png");

    await insert(pngSource, inserted, { IFD0: { Artist: "remove me png" } });
    await remove(inserted, stripped);

    const image = await read(stripped);
    assert.equal(image.exif, null, "EXIF should be null after remove()");
});
