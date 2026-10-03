// The tier ladder against anchor species, with realistic record counts, plus the rules that keep
// it absolute: no species is rated against the others on its list, thin data gives no tier, and
// traits never outweigh overwhelming evidence.
import { describe, expect, it } from "vitest";
import { seasonWindow, tierFromInputs, tierGroupForGbifClass, tierGroupForTaxonClass, THIN_EFFORT_RECORDS } from "./local-tier-model.js";

const CR_BIRD_EFFORT = 4_000_000;
const CR_HERP_EFFORT = 120_000;
const CA_MAMMAL_EFFORT = 600_000;
const US_BIRD_EFFORT = 60_000_000;

describe("tierFromInputs anchors", () => {
  it("Scarlet Macaw is common in Costa Rica", () => {
    const r = tierFromInputs({ taxonClass: "aves", records: 96_000, effort: CR_BIRD_EFFORT, concentrationRatio: 0.6, recentDistinctYears: 15 });
    expect(r.tier).toBe("common");
  });

  it("Keel-billed Toucan is common in Costa Rica", () => {
    const r = tierFromInputs({ taxonClass: "aves", records: 146_000, effort: CR_BIRD_EFFORT, concentrationRatio: 0.7, recentDistinctYears: 15 });
    expect(r.tier).toBe("common");
  });

  it("Green Basilisk is common in Costa Rica", () => {
    const r = tierFromInputs({ taxonClass: "squamata", records: 3_900, effort: CR_HERP_EFFORT, concentrationRatio: 0.6, recentDistinctYears: 15 });
    expect(r.tier).toBe("common");
  });

  it("Red-eyed Treefrog stays common in Costa Rica even though it's nocturnal", () => {
    const r = tierFromInputs({
      taxonClass: "amphibia",
      records: 6_200,
      effort: CR_HERP_EFFORT,
      concentrationRatio: 0.5,
      recentDistinctYears: 15,
      traits: { nocturnal: true },
    });
    expect(r.tier).toBe("common");
    expect(r.explain?.guard).toBe(true);
  });

  it("a rarely recorded, concentrated, endangered bird is legendary (Whooping Crane across the whole US)", () => {
    const r = tierFromInputs({
      taxonClass: "aves",
      records: 3_000,
      effort: US_BIRD_EFFORT,
      concentrationRatio: 0.05,
      recentDistinctYears: 15,
      traits: { iucnStatus: "EN" },
    });
    expect(r.tier).toBe("legendary");
  });

  it("discounts photos of a sought-after mammal: a Wolverine in British Columbia is Legendary", () => {
    // 65 photos against the province's top five mammals averaging 4,000, with far more interest.
    const bc = { taxonClass: "mammalia", records: null, effort: null, inatEffort: 134_586, referencePhotos: 4000, referenceInterest: 50_000 };
    expect(tierFromInputs({ ...bc, inatRecords: 65, interest: 1_100_000 }).tier).toBe("legendary");
  });

  it("rates a species people seek out below a plain one with the same photos", () => {
    const place = { taxonClass: "mammalia", records: null, effort: null, inatEffort: 100_000, inatRecords: 900, referencePhotos: 2000, referenceInterest: 30_000 };
    const plain = tierFromInputs({ ...place, interest: 30_000 });
    const sought = tierFromInputs({ ...place, interest: 400_000 });
    expect(plain.tier).toBe("occasional");
    expect(["uncommon", "rare"]).toContain(sought.tier);
  });

  it("leaves the tier alone for conservation status: that's shown beside it, not folded in", () => {
    const base = { taxonClass: "aves", records: 14_500, effort: 60_000_000, recentDistinctYears: 15 };
    expect(tierFromInputs({ ...base, traits: { iucnStatus: "endangered" } }).tier).toBe(tierFromInputs({ ...base, traits: {} }).tier);
  });

  it("rates birds against the place's most-reported birds: Mallard common, Great Blue Heron not", () => {
    // British Columbia: top five birds average about 30 per 1,000 bird records.
    const bc = { taxonClass: "aves", effort: 1_000_000, referenceRecords: 30_000, recentDistinctYears: 15 };
    expect(tierFromInputs({ ...bc, records: 24_700 }).tier).toBe("common");
    expect(tierFromInputs({ ...bc, records: 12_100 }).tier).toBe("occasional");
    expect(tierFromInputs({ ...bc, records: 12_100 }).explain?.relative).toBeCloseTo(0.4, 1);
  });

  it("doesn't dilute a species-rich place's everyday birds", () => {
    // Costa Rica: Great Kiskadee at 21.5 per 1,000, with the top five averaging 19.
    const r = tierFromInputs({ taxonClass: "aves", records: 21_500, effort: 1_000_000, referenceRecords: 19_000, recentDistinctYears: 15 });
    expect(r).toMatchObject({ tier: "common" });
  });

  it("Wolverine is legendary in Canada", () => {
    const r = tierFromInputs({
      taxonClass: "mammalia",
      records: 300,
      effort: CA_MAMMAL_EFFORT,
      concentrationRatio: 0.5,
      recentDistinctYears: 15,
      traits: { densityPerKm2: 0.005, homeRangeKm2: 900 },
    });
    expect(r.tier).toBe("legendary");
  });
});

