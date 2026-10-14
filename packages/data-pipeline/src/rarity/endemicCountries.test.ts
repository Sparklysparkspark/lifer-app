import { describe, expect, it } from "vitest";
import {
  aggregateCountryCounts,
  computeVagrantCountries,
  countryDownloads,
  islandQueryBox,
  endemicCountries,
  introducedCountries,
  mergeByGbifKey,
  type CountGroup,
  type CountryGroupCounts,
} from "./endemicCountries.js";

function square(lon: number, lat: number, size: number): [number, number][] {
  return [
    [lon, lat],
    [lon + size, lat],
    [lon + size, lat + size],
    [lon, lat + size],
    [lon, lat],
  ];
}

const group = (minRecords: number): CountGroup => ({
  taxonKeys: [],
  minRecords,
  yearsWindow: null,
  classes: new Set(["Mammalia"]),
});
const country = (iso3: string, lon: number) => ({
  iso3,
  feature: {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [square(lon, 0, 1)] },
  } as never,
});

describe("endemicCountries", () => {
  it("names the one country a species clears the threshold in", () => {
    const perCountry = new Map<string, CountryGroupCounts>([
      // A cached download: names, records, spread.
      [
        "USA",
        [
          [
            ["Common mammal", 6000, 900],
            ["Rare mammal", 50, 20],
          ],
        ],
      ],
      // A live call: GBIF keys, no spread. The rare one is under the threshold here.
      [
        "CAN",
        [
          [
            [100, 5500, null],
            [101, 5, null],
          ],
        ],
      ],
    ]);
    const names = new Map([
      ["Common mammal", 100],
      ["Rare mammal", 101],
    ]);
    const { countryCountsByGbifKey, bboxKmByGbifKeyAndIso3 } = aggregateCountryCounts(perCountry, [group(10)], names);
    const endemic = endemicCountries(countryCountsByGbifKey, bboxKmByGbifKeyAndIso3, [
      country("USA", 0),
      country("CAN", 1),
    ]);
    expect(endemic.get(101)).toBe("USA");
    expect(endemic.has(100)).toBe(false);
  });

  it("adds up a species' names before applying the threshold", () => {
    const perCountry = new Map<string, CountryGroupCounts>([
      [
        "USA",
        [
          [
            ["Old name", 6, 10],
            ["New name", 6, 30],
          ],
        ],
      ],
    ]);
    const names = new Map([
      ["Old name", 7],
      ["New name", 7],
    ]);
    const { countryCountsByGbifKey, bboxKmByGbifKeyAndIso3 } = aggregateCountryCounts(perCountry, [group(10)], names);
    expect(countryCountsByGbifKey.get(7)).toEqual(new Map([["USA", 12]]));
    expect(bboxKmByGbifKeyAndIso3.get(7)).toEqual(new Map([["USA", 30]]));
  });

  it("still counts a native whose only other records look like escapees", () => {
    const countryCountsByGbifKey = new Map([
      [
        5,
        new Map([
          ["ZMB", 176],
          ["ZAF", 387],
        ]),
      ],
    ]);
    const bboxKm = new Map([
      [
        5,
        new Map([
          ["ZMB", 405],
          ["ZAF", 1386],
        ]),
      ],
    ]);
    expect(endemicCountries(countryCountsByGbifKey, bboxKm, [country("ZMB", 0), country("ZAF", 20)]).get(5)).toBe(
      "ZMB",
    );
  });
});

