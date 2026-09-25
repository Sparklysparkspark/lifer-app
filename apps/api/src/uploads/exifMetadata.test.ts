// Round-trips Lifer's metadata writes through the real bundled exiftool, checking the exact fields
// Lightroom and digiKam read (see writeLiferMetadata in exif.ts).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeExiftool, extractExif, extractKeywords, metadataGoesInFile, readExifTags, writeCaptureMetadata } from "./exif.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "lifer-meta-"));
});
afterAll(async () => {
  await closeExiftool();
  rmSync(dir, { recursive: true, force: true });
});

const data = {
  species: [{ commonName: "Bald Eagle", scientificName: "Haliaeetus leucocephalus", taxonClass: "aves", family: "Accipitridae" }],
  namingStyles: [],
  rating: 4,
  isCover: false,
  takenAt: null,
  lat: 49.1,
  lon: -123.2,
  cameraModel: null,
  lens: null,
  focalLengthMm: null,
  aperture: null,
  shutter: null,
  iso: null,
};

describe("writeCaptureMetadata", () => {
  it("embeds tags and the rating in a JPEG, each keyword once, with a Lightroom-style hierarchy", async () => {
    const file = path.join(dir, "a.jpg");
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } }).jpeg().toFile(file);
    await writeCaptureMetadata(file, data);
    const tags = (await readExifTags(file)) as unknown as Record<string, unknown>;
    expect(tags.Subject).toEqual(["Bald Eagle", "Haliaeetus leucocephalus"]);
    expect(tags.HierarchicalSubject).toEqual(["Species|Birds|Accipitridae|Bald Eagle"]);
    expect(tags.Rating).toBe(4);
    expect((await extractExif(file)).rating).toBe(4);
  });

  it("clears the file's rating when Lifer's is cleared", async () => {
    const file = path.join(dir, "b.jpg");
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } }).jpeg().toFile(file);
    await writeCaptureMetadata(file, data);
    await writeCaptureMetadata(file, { ...data, rating: null });
    expect((await extractExif(file)).rating).toBeNull();
  });

  it("writes a RAW's tags to a sidecar without copying camera fields", async () => {
    const raw = path.join(dir, "c.CR2");
    writeFileSync(raw, "not really a raw");
    await writeCaptureMetadata(raw, { ...data, takenAt: new Date("2024-05-01T10:00:00Z"), cameraModel: "X" });
    const sidecar = (await readExifTags(path.join(dir, "c.xmp"))) as unknown as Record<string, unknown>;
    expect(sidecar.Rating).toBe(4);
    expect(sidecar.DateTimeOriginal).toBeUndefined();
    expect(sidecar.Model).toBeUndefined();
    // The old stray pdf:Keywords held every keyword dot-joined into one string.
    expect(String(sidecar.Keywords ?? "")).not.toContain("Bald Eagle.");
  });
});

describe("metadataGoesInFile", () => {
  it("embeds for JPEG/TIFF/PNG/DNG and uses sidecars for RAW", () => {
    expect(metadataGoesInFile("x.JPG")).toBe(true);
    expect(metadataGoesInFile("x.dng")).toBe(true);
    expect(metadataGoesInFile("x.CR3")).toBe(false);
    expect(metadataGoesInFile("x.NEF")).toBe(false);
  });
});

describe("extractKeywords", () => {
  it("reads the leaf of both Lightroom (|) and digiKam (/) hierarchies", async () => {
    const tags = { HierarchicalSubject: ["Birds|Ducks|Mallard"], TagsList: ["Birds/Hawks/Osprey"] };
    expect((await extractKeywords("unused", tags as never)).sort()).toEqual(["Mallard", "Osprey"]);
  });
});
