import { describe, expect, it } from "vitest";
import {
  EBIRD_SENSITIVE_SPECIES,
  isEbirdSensitiveAt,
  type SensitiveLocation,
  sensitiveRegionMatches,
  weekInSeason,
  type SensitiveScope,
  type SensitiveSeason,
} from "./sensitiveSpecies.js";

const season = (startMonth: number, startDay: number, endMonth: number, endDay: number): SensitiveSeason => ({
  startMonth,
  startDay,
  endMonth,
  endDay,
});

describe("weekInSeason", () => {
  // Week n's midpoint is day (n - 1) * 7 + 4: week 1 is Jan 4, week 14 Apr 4, week 31 Aug 1.
  const springSummer = season(4, 1, 7, 31); // days 91 to 212
  const winter = season(11, 1, 2, 28); // wraps the year: day 305 on, or up to day 59
  const firstQuarter = season(1, 1, 3, 31);
  const yearEnd = season(11, 1, 12, 31);

  it.each([
    ["before the start", 13, springSummer, false], // Mar 28
    ["the first week inside", 14, springSummer, true], // Apr 4
    ["mid season", 20, springSummer, true],
    ["the last week inside", 30, springSummer, true], // Jul 25
    ["after the end", 31, springSummer, false], // Aug 1
    ["a wrapping season, late in the year", 45, winter, true], // Nov 8
    ["a wrapping season, early in the year", 1, winter, true], // Jan 4
    ["a wrapping season, its last week", 8, winter, true], // Feb 22
    ["a wrapping season, just after it", 9, winter, false], // Mar 1
    ["a wrapping season, just before it", 43, winter, false], // Oct 25
    ["a wrapping season, mid year", 26, winter, false],
    ["week 53 in a season ending Dec 31", 53, yearEnd, false], // early January
    ["week 53 in a season starting Jan 1", 53, firstQuarter, true],
    ["week 53 in a wrapping season", 53, winter, true],
    ["week 52 in a season ending Dec 31", 52, yearEnd, true], // Dec 27
  ])("%s (week %i)", (_label, week, s, expected) => {
    expect(weekInSeason(week, s)).toBe(expected);
  });

  it("covers the whole year for a Jan 1 to Dec 31 season", () => {
    for (let week = 1; week <= 53; week++) expect(weekInSeason(week, season(1, 1, 12, 31))).toBe(true);
  });
});

describe("sensitiveRegionMatches", () => {
  it.each([
    ["a province label in its country", "Ontario-CA", "Ontario", "Canada", "CA", true],
    ["case-insensitive province names", "england-GB", "England", "United Kingdom", "GB", true],
    ["the same province name in another country", "Ontario-CA", "Ontario", "United States", "US", false],
    ["another province of the right country", "Ontario-CA", "Quebec", "Canada", "CA", false],
    ["a country label", "Mexico", "Jalisco", "Mexico", "MX", true],
    ["case-insensitive country names", "south korea", "Seoul", "South Korea", "KR", true],
    ["a country label against another country", "Mexico", "Texas", "United States", "US", false],
    ["a country label never matches a same-named province", "Mexico", "Mexico", "Philippines", "PH", false],
    ["a country label with a hyphen", "Guinea-Bissau", "Bissau", "Guinea-Bissau", "GW", true],
    ["a hyphenated country is not a province label", "Guinea-Bissau", "Guinea", "Guinea", "BI", false],
    ["a lowercase suffix is not a country code", "Ontario-ca", "Ontario", "Canada", "CA", false],
    ["accents differ", "Quebec-CA", "Québec", "Canada", "CA", true],
    ["macrons differ", "Hyogo-JP", "Hyōgo", "Japan", "JP", true],
    ["a dotless i", "Kırşehir-TR", "Kirsehir", "Turkey", "TR", true],
    ["the Czech kraj suffix", "Moravskoslezský kraj-CZ", "Moravskoslezský", "Czechia", "CZ", true],
    ["a Polish name for an English one", "Mazowieckie-PL", "Masovian", "Poland", "PL", true],
    ["an alias only for its own province", "Mazowieckie-PL", "Lublin", "Poland", "PL", false],
  ])("%s", (_label, label, province, country, iso2, expected) => {
    expect(sensitiveRegionMatches(label, province, country, iso2)).toBe(expected);
  });

  it.each([
    ["a province in the named group", "Wales-GB", "Gwynedd", "Wales", true],
    ["a province in a group split by area", "England-GB", "Kent", "England - South East", true],
    ["a province in another group", "Wales-GB", "Kent", "England - South East", false],
    ["a group name that only starts the same", "England-GB", "Kent", "Englandshire", false],
  ])("%s", (_label, label, province, group, expected) => {
    expect(sensitiveRegionMatches(label, province, "United Kingdom", "GB", group)).toBe(expected);
  });
});

