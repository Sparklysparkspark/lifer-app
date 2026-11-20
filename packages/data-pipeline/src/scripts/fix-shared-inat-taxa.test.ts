import { describe, expect, it } from "vitest";
import {
  mergeRows,
  planGroup,
  sameNameVariant,
  type Group,
  type Lookups,
  type Member,
} from "./fix-shared-inat-taxa.js";

const member = (id: string, name: string, extra: Partial<Member> = {}): Member => ({
  id,
  name,
  commonName: null,
  taxonClass: "aves",
  ebirdCode: null,
  occurrences: 0,
  synonyms: [],
  photos: ["https://x/fox.jpg"],
  description: "Fox Sparrow text",
  ...extra,
});

const lookups = (extra: Partial<Lookups> = {}): Lookups => ({
  inatName: new Map([[9156, "Passerella iliaca"]]),
  ownInat: new Map(),
  heldBy: new Map(),
  ebirdSpecies: new Set(["Passerella iliaca"]),
  ebirdForms: new Map([["Passerella unalaschcensis", "foxspa"]]),
  col: new Map(),
  ...extra,
});

const byName = (g: Group, lk: Lookups) => Object.fromEntries(planGroup(g, lk).map((d) => [d.name, d]));

describe("planGroup for birds", () => {
  const fox: Group = {
    inatTaxonId: 9156,
    members: [
      member("a", "Passerella iliaca", { ebirdCode: "foxspa", occurrences: 10 }),
      member("b", "Passerella unalaschcensis", { occurrences: 50 }),
    ],
  };

  it("folds an eBird group into the species eBird reports it as", () => {
    const d = byName(fox, lookups());
    expect(d["Passerella iliaca"]).toMatchObject({ action: "keep", category: "owner" });
    expect(d["Passerella unalaschcensis"]).toMatchObject({ action: "merge", category: "a_merge", intoId: "a" });
  });

  it("keeps a species eBird accepts apart, without the link or the photos it borrowed", () => {
    const d = byName(fox, lookups({ ebirdSpecies: new Set(["Passerella iliaca", "Passerella unalaschcensis"]) }));
    expect(d["Passerella unalaschcensis"]).toMatchObject({
      action: "unlink",
      category: "a_keep",
      borrowedPhotos: ["https://x/fox.jpg"],
      borrowedDescription: true,
    });
  });

  it("moves a species to the iNaturalist taxon named exactly as it is", () => {
    const d = byName(fox, lookups({ ownInat: new Map([["Passerella unalaschcensis", 777]]) }));
    expect(d["Passerella unalaschcensis"]).toMatchObject({ action: "relink", category: "b", newInatTaxonId: 777 });
    expect(d["Passerella iliaca"].action).toBe("keep");
  });

  it("never moves a species onto a taxon another species holds", () => {
    const d = byName(
      fox,
      lookups({ ownInat: new Map([["Passerella unalaschcensis", 777]]), heldBy: new Map([[777, "z"]]) }),
    );
    expect(d["Passerella unalaschcensis"]).toMatchObject({ action: "unlink", category: "review" });
  });

  it("lets the one eBird species own the taxon even when iNaturalist names it differently", () => {
    const g: Group = {
      inatTaxonId: 1,
      members: [
        member("a", "Piranga hepatica", { occurrences: 99 }),
        member("b", "Piranga flava", { ebirdCode: "heptan" }),
      ],
    };
    const d = byName(
      g,
      lookups({
        inatName: new Map([[1, "Piranga hepatica"]]),
        ebirdSpecies: new Set(["Piranga flava"]),
        ebirdForms: new Map([["Piranga hepatica", "heptan"]]),
      }),
    );
    expect(d["Piranga flava"].action).toBe("keep");
    expect(d["Piranga hepatica"]).toMatchObject({ action: "merge", category: "a_merge", intoId: "b" });
  });
});

