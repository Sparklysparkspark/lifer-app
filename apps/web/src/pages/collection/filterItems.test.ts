import { describe, expect, it } from "vitest";
import type { CollectionItem } from "@lifer/shared";
import { filterCollectionItems, normalizeSearchText, searchHaystack } from "./filterItems";

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

  it("normalizes", () => {
    expect(normalizeSearchText("  Émeraude  -- vert ")).toBe("emeraude vert");
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
