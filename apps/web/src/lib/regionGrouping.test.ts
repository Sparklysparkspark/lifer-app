import { describe, expect, it } from "vitest";
import type { RegionSummary } from "@lifer/shared";
import type { PackStatusEntry } from "./packIndex";
import {
  availableTaxaByRegion,
  CENTRAL_AMERICA_CONTINENT_ID,
  continentIdForCountry,
  countryAncestorOf,
  groupRegions,
  regionsReachableFrom,
  searchCountries,
} from "./regionGrouping";

function region(id: string, name: string, parentId: string | null, extra: Partial<RegionSummary> = {}): RegionSummary {
  return {
    id,
    name,
    parentId,
    ebirdRegionCode: null,
    boundaryGeoJson: null,
    hasChildren: false,
    hasScopedChecklist: true,
    sovereigntyGroup: null,
    isSovereignDependency: false,
    ...extra,
  };
}

const regions = [
  region("w", "World", null, { hasScopedChecklist: false }),
  region("na", "North America", "w", { hasScopedChecklist: false }),
  region("eu", "Europe", "w", { hasScopedChecklist: false }),
  region("us", "United States", "na", { sovereigntyGroup: "US" }),
  region("pr", "Puerto Rico", "na", { sovereigntyGroup: "US", isSovereignDependency: true }),
  region("cr", "Costa Rica", "na"),
  region("fr", "France", "eu"),
  region("ca-state", "California", "us"),
  region("pa-prov", "Panama", "cr"),
];

describe("groupRegions", () => {
  const g = groupRegions(regions);

  it("puts Central America right after North America", () => {
    expect(g.continents.map((c) => c.id)).toEqual(["na", CENTRAL_AMERICA_CONTINENT_ID, "eu"]);
  });

  it("groups primary countries by display continent and territories by their real one", () => {
    expect(g.countriesByContinent.get("na")?.map((r) => r.id)).toEqual(["us"]);
    expect(g.countriesByContinent.get(CENTRAL_AMERICA_CONTINENT_ID)?.map((r) => r.id)).toEqual(["cr"]);
    expect(g.territoriesByContinent.get("na")?.map((r) => r.id)).toEqual(["pr"]);
    expect(g.territoriesByCountryId.get("us")?.map((r) => r.id)).toEqual(["pr"]);
  });

  it("ignores provinces, even ones named like a Central American country", () => {
    const all = [...g.countriesByContinent.values()].flat().map((r) => r.id);
    expect(all).not.toContain("pa-prov");
    expect(all).not.toContain("ca-state");
  });

  it("opens a Central American country under its own group", () => {
    expect(continentIdForCountry(regions[5])).toBe(CENTRAL_AMERICA_CONTINENT_ID);
    expect(continentIdForCountry(regions[3])).toBe("na");
  });
});

describe("searchCountries", () => {
  it("needs two characters and matches countries and territories only", () => {
    const { continents } = groupRegions(regions);
    expect(searchCountries(regions, continents, "r")).toEqual([]);
    expect(searchCountries(regions, continents, " RI ").map((r) => r.id)).toEqual(["pr", "cr"]);
  });
});

describe("availableTaxaByRegion", () => {
  it("maps each region id to the taxa its published packs cover", () => {
    const pack = (region: string, taxon: PackStatusEntry["taxon"]): PackStatusEntry => ({
      id: `${region}-${taxon}`,
      type: "region",
      region,
      taxon,
      sizeBytes: 1,
      speciesCount: 1,
      contentVersion: "v",
      url: "",
      downloaded: false,
      updateAvailable: false,
    });
    const result = availableTaxaByRegion(
      [pack("France", "aves"), pack("France", "mammalia"), pack("France", null), pack("Atlantis", "aves")],
      regions,
    );
    expect(result).toEqual({ fr: ["aves", "mammalia"] });
  });
});

describe("regionsReachableFrom", () => {
  it("includes a downloaded country, its ancestors and its descendants", () => {
    expect([...regionsReachableFrom(regions, new Set(["United States"]))].sort()).toEqual(
      ["ca-state", "na", "us", "w"].sort(),
    );
  });
});

describe("countryAncestorOf", () => {
  const tree = [
    region("w", "World", null, { hasScopedChecklist: false }),
    region("eu", "Europe", "w", { hasScopedChecklist: false }),
    region("fr", "France", "eu"),
    region("idf", "Ile-de-France", "fr"),
    region("paris", "Paris", "idf"),
    region("gl", "Greenland", "eu"),
  ];
  const byId = new Map(tree.map((r) => [r.id, r]));

  it("resolves a province under a regional group to its country", () => {
    expect(countryAncestorOf(byId, "paris")?.id).toBe("fr");
    expect(countryAncestorOf(byId, "idf")?.id).toBe("fr");
    expect(countryAncestorOf(byId, "fr")?.id).toBe("fr");
  });

  it("keeps a province shown directly under its continent as its own pack region", () => {
    expect(countryAncestorOf(byId, "gl")?.id).toBe("gl");
  });

  it("returns null for an unknown region", () => {
    expect(countryAncestorOf(byId, "nope")).toBeNull();
  });
});
