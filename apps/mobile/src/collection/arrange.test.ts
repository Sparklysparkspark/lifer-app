import { describe, expect, it } from "vitest";
import type { CollectionSpecies } from "../store/browse";
import { filterSpecies, groupSpecies, sortSpecies } from "./arrange";
import { DEFAULT_VIEW } from "./model";

const sp = (
  scientificName: string,
  commonName: string | null,
  o: Partial<CollectionSpecies> = {},
): CollectionSpecies => ({
  scientificName,
  commonName,
  taxonClass: "aves",
  tier: null,
  sensitive: false,
  status: "none",
  isTarget: false,
  photos: 0,
  coverPhotoId: null,
  lastTakenAt: null,
  vagrant: false,
  ...o,
});
const rows = [
  sp("Bubo scandiacus", "Snowy Owl", { tier: "legendary", status: "photographed" }),
  sp("Aix sponsa", "Wood Duck", { tier: "common", status: "seen" }),
  sp("Ursus americanus", "Black Bear", { taxonClass: "mammalia", isTarget: true, vagrant: true }),
  sp("Turdus merula", null),
];

describe("filterSpecies", () => {
  it("applies Show, rarity, vagrants and year", () => {
    expect(filterSpecies(rows, { ...DEFAULT_VIEW, show: "photographed" }, null).map((r) => r.commonName)).toEqual([
      "Snowy Owl",
    ]);
    expect(filterSpecies(rows, { ...DEFAULT_VIEW, show: "targets" }, null)).toHaveLength(1);
    expect(filterSpecies(rows, { ...DEFAULT_VIEW, show: "unseen" }, null)).toHaveLength(2);
    expect(filterSpecies(rows, { ...DEFAULT_VIEW, tiers: ["legendary", "common"] }, null)).toHaveLength(2);
    expect(filterSpecies(rows, { ...DEFAULT_VIEW, vagrants: false }, null)).toHaveLength(3);
    expect(filterSpecies(rows, { ...DEFAULT_VIEW, year: "2026" }, new Set(["Aix sponsa"]))).toHaveLength(1);
  });
});

describe("sortSpecies", () => {
  it("orders by name, falling back to the scientific name", () => {
    expect(sortSpecies(rows, "common").map((r) => r.scientificName)).toEqual([
      "Ursus americanus",
      "Bubo scandiacus",
      "Turdus merula",
      "Aix sponsa",
    ]);
  });
  it("puts the rarest first when arranged by rarity, and photographed or targets first on request", () => {
    expect(sortSpecies(rows, "rarity")[0].tier).toBe("legendary");
    expect(sortSpecies(rows, "photographedFirst")[0].status).toBe("photographed");
    expect(sortSpecies(rows, "targetsFirst")[0].isTarget).toBe(true);
    expect(sortSpecies(rows, "seenFirst")[0].status).toBe("seen");
  });
});

describe("groupSpecies", () => {
  it("splits into broad groups in a fixed order, counting photographed against all of the group", () => {
    const s = groupSpecies(rows, rows);
    expect(s.map((x) => x.group)).toEqual(["birds", "mammals"]);
    expect(s[0]).toMatchObject({ photographed: 1, total: 3 });
  });
  it("counts against the whole region even when filtered", () => {
    const s = groupSpecies(rows.slice(0, 1), rows);
    expect(s[0]).toMatchObject({ photographed: 1, total: 3 });
  });
});