describe("computeVagrantCountries", () => {
  // Two countries far apart (>500km) in every case below: concentration is what's being tested.
  const CORE_RINGS = [square(0, 0, 1)];
  const OTHER_RINGS = [square(20, 0, 1)];

  it("flags a scattered escapee population far from a concentrated real core", () => {
    // A single-country wild population plus a larger, scattered escapee population elsewhere whose
    // concentration is well under the core's.
    const counts = new Map([
      ["ZMB", 176],
      ["ZAF", 387],
    ]);
    const bboxKm = new Map([
      ["ZMB", 405],
      ["ZAF", 1386],
    ]);
    const rings = new Map([
      ["ZMB", CORE_RINGS],
      ["ZAF", OTHER_RINGS],
    ]);
    const vagrant = computeVagrantCountries(counts, bboxKm, rings, new Map());
    expect(vagrant.has("ZAF")).toBe(true);
  });

  it("does NOT flag a second real, similarly-concentrated disjunct population", () => {
    // Two genuinely separate native populations: the second country's concentration is close to
    // the core's, as a real population's would be.
    const counts = new Map([
      ["USA", 10_000],
      ["MEX", 4_000],
    ]);
    const bboxKm = new Map([
      ["USA", 500], // concentration = 20
      ["MEX", 250], // concentration = 16 (80% of core, well above the 0.7 ratio bar)
    ]);
    const rings = new Map([
      ["USA", CORE_RINGS],
      ["MEX", OTHER_RINGS],
    ]);
    const vagrant = computeVagrantCountries(counts, bboxKm, rings, new Map());
    expect(vagrant.size).toBe(0);
  });

  it("does NOT flag far, sparser countries that border each other, since they're a range", () => {
    // A well-recorded core plus a band of neighbouring countries far away, each recorded less:
    // a widespread native, not escapees.
    const counts = new Map([
      ["SEN", 583],
      ["NGA", 325],
      ["BEN", 104],
      ["CMR", 39],
    ]);
    const bboxKm = new Map([
      ["SEN", 672],
      ["NGA", 1342],
      ["BEN", 652],
      ["CMR", 483],
    ]);
    const rings = new Map([
      ["SEN", CORE_RINGS],
      ["BEN", [square(19, 0, 1)]],
      ["NGA", OTHER_RINGS],
      ["CMR", [square(21, 0, 1)]],
    ]);
    expect(computeVagrantCountries(counts, bboxKm, rings, new Map()).size).toBe(0);
  });

  it("still flags far, sparser countries that are far from each other too", () => {
    const counts = new Map([
      ["SEN", 583],
      ["USA", 325],
      ["ESP", 104],
      ["AUS", 39],
    ]);
    const bboxKm = new Map([
      ["SEN", 672],
      ["USA", 1342],
      ["ESP", 652],
      ["AUS", 483],
    ]);
    const rings = new Map([
      ["SEN", CORE_RINGS],
      ["USA", [square(-40, 0, 1)]],
      ["ESP", OTHER_RINGS],
      ["AUS", [square(60, 0, 1)]],
    ]);
    expect([...computeVagrantCountries(counts, bboxKm, rings, new Map())].sort()).toEqual(["AUS", "ESP", "USA"]);
  });

  it("skips vagrant detection entirely once a species spans too many countries", () => {
    // A species present in dozens of countries has no single core; without the country-count gate
    // the one far-away country would be flagged despite being entirely real.
    const counts = new Map<string, number>();
    const bboxKm = new Map<string, number>();
    const rings = new Map<string, [number, number][][]>();
    for (let i = 0; i < 19; i++) {
      const code = `C${i}`;
      counts.set(code, 100);
      bboxKm.set(code, 50);
      rings.set(code, [square(i, 40, 1)]); // clustered together, near the "core"
    }
    counts.set("FAR", 100);
    bboxKm.set("FAR", 50);
    rings.set("FAR", OTHER_RINGS); // far from every other country in the set
    const vagrant = computeVagrantCountries(counts, bboxKm, rings, new Map());
    expect(vagrant.size).toBe(0);
  });
});

describe("mergeByGbifKey", () => {
  it("adds up the records of names that stand for one species and keeps the widest spread", () => {
    const merged = mergeByGbifKey([
      { gbifKey: 1, recordCount: 30, bboxDiagonalKm: 100 },
      { gbifKey: 2, recordCount: 5, bboxDiagonalKm: 10 },
      { gbifKey: 1, recordCount: 12, bboxDiagonalKm: 400 },
    ]);
    expect(merged).toEqual([
      { gbifKey: 1, recordCount: 42, bboxDiagonalKm: 400 },
      { gbifKey: 2, recordCount: 5, bboxDiagonalKm: 10 },
    ]);
  });
});

