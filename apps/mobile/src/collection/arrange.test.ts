import { describe, expect, it } from "vitest";
import type { CollectionSpecies } from "../store/browse";
import {
  countsAsPhotographed,
  filterSpecies,
  firstSpecies,
  groupSpecies,
  indexOfSpecies,
  sortSpecies,
} from "./arrange";
import { activeFilterCount, DEFAULT_VIEW, loadView } from "./model";

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
  localTier: null,
  localTierReason: null,
  worldTier: null,
  vagrant: false,
  needsBetterPhoto: false,
  taxonOrder: null,
  family: null,
  sortOrder: null,
  ...o,
});
const rows = [
  sp("Bubo scandiacus", "Snowy Owl", {
    tier: "legendary",
    status: "photographed",
    taxonOrder: "Strigiformes",
    family: "Strigidae",
    needsBetterPhoto: true,
  }),
  sp("Aix sponsa", "Wood Duck", { tier: "common", status: "seen", taxonOrder: "Anseriformes", family: "Anatidae" }),
  sp("Ursus americanus", "Black Bear", { taxonClass: "mammalia", isTarget: true, vagrant: true, family: "Ursidae" }),
  sp("Turdus merula", null, { status: "photographed", taxonOrder: "Passeriformes", family: "Turdidae" }),
];
const names = (r: CollectionSpecies[]) => r.map((x) => x.scientificName);

describe("filterSpecies", () => {
  it("applies Show, rarity (with Unrated for no tier), Needs a better photo and year", () => {
    expect(filterSpecies(rows, { ...DEFAULT_VIEW, show: "photographed" }, null)).toHaveLength(2);
    expect(filterSpecies(rows, { ...DEFAULT_VIEW, show: "targets" }, null)).toHaveLength(1);
    expect(filterSpecies(rows, { ...DEFAULT_VIEW, show: "unseen" }, null)).toHaveLength(1);
    expect(filterSpecies(rows, { ...DEFAULT_VIEW, tiers: ["legendary", "common"] }, null)).toHaveLength(2);
    expect(filterSpecies(rows, { ...DEFAULT_VIEW, tiers: ["unrated"] }, null)).toHaveLength(2);
    expect(names(filterSpecies(rows, { ...DEFAULT_VIEW, needsBetter: true }, null))).toEqual(["Bubo scandiacus"]);
    expect(filterSpecies(rows, { ...DEFAULT_VIEW, year: "2026" }, new Set(["Aix sponsa"]))).toHaveLength(1);
  });

  it("Vagrants: Any keeps all, Only keeps vagrants, Hide drops them", () => {
    expect(filterSpecies(rows, { ...DEFAULT_VIEW, vagrant: "any" }, null)).toHaveLength(4);
    expect(names(filterSpecies(rows, { ...DEFAULT_VIEW, vagrant: "only" }, null))).toEqual(["Ursus americanus"]);
    expect(filterSpecies(rows, { ...DEFAULT_VIEW, vagrant: "hide" }, null)).toHaveLength(3);
  });

  it("Photos taken narrows photographed species only; one with no placed photo counts only under Anywhere", () => {
    const places = new Map<string, "here" | "elsewhere">([["Bubo scandiacus", "here"]]);
    const here = filterSpecies(rows, { ...DEFAULT_VIEW, photosTaken: "here" }, null, places);
    expect(names(here)).toEqual(["Bubo scandiacus", "Aix sponsa", "Ursus americanus"]);
    expect(names(filterSpecies(rows, { ...DEFAULT_VIEW, photosTaken: "elsewhere" }, null, places))).toEqual([
      "Aix sponsa",
      "Ursus americanus",
    ]);
    expect(countsAsPhotographed(rows[3], "anywhere", places)).toBe(true);
    expect(countsAsPhotographed(rows[3], "here", places)).toBe(false);
  });
});