describe("EBIRD_SENSITIVE_SPECIES", () => {
  it("has well-formed region scopes and seasons", () => {
    for (const [name, scope] of EBIRD_SENSITIVE_SPECIES) {
      if (scope.global) continue;
      expect(scope.regions.length, name).toBeGreaterThan(0);
      for (const { region, season: s } of scope.regions) {
        expect(region.trim(), name).toBe(region);
        if (!s) continue;
        for (const [month, day] of [
          [s.startMonth, s.startDay],
          [s.endMonth, s.endDay],
        ]) {
          expect(month >= 1 && month <= 12, `${name} ${region}`).toBe(true);
          expect(day >= 1 && day <= new Date(Date.UTC(2001, month, 0)).getUTCDate(), `${name} ${region}`).toBe(true);
        }
      }
    }
  });
});

describe("isEbirdSensitiveAt", () => {
  const at = (country: string, countryCode: string, state: string | null = null, group: string | null = null) =>
    ({ country, countryCode, state, group }) satisfies SensitiveLocation;
  const UK = at("United Kingdom", "GB");
  const CANADA = at("Canada", "CA");

  it("treats a regionally listed species as sensitive only where it is listed", () => {
    const goldeneye = "Bucephala clangula";
    expect(EBIRD_SENSITIVE_SPECIES.get(goldeneye)).toMatchObject({ global: false });
    expect(isEbirdSensitiveAt(goldeneye, at("United Kingdom", "GB", "Kent", "England - South East"))).toBe(true);
    expect(isEbirdSensitiveAt(goldeneye, at("United Kingdom", "GB", "Highland", "Scotland"))).toBe(false);
    // Only the country is known, so England can't be ruled out.
    expect(isEbirdSensitiveAt(goldeneye, UK)).toBe(true);
    expect(isEbirdSensitiveAt(goldeneye, at("Canada", "CA", "Ontario"))).toBe(false);
    expect(isEbirdSensitiveAt(goldeneye, CANADA)).toBe(false);
  });

  it("is sensitive everywhere when listed globally, and never when not listed", () => {
    expect(isEbirdSensitiveAt("Strix nebulosa", CANADA)).toBe(true);
    expect(isEbirdSensitiveAt("Strix nebulosa", null)).toBe(true);
    expect(isEbirdSensitiveAt("Anas platyrhynchos", UK)).toBe(false);
    expect(isEbirdSensitiveAt("Anas platyrhynchos", null)).toBe(false);
  });

  it("keeps the cautious rule for an unknown location or one too coarse to rule an area out", () => {
    const list = new Map<string, SensitiveScope>([
      ["Testus avis", { global: false, regions: [{ region: "Ontario-CA", season: null }] }],
      ["Testus mexicanus", { global: false, regions: [{ region: "Mexico", season: null }] }],
    ]);
    expect(isEbirdSensitiveAt("Testus avis", null, list)).toBe(true);
    expect(isEbirdSensitiveAt("Testus avis", at("", ""), list)).toBe(true);
    // Only the country is known, and the area is inside it.
    expect(isEbirdSensitiveAt("Testus avis", CANADA, list)).toBe(true);
    expect(isEbirdSensitiveAt("Testus avis", at("Canada", "CA", "Ontario"), list)).toBe(true);
    expect(isEbirdSensitiveAt("Testus avis", at("Canada", "CA", "Quebec"), list)).toBe(false);
    expect(isEbirdSensitiveAt("Testus avis", at("United States", "US", "Ontario"), list)).toBe(false);
    expect(isEbirdSensitiveAt("Testus mexicanus", at("Mexico", "MX", "Jalisco"), list)).toBe(true);
    expect(isEbirdSensitiveAt("Testus mexicanus", at("Canada", "CA", "Ontario"), list)).toBe(false);
  });

  it("matches an eBird area through the group a province is listed under", () => {
    const list = new Map<string, SensitiveScope>([
      ["Testus avis", { global: false, regions: [{ region: "England-GB", season: null }] }],
    ]);
    expect(isEbirdSensitiveAt("Testus avis", at("United Kingdom", "GB", "Kent", "England - South East"), list)).toBe(
      true,
    );
    expect(isEbirdSensitiveAt("Testus avis", at("United Kingdom", "GB", "Fife", "Scotland"), list)).toBe(false);
  });
});
