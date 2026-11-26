import { describe, expect, it } from "vitest";
import { countryAreas, keepCountryRows, licenceOf, type ObisArea } from "./build-country-marine-obis.js";

const area = (id: string, name: string, type = "obis"): ObisArea => ({ id, name, type });

describe("countryAreas", () => {
  const areas = [
    area("22", "Belize"),
    area("20764", "Belize Barrier Reef Reserve System", "mwhs"),
    area("266", "United States: all"),
    area("272", "United States: North Atlantic"),
    area("265", "United States: Alaska: North Pacific"),
    area("268", "United States: Hawaii"),
    area("275", "United States: Palmyra Atoll"),
    area("90", "France: all"),
    area("91", "France: Mediterranean Sea"),
    area("92", "France: French Polynesia"),
    area("300", "United Kingdom"),
    area("301", "United Kingdom: all"),
    area("302", "United Kingdom: Bermuda"),
    area("303", "United Kingdom: Pitcairn"),
    area("128", "Joint Regime: Japan - Korea"),
    area("224", "Republic of Korea"),
    area("120", "Israel"),
    area("121", "Israel: Red Sea"),
    area("122", "Israel: all"),
  ];
  const names = new Set([
    "Belize",
    "United States of America",
    "France",
    "Fr. Polynesia",
    "United Kingdom",
    "Bermuda",
    "Pitcairn Is.",
    "South Korea",
    "Japan",
    "Israel",
  ]);
  const got = countryAreas(areas, names);
  const ids = (c: string) => (got.get(c) ?? []).map((a) => a.id).sort();

  it("takes the area named after the country, never another area type", () => {
    expect(ids("Belize")).toEqual(["22"]);
    expect(ids("South Korea")).toEqual(["224"]);
  });

  it("adds a country's coast parts and home islands, never its 'all' area", () => {
    expect(ids("United States of America")).toEqual(["265", "268", "272"]);
    expect(ids("France")).toEqual(["91"]);
    expect(ids("Israel")).toEqual(["120", "121"]);
  });

  it("gives a territory area to the territory's own row, not its sovereign's", () => {
    expect(ids("Fr. Polynesia")).toEqual(["92"]);
    expect(ids("Bermuda")).toEqual(["302"]);
    expect(ids("Pitcairn Is.")).toEqual(["303"]);
    expect(ids("United Kingdom")).toEqual(["300"]);
  });

  it("leaves joint regimes out", () => {
    expect(ids("Japan")).toEqual([]);
  });
});

describe("licenceOf", () => {
  it("reads OBIS rights statements", () => {
    expect(licenceOf("This work is licensed under a  Creative Commons Attribution (CC-BY) 4.0 License")).toBe("CC BY");
    expect(
      licenceOf("This work is licensed under a  Creative Commons Attribution Non Commercial (CC-BY-NC) 4.0 License"),
    ).toBe("CC BY-NC");
    expect(licenceOf("the publisher has waived all rights to these data ... Public Domain (CC0 1.0)")).toBe("CC0");
    expect(licenceOf("Unrestricted")).toBe("other");
    expect(licenceOf(null)).toBe("other");
  });
});

describe("keepCountryRows", () => {
  const tally = new Map([
    ["well", 5],
    ["thin", 2],
    ["thin-photographed", 1],
    ["stray", 40],
  ]);
  const run = (minRecords: number) =>
    keepCountryRows(tally, {
      minRecords,
      photographed: (id) => id === "thin-photographed",
      onNearbyZone: (id) => id !== "stray",
    })
      .map((r) => r.speciesId)
      .sort();

  it("keeps 5+ records, or 1+ and photographed, only where a nearby sea zone lists it", () => {
    expect(run(5)).toEqual(["thin-photographed", "well"]);
  });

  it("keeps any record with --any-records, still not a basin stray", () => {
    expect(run(1)).toEqual(["thin", "thin-photographed", "well"]);
  });
});
