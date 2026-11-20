import { describe, expect, it } from "vitest";
import type { CollectionItem } from "@lifer/shared";
import {
  filterCollectionItems,
  normalizeSearchText,
  rankBySearch,
  searchHaystack,
  searchRanks,
  type ItemFilters,
} from "./filterItems";

function item(partial: Partial<CollectionItem> & { speciesId: string; scientificName: string }): CollectionItem {
  return {
    commonName: null,
    state: "unseen",
    isTarget: false,
    isGhost: false,
    isLost: false,
    seasonality: null,
    capturedYears: null,
    ...partial,
  } as CollectionItem;
}

const base = {
  stateFilter: "all" as const,
  introduced: "any" as const,
  endemic: "any" as const,
  vagrant: "any" as const,
  tiers: new Set<string>(),
  ghostOnly: false,
  lostOnly: false,
  likelyThisMonthOnly: false,
  yearFilter: "",
};

function search(items: CollectionItem[], q: string) {
  const haystacks = new Map(items.map((i) => [i.speciesId, searchHaystack(i)]));
  return filterCollectionItems(items, { ...base, search: q }, haystacks).map((i) => i.speciesId);
}

describe("collection search", () => {
  const items = [
    item({ speciesId: "a", commonName: "Black-capped Chickadee", scientificName: "Poecile atricapillus" }),
    item({ speciesId: "b", commonName: "Cooper's Hawk", scientificName: "Accipiter cooperii" }),
    item({ speciesId: "c", commonName: "Rüppell's Vulture", scientificName: "Gyps rueppelli" }),
  ];

  it("treats hyphens and spaces the same", () => {
    expect(search(items, "black capped")).toEqual(["a"]);
    expect(search(items, "Black-Capped")).toEqual(["a"]);
  });

  it("ignores accents and apostrophes", () => {
    expect(search(items, "ruppells")).toEqual(["c"]);
    expect(search(items, "coopers")).toEqual(["b"]);
  });

  it("matches scientific names and aliases", () => {
    expect(search(items, "poecile")).toEqual(["a"]);
    const withAlias = [{ ...items[0], aliases: ["BCCH"] } as CollectionItem];
    expect(search(withAlias, "bcch")).toEqual(["a"]);
  });

  it("matches word starts and plurals, not letters inside a word", () => {
    expect(search(items, "pil")).toEqual([]); // not atricaPILlus
    expect(search(items, "hawks")).toEqual(["b"]);
    expect(search(items, "chickadee hawk")).toEqual([]); // every word in the same name
  });

  it("matches compound names by the end of their last word", () => {
    const fish = [
      item({ speciesId: "sting", commonName: "Southern Stingray", scientificName: "Hypanus americanus" }),
      item({ speciesId: "yellow", commonName: "Yellow Stingray", scientificName: "Urobatis jamaicensis" }),
      item({ speciesId: "gray", commonName: "Gray Jay", scientificName: "Perisoreus canadensis" }),
      item({ speciesId: "gos", commonName: "Northern Goshawk", scientificName: "Astur atricapillus" }),
    ];
    expect(search(fish, "ray")).toEqual(["sting", "yellow"]); // not Gray Jay
    expect(search(fish, "rays")).toEqual(["sting", "yellow"]);
    expect(search(fish, "southern ray")).toEqual(["sting"]);
    expect(search(fish, "hawk")).toEqual(["gos"]);
    expect(search(fish, "ay")).toEqual([]);
    // Scientific names only match from a word start: no "-ensis" or atricaPILlus.
    expect(search(fish, "ensis")).toEqual([]);
    expect(search(fish, "pil")).toEqual([]);
    expect(search(fish, "urob")).toEqual(["yellow"]);
  });

  it("normalizes", () => {
    expect(normalizeSearchText("  Émeraude  -- vert ")).toBe("emeraude vert");
  });
});