describe("countryDownloads", () => {
  const place = (name: string, iso3: string, iso2: string | null, size: number) => ({
    name,
    iso3,
    iso2,
    feature: {
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: [square(0, 0, size)] },
    } as never,
  });

  it("gives a download shared with a reef to the larger country, and the reef none", () => {
    const zips = countryDownloads([
      place("Australia", "AUS", "AU", 30),
      place("Ashmore and Cartier Is.", "ATC", "AU", 0.1),
      place("Indian Ocean Ter.", "IOA", "AU", 0.2),
      place("Peru", "PER", "PE", 10),
    ]);
    expect(Object.fromEntries(zips)).toEqual({ AUS: "AU", ATC: null, IOA: "CX", PER: "PE" });
  });
});

describe("islandQueryBox", () => {
  it("pads a lone island into a box to query its reefs by", () => {
    expect(islandQueryBox([square(10, 10, 0.1)], [[square(20, 10, 5)]])).toBe(
      "POLYGON((9.5 9.5,10.6 9.5,10.6 10.6,9.5 10.6,9.5 9.5))",
    );
  });

  it("gives an enclave none, since its box would take in the country around it", () => {
    expect(islandQueryBox([square(10, 10, 0.1)], [[square(9, 9, 3)]])).toBeNull();
  });

  it("gives an offshore territory near another country none", () => {
    expect(islandQueryBox([square(10, 10, 0.1)], [[square(12, 10, 5)]])).toBeNull();
  });
});

describe("introduced populations", () => {
  const countries = [
    { ...country("IDN", 0), iso2: "ID", name: "Indonesia" },
    { ...country("IOA", 20), iso2: "AU", name: "Indian Ocean Ter." },
    { ...country("AUS", 40), iso2: "AU", name: "Australia" },
  ];

  it("maps a register's countries onto ours, including a territory's own GBIF codes", () => {
    const introduced = introducedCountries(new Map([[1, { native: ["ID"], introduced: ["CC"] }]]), countries);
    expect([...introduced.get(1)!]).toEqual(["IOA"]);
  });

  it("never counts a country the records also call native as introduced", () => {
    const introduced = introducedCountries(new Map([[1, { native: ["AU"], introduced: ["AU"] }]]), countries);
    expect(introduced.has(1)).toBe(false);
  });

  it("leaves introduced countries out, so a native range in one country is endemic", () => {
    const counts = new Map([
      [
        1,
        new Map([
          ["IDN", 500],
          ["IOA", 200],
        ]),
      ],
    ]);
    expect(endemicCountries(counts, new Map(), countries).get(1)).toBeUndefined();
    expect(endemicCountries(counts, new Map(), countries, new Map([[1, new Set(["IOA"])]])).get(1)).toBe("IDN");
  });

  it("doesn't make a smaller leftover country home once introduced ones drop out", () => {
    const counts = new Map([
      [
        1,
        new Map([
          ["AUS", 500],
          ["IOA", 200],
        ]),
      ],
    ]);
    expect(endemicCountries(counts, new Map(), countries, new Map([[1, new Set(["AUS"])]])).get(1)).toBeUndefined();
  });

  it("never makes a species endemic to a country it was introduced to", () => {
    const counts = new Map([
      [
        1,
        new Map([
          ["AUS", 500],
          ["IOA", 200],
        ]),
      ],
    ]);
    expect(
      endemicCountries(counts, new Map(), countries, new Map([[1, new Set(["AUS", "IOA"])]])).get(1),
    ).toBeUndefined();
  });

  it("never leaves out the best-recorded country, so a native moved around at home stays there", () => {
    const counts = new Map([
      [
        1,
        new Map([
          ["IDN", 500],
          ["IOA", 200],
        ]),
      ],
    ]);
    expect(endemicCountries(counts, new Map(), countries, new Map([[1, new Set(["IDN"])]])).get(1)).toBeUndefined();
  });
});
