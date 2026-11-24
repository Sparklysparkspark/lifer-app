import { describe, expect, it } from "vitest";
import { assignPlaces, type Place, type RegionRow } from "./places.js";

const place = (name: string, over: Partial<Place> = {}): Place => ({
  name,
  capital: false,
  national: false,
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
  region("yk", "Yukon", "ca"),
  region("no", "Norway", "na", { code: "NOR" }),
  region("sv", "Svalbard", "no"),
  region("ss", "S. Sudan", "na", { code: "SDS" }),
];

describe("assignPlaces", () => {
  const places = [
    place("Ottawa", { capital: true, national: true, population: 900 }),
    place("Toronto", { population: 5000, adm1Name: "Ontario" }),
    place("Vancouver", { population: 2000, adm1Name: "British Columbia" }),
    place("Victoria", { capital: true, population: 300, adm1Name: "British Columbia" }),
    place("Calgary", { population: 1200, adm1Name: "Alberta" }),
    place("Edinburgh", { capital: true, population: 500, iso3: "GBR", iso2: "GB", adm1Name: "Edinburgh" }),
    place("Glasgow", { population: 600, iso3: "GBR", iso2: "GB", adm1Name: "Glasgow" }),
    place("Oslo", { capital: true, national: true, population: 800, iso3: "NOR", iso2: "NO" }),
    place("Bergen", { capital: true, population: 9000, iso3: "NOR", iso2: "NO" }),
    place("Longyearbyen", { capital: true, national: true, population: 2, iso3: "SJM", adm1Name: "Svalbard" }),
    place("Juba", { capital: true, national: true, iso3: "SSD", iso2: "SS" }),
  ];
  const out = assignPlaces(tree, places);

  it("takes a country's capital, and a province's capital before its largest city", () => {
    expect(out.get("ca")?.exampleCity).toBe("Ottawa");
    expect(out.get("bc")?.exampleCity).toBe("Victoria");
    expect(out.get("ab")?.exampleCity).toBe("Calgary");
  });

  it("takes the national capital over a bigger provincial one", () => {
    expect(out.get("no")?.exampleCity).toBe("Oslo");
  });

  it("matches Natural Earth's own codes and a territory's own capital", () => {
    expect(out.get("ss")?.exampleCity).toBe("Juba");
    expect(out.get("sv")?.exampleCity).toBe("Longyearbyen");
  });

  it("falls back to the country's city for a province with no place", () => {
    expect(out.get("yk")?.exampleCity).toBe("Ottawa");
  });

  it("names the most populous direct child", () => {
    expect(out.get("ca")?.populousChildId).toBe("bc");
    expect(out.get("sc")?.populousChildId).toBe("gla");
  });

  it("gives a group of provinces its members' capital", () => {
    expect(out.get("sc")?.exampleCity).toBe("Edinburgh");
  });

  it("lets an override replace a country's city, and its provinces' fallback", () => {
    const code = tree.find((r) => r.id === "ca")?.code ?? "";
    const out = assignPlaces(tree, places, { [code]: "Springfield" });
    expect(out.get("ca")?.exampleCity).toBe("Springfield");
  });

  it("stores an explicit none for a country with no places", () => {
    const none = assignPlaces([...tree, region("nu", "Nauru", "na", { code: "NRU" })], places);
    expect(none.get("nu")).toEqual({ exampleCity: null, populousChildId: null });
  });
});
