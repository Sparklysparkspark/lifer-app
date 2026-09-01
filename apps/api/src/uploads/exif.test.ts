// extractExif/extractKeywords both accept an already-read `tags` object, so these run as pure
// transforms with no exiftool process spawned — the reading side (readExifTags) is the only
// part that actually shells out, and isn't covered here.
import { describe, expect, it } from "vitest";
import { extractExif, extractKeywords } from "./exif.js";

function tags(overrides: Record<string, unknown>) {
  return overrides as never;
}

describe("extractExif", () => {
  it("extracts a full set of fields from well-formed tags", async () => {
    const result = await extractExif("unused.jpg", tags({
      DateTimeOriginal: { toDate: () => new Date("2026-01-01T00:00:00Z") },
      FocalLength: "400.0 mm",
      GPSLatitude: 37.7749,
      GPSLongitude: -122.4194,
      Model: "Canon EOS R5",
      LensModel: "RF100-500mm F4.5-7.1",
      FNumber: 5.6,
      ShutterSpeed: "1/1000",
      ISO: 400,
    }));
    expect(result).toEqual({
      takenAt: new Date("2026-01-01T00:00:00Z"),
      lat: 37.7749,
      lon: -122.4194,
      cameraModel: "Canon EOS R5",
      lens: "RF100-500mm F4.5-7.1",
      focalLengthMm: 400,
      aperture: 5.6,
      shutter: "1/1000",
      iso: 400,
    });
  });

  it("falls back to Lens when LensModel is absent", async () => {
    const result = await extractExif("unused.jpg", tags({ Lens: "Kit lens" }));
    expect(result.lens).toBe("Kit lens");
  });

  // Boundary value: an empty/malformed FocalLength string.
  it("boundary value: a non-numeric FocalLength string produces null, not NaN", async () => {
    const result = await extractExif("unused.jpg", tags({ FocalLength: "unknown" }));
    expect(result.focalLengthMm).toBeNull();
  });

  it("boundary value: every field absent from tags resolves to null, not undefined or a throw", async () => {
    const result = await extractExif("unused.jpg", tags({}));
    expect(result).toEqual({
      takenAt: null,
      lat: null,
      lon: null,
      cameraModel: null,
      lens: null,
      focalLengthMm: null,
      aperture: null,
      shutter: null,
      iso: null,
    });
  });

  it("does not treat a DateTimeOriginal without a toDate method as a real date", async () => {
    const result = await extractExif("unused.jpg", tags({ DateTimeOriginal: "not-a-real-tag-object" }));
    expect(result.takenAt).toBeNull();
  });
});

describe("extractKeywords", () => {
  it("collects Keywords, Subject, TagsList, and HierarchicalSubject, taking only the leaf segment of a hierarchy", async () => {
    const result = await extractKeywords("unused.jpg", tags({
      Keywords: ["Mallard"],
      Subject: ["Waterfowl"],
      TagsList: ["Birds/Waterfowl/Mallard"],
      HierarchicalSubject: ["Species/Aves/Anatidae/Mallard"],
    }));
    expect(result.sort()).toEqual(["Mallard", "Waterfowl"].sort());
  });

  it("de-duplicates leaves that appear in more than one tag", async () => {
    const result = await extractKeywords("unused.jpg", tags({
      Keywords: ["Mallard"],
      HierarchicalSubject: ["Species/Aves/Anatidae/Mallard"],
    }));
    expect(result).toEqual(["Mallard"]);
  });

  it("normalizes a single string tag value to a one-element list (exiftool returns a bare string for a single keyword, not an array)", async () => {
    const result = await extractKeywords("unused.jpg", tags({ Keywords: "Mallard" }));
    expect(result).toEqual(["Mallard"]);
  });

  // Boundary value: no keyword tags present at all.
  it("boundary value: returns an empty array when no keyword tags are present", async () => {
    const result = await extractKeywords("unused.jpg", tags({}));
    expect(result).toEqual([]);
  });

  it("boundary value: trims whitespace and drops blank entries", async () => {
    const result = await extractKeywords("unused.jpg", tags({ Keywords: ["  Mallard  ", "", "   "] }));
    expect(result).toEqual(["Mallard"]);
  });
});
