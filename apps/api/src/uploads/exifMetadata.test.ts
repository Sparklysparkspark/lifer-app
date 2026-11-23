// Round-trips Lifer's metadata writes through the real bundled exiftool, checking the exact fields
// Lightroom and digiKam read (see writeLiferMetadata in exif.ts).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExifTool } from "exiftool-vendored";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// keywordsToKeep asks the catalog which existing keywords are species names; answer for the one
// species these tests write, so no database is needed.
vi.mock("@lifer/core/db.js", () => ({
  pool: {
    query: (_sql: string, [words]: [string[]]) => {
      const known = new Set(["bald eagle", "haliaeetus leucocephalus"]);
      return Promise.resolve({ rows: words.filter((k) => known.has(k)).map((k) => ({ k })) });
    },
  },
}));

import {
  closeExiftool,
  extractExif,
  extractKeywords,
  metadataGoesInFile,
  readExifTags,
  writeCaptureMetadata,
} from "./exif.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "lifer-meta-"));
});
afterAll(async () => {
  await closeExiftool();
  rmSync(dir, { recursive: true, force: true });
});

const data = {
  species: [
    {
      commonName: "Bald Eagle",
      scientificName: "Haliaeetus leucocephalus",
      taxonClass: "aves",
      family: "Accipitridae",
    },
  ],
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
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } })
      .jpeg()
      .toFile(file);
    await writeCaptureMetadata(file, data);
    const tags = (await readExifTags(file)) as unknown as Record<string, unknown>;
    expect(tags.Subject).toEqual(["Bald Eagle", "Haliaeetus leucocephalus"]);
    expect(tags.HierarchicalSubject).toEqual(["Species|Birds|Accipitridae|Bald Eagle"]);
    expect(tags.Rating).toBe(4);
    expect((await extractExif(file)).rating).toBe(4);
  });

  it("embeds tags and the rating in a HEIC and leaves it decodable", async (ctx) => {
    const file = path.join(dir, "a.heic");
    // sharp's prebuilt libvips encodes AV1 only; exiftool writes the same HEIF container for both.
    try {
      await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } })
        .heif({ compression: "av1" })
        .toFile(file);
    } catch {
      return ctx.skip();
    }
    await writeCaptureMetadata(file, data);
    const tags = (await readExifTags(file)) as unknown as Record<string, unknown>;
    expect(tags.Subject).toEqual(["Bald Eagle", "Haliaeetus leucocephalus"]);
    expect(tags.Rating).toBe(4);
    expect((await sharp(file).metadata()).width).toBe(8);
  });

  it("clears the file's rating when Lifer's is cleared", async () => {
    const file = path.join(dir, "b.jpg");
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } })
      .jpeg()
      .toFile(file);
    await writeCaptureMetadata(file, data);
    await writeCaptureMetadata(file, { ...data, rating: null });
    expect((await extractExif(file)).rating).toBeNull();
  });

  it("writes a date set in Lifer into a JPEG without one, follows a correction, and never writes over the camera's", async () => {
    const file = path.join(dir, "undated.jpg");
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } })
      .jpeg()
      .toFile(file);
    await writeCaptureMetadata(file, { ...data, takenAt: new Date("2023-07-04T15:30:00Z") });
    expect((await extractExif(file)).takenAt).toEqual(new Date("2023-07-04T15:30:00Z"));
    const corrected = new Date("2023-07-05T15:30:00Z");
    await writeCaptureMetadata(file, { ...data, takenAt: corrected });
    expect((await extractExif(file)).takenAt).toEqual(corrected);

    // A camera writes CreateDate too: that date is the camera's and stays.
    const camera = path.join(dir, "camera.jpg");
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } })
      .jpeg()
      .toFile(camera);
    const tool = new ExifTool();
    try {
      await tool.write(
        camera,
        { DateTimeOriginal: "2023:07:04 15:30:00", CreateDate: "2023:07:04 15:30:00" },
        { writeArgs: ["-overwrite_original"] },
      );
    } finally {
      await tool.end();
    }
    await writeCaptureMetadata(camera, { ...data, takenAt: corrected });
    expect((await extractExif(camera)).takenAt).toEqual(new Date("2023-07-04T15:30:00Z"));
  });

  it("keeps the camera's own clock for the month, whatever its time zone", async () => {
    const { exiftool } = await import("exiftool-vendored");
    const file = path.join(dir, "new-years-eve.jpg");
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } })
      .jpeg()
      .toFile(file);
    await exiftool.write(
      file,
      { DateTimeOriginal: "2024:12:31 23:30:00", OffsetTimeOriginal: "-08:00" },
      { writeArgs: ["-overwrite_original"] },
    );
    const exif = await extractExif(file);
    expect(exif.takenAt?.toISOString()).toBe("2025-01-01T07:30:00.000Z");
    // Late on New Year's Eve where it was taken: December, not January.
    expect(exif.localTakenAt?.getUTCMonth()).toBe(11);
  });

  it("writes a RAW's tags to a sidecar without copying camera fields", async () => {
    const raw = path.join(dir, "c.CR2");
    writeFileSync(raw, "not really a raw");
    await writeCaptureMetadata(raw, { ...data, takenAt: new Date("2024-05-01T10:00:00Z"), cameraModel: "X" });
    const sidecar = (await readExifTags(path.join(dir, "c.xmp"))) as unknown as Record<string, unknown>;
    expect(sidecar.Rating).toBe(4);
    expect(sidecar.DateTimeOriginal).toBeUndefined();
    expect(sidecar.Model).toBeUndefined();
    // No stray field with every keyword dot-joined into one string.
    expect(String(sidecar.Keywords ?? "")).not.toContain("Bald Eagle.");
  });

  it("writes photo tags as plain keywords next to Lifer's and other tools', and removes only its own", async () => {
    const file = path.join(dir, "tags.jpg");
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } })
      .jpeg()
      .toFile(file);
    // A keyword added in another tool, before Lifer ever wrote the file.
    const { exiftool } = await import("exiftool-vendored");
    await exiftool.write(file, { "XMP-dc:Subject": ["portfolio"], "IPTC:Keywords": ["portfolio"] } as never, {
      writeArgs: ["-overwrite_original"],
    });

    await writeCaptureMetadata(file, { ...data, tags: ["flight shot", "courtship"] });
    let tags = (await readExifTags(file)) as unknown as Record<string, unknown>;
    expect(tags.Subject).toEqual(["portfolio", "Bald Eagle", "Haliaeetus leucocephalus", "flight shot", "courtship"]);
    expect(tags.Keywords).toEqual(["portfolio", "Bald Eagle", "Haliaeetus leucocephalus", "flight shot", "courtship"]);
    expect(tags.HierarchicalSubject).toEqual([
      "Species|Birds|Accipitridae|Bald Eagle",
      "Lifer Tags|flight shot",
      "Lifer Tags|courtship",
    ]);

    // Removing a tag in Lifer removes its keyword; the other tool's keyword stays.
    await writeCaptureMetadata(file, { ...data, tags: ["courtship"] });
    tags = (await readExifTags(file)) as unknown as Record<string, unknown>;
    expect(tags.Subject).toEqual(["portfolio", "Bald Eagle", "Haliaeetus leucocephalus", "courtship"]);
    expect(tags.HierarchicalSubject).toEqual(["Species|Birds|Accipitridae|Bald Eagle", "Lifer Tags|courtship"]);

    // A write that doesn't carry the tags (a species-only rewrite) leaves them as they are.
    await writeCaptureMetadata(file, { ...data, tags: undefined });
    tags = (await readExifTags(file)) as unknown as Record<string, unknown>;
    expect(tags.Subject).toEqual(["portfolio", "Bald Eagle", "Haliaeetus leucocephalus", "courtship"]);
    expect(tags.HierarchicalSubject).toEqual(["Species|Birds|Accipitridae|Bald Eagle", "Lifer Tags|courtship"]);

    // A tag named like a species is still the user's tag, and goes when the tag does.
    await writeCaptureMetadata(file, { ...data, tags: ["Haliaeetus leucocephalus"] });
    await writeCaptureMetadata(file, { ...data, tags: [] });
    tags = (await readExifTags(file)) as unknown as Record<string, unknown>;
    expect(tags.Subject).toEqual(["portfolio", "Bald Eagle", "Haliaeetus leucocephalus"]);
    expect(tags.HierarchicalSubject).toEqual(["Species|Birds|Accipitridae|Bald Eagle"]);
  });
});