describe("the saved view", () => {
  it("an old Include vagrants switch turned off reads as Hide; filters are counted once each", () => {
    expect(loadView({ vagrants: false } as never).vagrant).toBe("hide");
    expect(loadView({ vagrants: true } as never).vagrant).toBe("any");
    expect(activeFilterCount({ ...DEFAULT_VIEW, vagrant: "only", photosTaken: "here", needsBetter: true })).toBe(3);
    expect(loadView({}).showRarityTags).toBe(true);
    expect(loadView({}).uncollectedColour).toBe(false);
  });
});

describe("sortSpecies", () => {
  it("orders by name, falling back to the scientific name", () => {
    expect(names(sortSpecies(rows, "common"))).toEqual([
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
  it("Field guide order: birds by order in the eBird sequence, then other classes", () => {
    expect(names(sortSpecies(rows, "fieldGuide"))).toEqual([
      "Aix sponsa",
      "Bubo scandiacus",
      "Turdus merula",
      "Ursus americanus",
    ]);
  });
});

describe("Field guide order within a family", () => {
  it("follows the hub's sort order, and falls back to scientific name without one", () => {
    const fam = { taxonOrder: "Anseriformes", family: "Anatidae" };
    const duck = [
      sp("Aix sponsa", "Wood Duck", { ...fam, sortOrder: 2 }),
      sp("Anas acuta", "Pintail", { ...fam, sortOrder: 1 }),
    ];
    expect(names(sortSpecies(duck, "fieldGuide"))).toEqual(["Anas acuta", "Aix sponsa"]);
    expect(
      names(
        sortSpecies(
          duck.map((d) => ({ ...d, sortOrder: null })),
          "fieldGuide",
        ),
      ),
    ).toEqual(["Aix sponsa", "Anas acuta"]);
  });
});

describe("groupSpecies", () => {
  it("splits into broad groups in a fixed order, counting photographed against all of the group", () => {
    const s = groupSpecies(rows, rows);
    expect(s.map((x) => x.group)).toEqual(["birds", "mammals"]);
    expect(s[0]).toMatchObject({ key: "birds", title: { key: "groups.birds" }, photographed: 2, total: 3 });
  });
  it("counts against the whole region even when filtered, and follows Photos taken", () => {
    expect(groupSpecies(rows.slice(0, 1), rows)[0]).toMatchObject({ photographed: 2, total: 3 });
    const onlyOwl = (r: CollectionSpecies) => r.scientificName === "Bubo scandiacus";
    expect(groupSpecies(rows, rows, "broad", onlyOwl)[0]).toMatchObject({ photographed: 1, total: 3 });
  });
  it("Family group: friendly bird names, the family for others, in field guide order with Other last", () => {
    const withUnknown = [...rows, sp("Corvus sp", "Crow", { family: null })];
    const s = groupSpecies(withUnknown, withUnknown, "family");
    expect(s.map((x) => x.title)).toEqual([
      { key: "familyGroups.waterfowl" },
      { key: "familyGroups.owls" },
      { key: "familyGroups.thrushes" },
      { name: "Ursidae" },
      { key: "familyGroups.other" },
    ]);
    expect(s[3].group).toBe("mammals");
  });
});

describe("keeping the place when the columns change", () => {
  it("finds the row that now holds the first visible species, not the old row number", () => {
    const two = [{ kind: "header" }, { rows: rows.slice(0, 2) }, { rows: rows.slice(2, 4) }];
    const three = [{ kind: "header" }, { rows: rows.slice(0, 3) }, { rows: rows.slice(3) }];
    const first = firstSpecies(two[2]);
    expect(first).toBe("Ursus americanus");
    expect(indexOfSpecies(three, first)).toBe(1);
    expect(indexOfSpecies([{ row: rows[3] }], "Turdus merula")).toBe(0);
    expect(indexOfSpecies(three, null)).toBe(-1);
    expect(firstSpecies(undefined)).toBeNull();
  });
});