describe("search ranking", () => {
  // In the order the sort control left them.
  const fish = [
    item({ speciesId: "sting", commonName: "Southern Stingray", scientificName: "Hypanus americanus" }),
    item({ speciesId: "rayfin", commonName: "Rayfin Darter", scientificName: "Etheostoma x" }),
    item({ speciesId: "manta", commonName: "Giant Manta Ray", scientificName: "Mobula birostris" }),
    item({ speciesId: "eagle", commonName: "Spotted Eagle Ray", scientificName: "Aetobatus narinari" }),
    item({ speciesId: "yellow", commonName: "Yellow Stingray", scientificName: "Urobatis jamaicensis" }),
  ];
  const haystacks = new Map(fish.map((i) => [i.speciesId, searchHaystack(i)]));
  const ranked = (q: string) => {
    const found = filterCollectionItems(fish, { ...base, search: q }, haystacks);
    return rankBySearch(found, searchRanks(found, q, haystacks)).map((i) => i.speciesId);
  };

  it("puts exact words first, then word starts, then compound endings, keeping order within each", () => {
    expect(ranked("ray")).toEqual(["manta", "eagle", "rayfin", "sting", "yellow"]);
  });

  it("leaves the sort order alone with no search", () => {
    expect(searchRanks(fish, "  ", haystacks)).toBeNull();
    expect(rankBySearch(fish, null)).toBe(fish);
  });
});

describe("collection search by broad group", () => {
  const items = [
    item({
      speciesId: "hawk",
      commonName: "Cooper's Hawk",
      scientificName: "Accipiter cooperii",
      taxonClass: "aves",
      family: "Accipitridae",
    }),
    item({
      speciesId: "owl",
      commonName: "Great Horned Owl",
      scientificName: "Bubo virginianus",
      taxonClass: "aves",
      family: "Strigidae",
    }),
    item({
      speciesId: "robin",
      commonName: "American Robin",
      scientificName: "Turdus migratorius",
      taxonClass: "aves",
      family: "Turdidae",
      taxonOrder: "Passeriformes",
    }),
    item({
      speciesId: "frog",
      commonName: "Red-eyed Treefrog",
      scientificName: "Agalychnis callidryas",
      taxonClass: "amphibia",
      family: "Phyllomedusidae",
      taxonOrder: "Anura",
    }),
  ];

  it("finds every raptor, owls included, by the group's name", () => {
    expect(search(items, "raptor").sort()).toEqual(["hawk", "owl"]);
    expect(search(items, "owls")).toEqual(["owl"]);
  });

  it("finds groups set by order when the family isn't listed", () => {
    expect(search(items, "songbirds")).toEqual(["robin"]);
    expect(search(items, "frogs")).toEqual(["frog"]);
  });
});

describe("trait and tier filters", () => {
  const items = [
    item({ speciesId: "native", scientificName: "A a", introduced: false, endemic: true, tier: "common" }),
    item({ speciesId: "introduced", scientificName: "B b", introduced: true, endemic: false, tier: "rare" }),
    item({
      speciesId: "local",
      scientificName: "C c",
      introduced: false,
      endemic: false,
      tier: "common",
      localTier: "legendary",
    }),
  ];
  const ids = (filters: Partial<ItemFilters>) =>
    filterCollectionItems(items, { ...base, search: "", ...filters }, new Map()).map((i) => i.speciesId);

  it("keeps only, or hides, introduced and endemic species", () => {
    expect(ids({ introduced: "only" })).toEqual(["introduced"]);
    expect(ids({ introduced: "hide" })).toEqual(["native", "local"]);
    expect(ids({ endemic: "only" })).toEqual(["native"]);
    expect(ids({ endemic: "hide" })).toEqual(["introduced", "local"]);
  });

  it("matches the tier the card shows: the local one where there is one", () => {
    expect(ids({ tiers: new Set(["legendary"]) })).toEqual(["local"]);
    expect(ids({ tiers: new Set(["common"]) })).toEqual(["native"]);
    expect(ids({ tiers: new Set(["rare", "legendary"]) })).toEqual(["introduced", "local"]);
  });
});

describe("needs a better photo filter", () => {
  const items = [
    item({ speciesId: "a", scientificName: "A a", state: "collected", needsBetterPhoto: true }),
    item({ speciesId: "b", scientificName: "B b", state: "collected" }),
    item({ speciesId: "c", scientificName: "C c", state: "collected", needsBetterPhoto: false }),
  ];
  const run = (needsBetterOnly: boolean) =>
    filterCollectionItems(items, { ...base, needsBetterOnly, search: "" }, new Map()).map((i) => i.speciesId);

  it("keeps only marked species when on, and everything when off", () => {
    expect(run(true)).toEqual(["a"]);
    expect(run(false)).toEqual(["a", "b", "c"]);
  });
});