describe("tierFromInputs rules", () => {
  it("gives no tier when the group has too few records in the place", () => {
    const r = tierFromInputs({ taxonClass: "aves", records: 50, effort: THIN_EFFORT_RECORDS - 1 });
    expect(r.tier).toBeNull();
    expect(r.reason).toBe("thin_data");
  });

  it("leaves marine invertebrates untiered", () => {
    expect(tierFromInputs({ taxonClass: "corals", records: 100, effort: 10_000 }).reason).toBe("untiered_group");
  });

  it("doesn't rate domestic animals", () => {
    expect(tierFromInputs({ taxonClass: "mammalia", records: 9_000, effort: 50_000, traits: { domestic: true } }).reason).toBe("domestic");
  });

  it("makes a vagrant legendary", () => {
    const r = tierFromInputs({ taxonClass: "aves", records: 30, effort: CR_BIRD_EFFORT, isVagrant: true });
    expect(r).toMatchObject({ tier: "legendary", reason: "vagrant" });
  });

  it("rates an established introduced species on its records instead of as a vagrant", () => {
    const r = tierFromInputs({ taxonClass: "aves", records: 40_000, effort: CR_BIRD_EFFORT, recentDistinctYears: 15, isVagrant: true });
    expect(r.reason).toBe("rated");
    expect(r.tier).toBe("common");
  });

  it("rates mammals on research-grade photos when the place has enough of them", () => {
    const r = tierFromInputs({ taxonClass: "mammalia", records: 90_000, effort: CA_MAMMAL_EFFORT, inatRecords: 4_000, inatEffort: 100_000 });
    expect(r.tier).toBe("common");
    expect(r.explain?.source).toBe("inat");
  });

  it("rates birds on sightings (eBird checklists), not on how often people photograph them", () => {
    const r = tierFromInputs({ taxonClass: "aves", records: 90_000, effort: CR_BIRD_EFFORT, inatRecords: 3, inatEffort: 100_000 });
    expect(r.explain?.source).toBe("gbif");
    expect(r.tier).toBe("common");
  });

  it("falls back to GBIF records where the place has few photos of the group", () => {
    const r = tierFromInputs({ taxonClass: "mammalia", records: 9_000, effort: CA_MAMMAL_EFFORT, inatRecords: 3, inatEffort: 200 });
    expect(r.explain?.source).toBe("gbif");
  });

  it("makes a species nobody has photographed in a well-photographed place legendary, if people look for it", () => {
    const r = tierFromInputs({ taxonClass: "mammalia", records: 40, effort: CA_MAMMAL_EFFORT, inatRecords: 0, inatEffort: 500_000, interest: 150_000 });
    expect(r).toMatchObject({ tier: "legendary", reason: "rated" });
    expect(r.explain?.rate).toBe(0);
  });

  it("doesn't rate a species few people care about as hard from a few photos", () => {
    const r = tierFromInputs({ taxonClass: "mammalia", records: 40, effort: CA_MAMMAL_EFFORT, inatRecords: 2, inatEffort: 500_000, interest: 800 });
    expect(r).toMatchObject({ tier: null, reason: "few_photos" });
  });

  it("still rates a species few people care about when its photos show it's easy", () => {
    const r = tierFromInputs({ taxonClass: "mammalia", records: null, effort: null, inatRecords: 8_000, inatEffort: 500_000, interest: 800 });
    expect(r).toMatchObject({ tier: "common", reason: "rated" });
  });

  it("doesn't count a thinly recorded species' clumped records as a second reason it's rare", () => {
    const r = tierFromInputs({ taxonClass: "aves", records: 12, effort: CR_BIRD_EFFORT, concentrationRatio: 0.01, recentDistinctYears: 2 });
    expect(r.explain?.steps).toEqual([]);
  });

  it("caps trait steps at two", () => {
    const r = tierFromInputs({
      taxonClass: "mammalia",
      records: 5_000,
      effort: 1_000_000,
      traits: { nocturnal: true, densityPerKm2: 0.01, homeRangeKm2: 1000 },
    });
    // rate 5 is occasional; three trait signals add two tiers, not three.
    expect(r.explain?.base).toBe("occasional");
    expect(r.tier).toBe("rare");
  });

  it("files marine mammals with fish", () => {
    expect(tierGroupForTaxonClass("actinopterygii")).toBe("fish");
    expect(tierGroupForGbifClass("Mammalia", "Cetacea")).toBe("fish");
    expect(tierGroupForGbifClass("Mammalia", "Carnivora")).toBe("mammals");
  });
});

describe("tierFromInputs on photos", () => {
  it("doesn't step a well-photographed species up again for being nocturnal", () => {
    const r = tierFromInputs({ taxonClass: "mammalia", records: null, effort: null, inatRecords: 15_000, inatEffort: 600_000, traits: { nocturnal: true, densityPerKm2: 0.01 } });
    expect(r.tier).toBe("common");
    expect(r.explain?.steps).toEqual([]);
  });
});

describe("seasonWindow", () => {
  it("finds a summer migrant's weeks", () => {
    const weekly = Array.from({ length: 52 }, (_, i) => (i >= 16 && i < 36 ? 10 : 0));
    expect(seasonWindow(weekly)).toMatchObject({ startWeek: 17, weeks: 16 });
  });

  it("wraps around the new year", () => {
    const weekly = Array.from({ length: 52 }, (_, i) => (i >= 46 || i < 6 ? 10 : 0));
    const w = seasonWindow(weekly)!;
    expect(w.startWeek).toBeGreaterThan(40);
    expect(w.endWeek).toBeLessThan(10);
  });

  it("returns nothing for a year-round resident", () => {
    expect(seasonWindow(Array.from({ length: 52 }, () => 5))).toBeNull();
  });
});
