import { describe, expect, it } from "vitest";
import { assignPlaces, type Place, type RegionRow } from "./places.js";

const place = (name: string, over: Partial<Place> = {}): Place => ({
  name,
  capital: false,
  population: 1000,
  iso3: "CAN",
  iso2: "CA",
  adm1Name: null,
  point: [0, 0],
  ...over,
});
const region = (id: string, name: string, parentId: string | null, over: Partial<RegionRow> = {}): RegionRow => ({
  id,
  name,
  parentId,
  homeCountryId: null,
  code: null,
  boundary: null,
  ...over,
});

const tree = [
  region("w", "World", null),
  region("na", "North America", "w"),
  region("ca", "Canada", "na", { code: "CAN" }),
  region("bc", "British Columbia", "ca"),
  region("ab", "Alberta", "ca"),
  region("uk", "United Kingdom", "na", { code: "GBR" }),
  region("sc", "Scotland", "uk"),
  region("edi", "Edinburgh", "sc"),
  region("gla", "Glasgow", "sc"),
];

describe("assignPlaces", () => {
  const places = [
    place("Ottawa", { capital: true, population: 900 }),
    place("Toronto", { population: 5000, adm1Name: "Ontario" }),
    place("Vancouver", { population: 2000, adm1Name: "British Columbia" }),
    place("Victoria", { capital: true, population: 300, adm1Name: "British Columbia" }),
    place("Calgary", { population: 1200, adm1Name: "Alberta" }),
    place("Edinburgh", { capital: true, population: 500, iso3: "GBR", iso2: "GB", adm1Name: "Edinburgh" }),
    place("Glasgow", { population: 600, iso3: "GBR", iso2: "GB", adm1Name: "Glasgow" }),
  ];
  const out = assignPlaces(tree, places);

  it("takes a country's capital, and a province's capital before its largest city", () => {
    expect(out.get("ca")?.exampleCity).toBe("Ottawa");
    expect(out.get("bc")?.exampleCity).toBe("Victoria");
    expect(out.get("ab")?.exampleCity).toBe("Calgary");
  });

  it("names the most populous direct child", () => {
    expect(out.get("ca")?.populousChildId).toBe("bc");
    expect(out.get("sc")?.populousChildId).toBe("gla");
  });

  it("gives a group of provinces its members' capital", () => {
    expect(out.get("sc")?.exampleCity).toBe("Edinburgh");
  });

  it("stores an explicit none for a country with no places", () => {
    const none = assignPlaces([...tree, region("nu", "Nauru", "na", { code: "NRU" })], places);
    expect(none.get("nu")).toEqual({ exampleCity: null, populousChildId: null });
  });
});