describe("writeCaptureMetadata: the photo's place", () => {
  const place = { state: "British Columbia", country: "Canada", countryCode: "CA", countryCode3: "CAN" };

  it("fills a JPEG's empty location fields with its region's province and country, never GPS", async () => {
    const file = path.join(dir, "place.jpg");
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } })
      .jpeg()
      .toFile(file);
    await writeCaptureMetadata(file, { ...data, lat: null, lon: null, place });
    const tags = (await readExifTags(file)) as unknown as Record<string, unknown>;
    expect([tags.State, tags.Country, tags.CountryCode]).toEqual(["British Columbia", "Canada", "CA"]);
    expect([tags["Province-State"], tags["Country-PrimaryLocationName"], tags["Country-PrimaryLocationCode"]]).toEqual([
      "British Columbia",
      "Canada",
      "CAN",
    ]);
    expect(tags.GPSLatitude).toBeUndefined();
  });

  it("keeps a location the photographer already set", async () => {
    const file = path.join(dir, "place-kept.jpg");
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } })
      .jpeg()
      .toFile(file);
    await writeCaptureMetadata(file, { ...data, place: { ...place, state: "Yukon" } });
    await writeCaptureMetadata(file, { ...data, place });
    const tags = (await readExifTags(file)) as unknown as Record<string, unknown>;
    expect([tags.State, tags.Country]).toEqual(["Yukon", "Canada"]);
  });

  it("follows a region changed in Lifer, replacing the place it wrote before", async () => {
    const file = path.join(dir, "place-moved.jpg");
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } })
      .jpeg()
      .toFile(file);
    await writeCaptureMetadata(file, { ...data, place });
    await writeCaptureMetadata(file, { ...data, place: { ...place, state: "Alberta" }, replacePlace: true });
    const tags = (await readExifTags(file)) as unknown as Record<string, unknown>;
    expect([tags.State, tags["Province-State"]]).toEqual(["Alberta", "Alberta"]);
  });

  it("puts a RAW's place in its sidecar", async () => {
    const raw = path.join(dir, "place.cr3");
    writeFileSync(raw, "not really a raw");
    await writeCaptureMetadata(raw, { ...data, place });
    const sidecar = (await readExifTags(path.join(dir, "place.xmp"))) as unknown as Record<string, unknown>;
    expect([sidecar.State, sidecar.Country, sidecar.CountryCode]).toEqual(["British Columbia", "Canada", "CA"]);
  });
});

