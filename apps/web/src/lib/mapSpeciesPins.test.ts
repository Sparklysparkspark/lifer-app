import { describe, expect, it } from "vitest";
import { clusterSummary, pinClusterRadius, pinFeatures, type SpeciesPin } from "./mapSpeciesPins";

const pin = (over: Partial<SpeciesPin>): SpeciesPin => ({
  speciesId: "a",
  commonName: "Pin Warbler",
  scientificName: "Pinna warbleri",
  taxonClass: "aves",
  iconicTaxon: null,
  lat: 43,
  lon: 13,
  count: 1,
  photoId: "p",
  ...over,
});

describe("pinFeatures", () => {
  it("places each pin at lon, lat with its taxa group and index", () => {
    const fc = pinFeatures([pin({}), pin({ speciesId: "b", taxonClass: null, iconicTaxon: "Insecta", lon: -1 })]);
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0]).toMatchObject({ properties: { i: 0, group: "birds" }, geometry: { coordinates: [13, 43] } });
    expect(fc.features[1].properties).toMatchObject({ i: 1, speciesId: "b", group: "insects" });
  });

  it("is empty with no pins", () => {
    expect(pinFeatures([]).features).toEqual([]);
  });
});

describe("pinClusterRadius", () => {
  it("grows with the pin count and stays within the paint's range", () => {
    expect(pinClusterRadius(1)).toBe(10);
    expect(pinClusterRadius(100)).toBeGreaterThan(pinClusterRadius(4));
    expect(pinClusterRadius(5000)).toBe(22);
  });
});

describe("clusterSummary", () => {
  it("counts distinct species and sums photos", () => {
    expect(
      clusterSummary([
        { speciesId: "a", count: 2 },
        { speciesId: "a", count: 3 },
        { speciesId: "b", count: 1 },
      ]),
    ).toEqual({ species: 2, pins: 3, photos: 6 });
  });
});