describe("taxon filter", () => {
  const items = [
    item({ speciesId: "bird", scientificName: "Poecile atricapillus", taxonClass: "aves" }),
    item({ speciesId: "moose", scientificName: "Alces alces", taxonClass: "mammalia" }),
    item({ speciesId: "unknown", scientificName: "Incertae sedis", taxonClass: null }),
  ];
  const run = (taxa?: ReadonlySet<string>) =>
    filterCollectionItems(items, { ...base, search: "", taxa }, new Map()).map((i) => i.speciesId);

  it("keeps only the chosen taxon classes", () => {
    expect(run(new Set(["mammalia"]))).toEqual(["moose"]);
    expect(run(new Set(["aves", "mammalia"]))).toEqual(["bird", "moose"]);
  });

  it("keeps everything when none is chosen", () => {
    expect(run()).toEqual(["bird", "moose", "unknown"]);
    expect(run(new Set())).toEqual(["bird", "moose", "unknown"]);
  });
});

describe("target list filter", () => {
  const items = [
    item({ speciesId: "a", scientificName: "A a", isTarget: true }),
    item({ speciesId: "b", scientificName: "B b", isTarget: true }),
    item({ speciesId: "c", scientificName: "C c" }),
  ];
  const run = (targetListSpecies: ReadonlySet<string> | null) =>
    filterCollectionItems(items, { ...base, stateFilter: "target", search: "", targetListSpecies }, new Map()).map(
      (i) => i.speciesId,
    );

  it("shows every target, or only the targets on the chosen list", () => {
    expect(run(null)).toEqual(["a", "b"]);
    expect(run(new Set(["b", "c"]))).toEqual(["b"]);
  });
});

describe("photos taken filter", () => {
  const items = [
    item({ speciesId: "here", scientificName: "A a", state: "collected", photographedWhere: "here" }),
    item({ speciesId: "away", scientificName: "B b", state: "collected", photographedWhere: "elsewhere" }),
    // Photographed, but no photo has a location: only under Anywhere.
    item({ speciesId: "nogps", scientificName: "F f", state: "collected", photographedWhere: null }),
    item({ speciesId: "seen", scientificName: "C c", state: "seen", photographedWhere: null }),
    item({ speciesId: "none", scientificName: "D d", state: "unseen", photographedWhere: null }),
    // A row with no value (not a region checklist) is never narrowed.
    item({ speciesId: "noflag", scientificName: "E e", state: "collected" }),
  ];
  const run = (photosTaken: ItemFilters["photosTaken"], stateFilter: ItemFilters["stateFilter"] = "all") =>
    filterCollectionItems(items, { ...base, stateFilter, photosTaken, search: "" }, new Map()).map((i) => i.speciesId);

  it("keeps everything by default", () => {
    const all = ["here", "away", "nogps", "seen", "none", "noflag"];
    expect(run(undefined)).toEqual(all);
    expect(run("anywhere")).toEqual(all);
  });

  it("narrows only photographed species, leaving the rest to the Show filter", () => {
    expect(run("here")).toEqual(["here", "seen", "none", "noflag"]);
    expect(run("elsewhere")).toEqual(["away", "seen", "none", "noflag"]);
  });

  it("combines with Show Photographed", () => {
    expect(run("here", "collected")).toEqual(["here", "noflag"]);
    expect(run("elsewhere", "collected")).toEqual(["away", "noflag"]);
    expect(run("elsewhere", "unseen")).toEqual(["none"]);
  });

  it("works with search", () => {
    const haystacks = new Map(items.map((i) => [i.speciesId, searchHaystack(i)]));
    const ids = filterCollectionItems(items, { ...base, photosTaken: "elsewhere", search: "b b" }, haystacks);
    expect(ids.map((i) => i.speciesId)).toEqual(["away"]);
    expect(filterCollectionItems(items, { ...base, photosTaken: "here", search: "b b" }, haystacks)).toEqual([]);
  });
});