describe("writeCaptureMetadata: the place name", () => {
  const blankJpeg = async (name: string) => {
    const file = path.join(dir, name);
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } })
      .jpeg()
      .toFile(file);
    return file;
  };

  it("writes it as IPTC Sublocation and reads it back, then follows a rename and a removal", async () => {
    const { extractLocationLabel } = await import("./exif.js");
    const file = await blankJpeg("label.jpg");
    await writeCaptureMetadata(file, { ...data, locationLabel: "Pigeon Lake" });
    let tags = (await readExifTags(file)) as unknown as Record<string, unknown>;
    expect([tags.Location, tags["Sub-location"]]).toEqual(["Pigeon Lake", "Pigeon Lake"]);
    expect(extractLocationLabel(tags)).toBe("Pigeon Lake");

    await writeCaptureMetadata(file, { ...data, locationLabel: "Île Bizard" });
    expect(extractLocationLabel(await readExifTags(file))).toBe("Île Bizard");
    // Left out: the file keeps the name it has.
    await writeCaptureMetadata(file, data);
    expect(extractLocationLabel(await readExifTags(file))).toBe("Île Bizard");
    await writeCaptureMetadata(file, { ...data, locationLabel: null });
    tags = (await readExifTags(file)) as unknown as Record<string, unknown>;
    expect([tags.Location, tags["Sub-location"]]).toEqual([undefined, undefined]);
  });

  it("puts a RAW's place name in its sidecar", async () => {
    const { extractLocationLabel } = await import("./exif.js");
    const raw = path.join(dir, "label.nef");
    writeFileSync(raw, "not really a raw");
    await writeCaptureMetadata(raw, { ...data, locationLabel: "Pigeon Lake" });
    expect(extractLocationLabel(await readExifTags(path.join(dir, "label.xmp")))).toBe("Pigeon Lake");
  });
});

describe("metadataGoesInFile", () => {
  it("embeds for JPEG/TIFF/PNG/DNG and uses sidecars for RAW", () => {
    expect(metadataGoesInFile("x.JPG")).toBe(true);
    expect(metadataGoesInFile("x.dng")).toBe(true);
    expect(metadataGoesInFile("x.HEIC")).toBe(true);
    expect(metadataGoesInFile("x.CR3")).toBe(false);
    expect(metadataGoesInFile("x.NEF")).toBe(false);
  });
});

describe("extractLiferTags", () => {
  it("reads back the photo tags Lifer wrote, for reimport", async () => {
    const { extractLiferTags } = await import("./exif.js");
    const tags = {
      HierarchicalSubject: [
        "Species|Birds|Accipitridae|Bald Eagle",
        "Lifer Tags|flight shot",
        "Places|Lifer Tags|x",
        "Lifer Tags|",
      ],
    };
    expect(extractLiferTags(tags as never)).toEqual(["flight shot"]);
    expect(extractLiferTags({ HierarchicalSubject: "Lifer Tags|dawn" } as never)).toEqual(["dawn"]);
    expect(extractLiferTags({} as never)).toEqual([]);
  });
});

describe("extractKeywords", () => {
  it("reads the leaf of both Lightroom (|) and digiKam (/) hierarchies", async () => {
    const tags = { HierarchicalSubject: ["Birds|Ducks|Mallard"], TagsList: ["Birds/Hawks/Osprey"] };
    expect((await extractKeywords("unused", tags as never)).sort()).toEqual(["Mallard", "Osprey"]);
  });
});
