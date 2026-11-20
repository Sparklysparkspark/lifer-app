import { describe, expect, it } from "vitest";
import {
  REQUIRED_TOWNS,
  assignRegions,
  missingTowns,
  parseCities,
  parseCountryInfo,
  pickAlternates,
} from "./gazetteer.js";
import type { RegionRow } from "./places.js";

const square = (w: number, s: number, e: number, n: number) => ({
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ],
    ],
  },
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
  region("west", "Western Canada", "ca"),
  region("bc", "British Columbia", "west", { boundary: square(-139, 48, -114, 60) }),
  region("ab", "Alberta", "west", { boundary: square(-114, 49, -110, 60) }),
];
const line = (id: number, name: string, lat: number, lon: number, admin1 = "02", alts = "") =>
  [id, name, name, alts, lat, lon, "P", "PPL", "CA", "", admin1, "", "", "", "5000", "", "", "", "2026-01-01"].join(
    "\t",
  );

describe("gazetteer", () => {
  it("keeps a few Latin-script other names, without codes or repeats", () => {
    expect(
      pickAlternates("Montréal", "Montreal", "YMQ,Montreal,Monreal',Монреаль,Mont-réal,Ville-Marie,蒙特利尔"),
    ).toBe("Monreal'|Mont-réal|Ville-Marie");
    expect(pickAlternates("A", "A", "Bbb,Ccc,Ddd,Eee,Fff,Ggg").split("|")).toHaveLength(5);
  });

  it("reads the GeoNames table and the country codes", () => {
    const [p] = parseCities(line(6113335, "Prince George", 53.917, -122.749) + "\n");
    expect(p).toMatchObject({ geonameId: 6113335, name: "Prince George", population: 5000, countryCode: "CA" });
    expect(parseCountryInfo("#ISO\tISO3\nCA\tCAN\t124\n").get("CA")).toBe("CAN");
  });

  it("puts a town in its country and the province holding it, or its admin1 neighbours' province", () => {
    const places = parseCities(
      [
        line(1, "Prince George", 53.9, -122.7),
        line(2, "Vancouver", 49.2, -123.1),
        line(3, "Offshore", 47.5, -125, "02"),
        line(4, "Calgary", 51, -113.5, "01"),
      ].join("\n"),
    );
    const out = assignRegions(tree, places, new Map([["CA", "CAN"]]));
    expect(out.map((p) => [p.name, p.countryRegionId, p.provinceRegionId])).toEqual([
      ["Prince George", "ca", "bc"],
      ["Vancouver", "ca", "bc"],
      ["Offshore", "ca", "bc"],
      ["Calgary", "ca", "ab"],
    ]);
  });

  it("moves a border town an outline put in the neighbouring province back to its own", () => {
    // Ten Alberta towns, ten BC towns, and one BC (02) town just over the line in the Alberta box.
    const towns = [
      ...Array.from({ length: 10 }, (_, i) => line(100 + i, `AB ${i}`, 50 + i / 10, -112, "01")),
      ...Array.from({ length: 10 }, (_, i) => line(200 + i, `BC ${i}`, 50 + i / 10, -120, "02")),
      line(300, "Over the line", 50.5, -113.9, "02"),
    ];
    const out = assignRegions(tree, parseCities(towns.join("\n")), new Map([["CA", "CAN"]]));
    expect(out.find((p) => p.name === "Over the line")?.provinceRegionId).toBe("bc");
    expect(out.find((p) => p.name === "AB 3")?.provinceRegionId).toBe("ab");
  });

  it("keeps GeoNames' country, in Lifer's codes, and places an unknown code by outline", () => {
    const regions = [
      ...tree,
      region("eu", "Europe", "w"),
      region("ks", "Kosovo", "eu", { code: "KOS", boundary: square(20, 41.8, 21.8, 43.3) }),
      region("mk", "North Macedonia", "eu", { code: "MKD", boundary: square(20.4, 40.8, 23, 42.4) }),
      region("zz", "Elsewhere", "eu", { code: "ELS", boundary: square(1, 1, 2, 2) }),
      region("fr", "France", "eu", { code: "FRA" }),
      region("yt", "Mayotte", "fr", { boundary: square(45, -13.1, 45.3, -12.6) }),
    ];
    const at = (name: string, cc: string, lat: number, lon: number) =>
      line(0, name, lat, lon).replace("\tCA\t", `\t${cc}\t`);
    const out = assignRegions(
      regions,
      parseCities(
        [
          at("Pristina", "XK", 42.67, 21.16),
          // Inside the overlapping North Macedonia box too: the code wins.
          at("Border village", "XK", 42.2, 21.5),
          at("Mamoudzou", "YT", -12.78, 45.23),
          at("Outlined", "QQ", 1.5, 1.5),
          at("Nowhere", "ZZ", 0, 0),
        ].join("\n"),
      ),
      new Map([["XK", "XKX"]]),
    );
    expect(out.map((p) => [p.name, p.countryRegionId, p.provinceRegionId])).toEqual([
      ["Pristina", "ks", null],
      ["Border village", "ks", null],
      ["Mamoudzou", "fr", "yt"],
      ["Outlined", "zz", null],
      ["Nowhere", null, null],
    ]);
  });

  it("names the known towns a download lacks", () => {
    const all = REQUIRED_TOWNS.map(([countryCode, name]) => ({ countryCode, name }));
    expect(missingTowns(all)).toEqual([]);
    expect(missingTowns(all.filter((t) => t.name !== "Tofino"))).toEqual(["Tofino (CA)"]);
  });
});
