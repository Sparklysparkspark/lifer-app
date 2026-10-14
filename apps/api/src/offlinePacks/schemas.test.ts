import { describe, expect, it } from "vitest";
import { PackIndexSchema, PackManifestSchema, PhotoStoreIndexSchema, parseRemoteJson } from "./schemas.js";

const pack = {
  id: "kenya-aves",
  type: "region",
  region: "Kenya",
  taxon: "aves",
  sizeBytes: 10,
  speciesCount: 2,
  contentVersion: "abc",
  scientificNames: ["A b", "C d"],
  url: "https://example.org/packs-0.bin",
  range: [0, 9],
};

describe("parseRemoteJson", () => {
  it("passes a well-formed pack index through, extra fields included", () => {
    const index = { generatedAt: "2026-01-01", packs: [{ ...pack, futureField: 1 }] };
    expect(parseRemoteJson(PackIndexSchema, index, "pack index")).toBe(index);
  });

  it("names the first wrong field of a malformed file", () => {
    expect(() =>
      parseRemoteJson(PackIndexSchema, { generatedAt: "x", packs: [{ ...pack, url: 5 }] }, "pack index"),
    ).toThrow("The pack index isn't in the expected format (/packs/0/url must be string)");
    expect(() => parseRemoteJson(PhotoStoreIndexSchema, { v: 2 }, "pack photo index")).toThrow(
      /^The pack photo index isn't in the expected format/,
    );
    expect(() => parseRemoteJson(PackManifestSchema, null, "pack's manifest")).toThrow(/\(\/ /);
  });

  it("accepts a photo store index and a manifest as the pipeline writes them", () => {
    const store = {
      v: 1,
      builtAt: "2026-01-01",
      shards: [{ name: "s0.bin", bytes: 3, sha256: "x" }],
      species: { "sp-1": { d: [0, 0, 3, "sha1"], g: { "https://x/y.jpg": { t: [0, 0, 1, "sha1"] } } } },
    };
    expect(parseRemoteJson(PhotoStoreIndexSchema, store, "pack photo index")).toBe(store);
    const manifest = {
      type: "region",
      region: "Kenya",
      taxon: null,
      species: [
        {
          scientificName: "A b",
          habitatDescription: null,
          referenceCredit: null,
          referenceLicense: null,
          displayFile: null,
          thumbFile: null,
          localTier: "rare",
          hotspots: [
            { centroidLat: 1, centroidLon: 2, pointCount: 3, bboxDiagonalKm: 4, lastSeenYear: null, distinctYears: 2 },
          ],
        },
      ],
      children: [
        {
          name: "Nairobi",
          ebirdRegionCode: null,
          boundaryGeoJson: {},
          externalCodes: [],
          species: [],
          isOverseasTerritory: false,
        },
      ],
    };
    expect(parseRemoteJson(PackManifestSchema, manifest, "pack's manifest")).toBe(manifest);
  });
});