describe("planGroup for other animals", () => {
  const fish = (a: Partial<Member>, b: Partial<Member>): Group => ({
    inatTaxonId: 5,
    members: [
      member("a", "Astyanax mexicanus", { taxonClass: "actinopterygii", ...a }),
      member("b", "Astyanax jordani", { taxonClass: "actinopterygii", ...b }),
    ],
  });
  const lk = (col: Lookups["col"]) => lookups({ inatName: new Map([[5, "Astyanax mexicanus"]]), col });

  it("merges a Catalogue of Life synonym of the owner", () => {
    const d = byName(
      fish({}, {}),
      lk(
        new Map([
          ["Astyanax mexicanus", { status: "accepted", accepted: "Astyanax mexicanus" }],
          ["Astyanax jordani", { status: "synonym", accepted: "Astyanax mexicanus" }],
        ]),
      ),
    );
    expect(d["Astyanax jordani"]).toMatchObject({ action: "merge", category: "c", intoName: "Astyanax mexicanus" });
  });

  it("keeps two species Catalogue of Life accepts apart, unlinking the one iNaturalist doesn't name", () => {
    const d = byName(
      fish({}, { photos: ["https://x/own.jpg"], description: null }),
      lk(
        new Map([
          ["Astyanax mexicanus", { status: "accepted", accepted: "Astyanax mexicanus" }],
          ["Astyanax jordani", { status: "accepted", accepted: "Astyanax jordani" }],
        ]),
      ),
    );
    expect(d["Astyanax mexicanus"].action).toBe("keep");
    expect(d["Astyanax jordani"]).toMatchObject({ action: "unlink", category: "a_keep", borrowedPhotos: [] });
  });

  it("merges a respelling even when Catalogue of Life accepts both spellings", () => {
    const g: Group = {
      inatTaxonId: 7,
      members: [
        member("a", "Ephalophis greyae", { taxonClass: "squamata" }),
        member("b", "Ephalophis greyi", { taxonClass: "squamata" }),
      ],
    };
    const d = byName(
      g,
      lookups({
        inatName: new Map([[7, "Ephalophis greyae"]]),
        col: new Map([["Ephalophis greyi", { status: "accepted", accepted: "Ephalophis greyi" }]]),
      }),
    );
    // The spelling GBIF's downloads use survives.
    expect(d["Ephalophis greyi"].action).toBe("keep");
    expect(d["Ephalophis greyae"]).toMatchObject({ action: "merge", category: "c", intoId: "b" });
  });

  it("sends a name Catalogue of Life doesn't know to review, unlinked", () => {
    const d = byName(fish({}, {}), lk(new Map([["Astyanax jordani", null]])));
    expect(d["Astyanax jordani"]).toMatchObject({ action: "unlink", category: "review" });
  });
});

describe("mergeRows", () => {
  it("writes species-merges.tsv rows only for species the file doesn't merge yet", () => {
    const g: Group = {
      inatTaxonId: 9156,
      members: [member("a", "Passerella iliaca", { ebirdCode: "foxspa" }), member("b", "Passerella unalaschcensis")],
    };
    const decisions = planGroup(g, lookups());
    expect(mergeRows(decisions, "")).toEqual([
      "b\tPasserella unalaschcensis\ta\tPasserella iliaca\tShared iNaturalist taxon 9156: eBird counts it as a group of Passerella iliaca",
    ]);
    expect(mergeRows(decisions, "b\tPasserella unalaschcensis\t...")).toEqual([]);
    // Being an earlier merge's target doesn't count as merged.
    expect(mergeRows(decisions, "z\tOld name\tb\tPasserella unalaschcensis\t...")).toHaveLength(1);
  });
});

describe("sameNameVariant", () => {
  it("matches Latin ending changes and genus moves, not different species of one genus", () => {
    expect(sameNameVariant("Ephalophis greyi", "Ephalophis greyae")).toBe(true);
    expect(sameNameVariant("Flammeo marianus", "Neoniphon marianus")).toBe(true);
    expect(sameNameVariant("Kyphosus pacificus", "Kyphosus sectatrix")).toBe(false);
  });
});

describe("retargetMerges", () => {
  it("sends a merge eBird files under another species there, and leaves the rest", async () => {
    const { retargetMerges } = await import("./fix-shared-inat-taxa.js");
    const base = { inatTaxonId: 17751, category: "c" as const, borrowedPhotos: [], borrowedDescription: false };
    const out = retargetMerges(
      [
        {
          ...base,
          speciesId: "a",
          name: "Picumnus nigropunctatus",
          action: "merge",
          intoId: "ex",
          intoName: "Picumnus exilis",
          reason: "x",
        },
        {
          ...base,
          speciesId: "b",
          name: "Larus bulleri",
          action: "merge",
          intoId: "cb",
          intoName: "Chroicocephalus bulleri",
          reason: "y",
        },
      ],
      new Map([["Picumnus squamulatus", "sq"]]),
    );
    expect(out.map((d) => [d.name, d.intoId, d.intoName])).toEqual([
      ["Picumnus nigropunctatus", "sq", "Picumnus squamulatus"],
      ["Larus bulleri", "cb", "Chroicocephalus bulleri"],
    ]);
  });
});
