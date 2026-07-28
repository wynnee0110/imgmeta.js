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
