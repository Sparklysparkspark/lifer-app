import { describe, expect, it } from "vitest";
import {
  expectShape,
  isGbifCount,
  isGbifFacets,
  isGbifMatch,
  isGbifTaxaPage,
  isInatNearbyPlaces,
  isInatSpeciesCountsPage,
  isInatTaxaPage,
} from "./jsonGuards.js";

describe("response guards", () => {
  it("accept the shapes the APIs return", () => {
    expect(isInatTaxaPage({ total_results: 1, results: [{ id: 1, name: "Pica pica", rank: "species" }] })).toBe(true);
    expect(
      isInatSpeciesCountsPage({ total_results: 1, results: [{ count: 3, taxon: { id: 1, name: "Pica pica" } }] }),
    ).toBe(true);
    expect(isInatNearbyPlaces({ results: { standard: [{ id: 7 }], community: [] } })).toBe(true);
    expect(isGbifFacets({ count: 0, facets: [{ field: "SPECIES_KEY", counts: [{ name: "123", count: 4 }] }] })).toBe(
      true,
    );
    expect(isGbifCount({ count: 12, results: [] })).toBe(true);
    expect(isGbifTaxaPage({ endOfRecords: true, results: [{ key: 1, scientificName: "Aves", rank: "CLASS" }] })).toBe(
      true,
    );
    expect(isGbifMatch({ matchType: "NONE" })).toBe(true);
    expect(isGbifMatch({ matchType: "EXACT", usageKey: 5 })).toBe(true);
  });

  it("reject error bodies and renamed fields", () => {
    expect(isInatTaxaPage({ error: "Too many requests" })).toBe(false);
    expect(isInatTaxaPage({ results: [{ id: "1", name: "Pica pica" }] })).toBe(false);
    expect(isInatSpeciesCountsPage({ results: [] })).toBe(false);
    expect(isGbifFacets({ facets: [{ field: "SPECIES_KEY", counts: [{ name: 123, count: 4 }] }] })).toBe(false);
    expect(isGbifCount("<html>")).toBe(false);
    expect(isGbifTaxaPage({ results: [{ key: 1 }] })).toBe(false);
    expect(isGbifMatch({ usageKey: 5 })).toBe(false);
  });

  it("expectShape names what it got", () => {
    expect(() => expectShape({ oops: 1 }, isGbifCount, "GBIF count")).toThrow(
      /Unexpected GBIF count response: \{"oops":1\}/,
    );
    expect(expectShape({ count: 2 }, isGbifCount, "GBIF count").count).toBe(2);
  });
});
