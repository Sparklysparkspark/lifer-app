import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extinctReason,
  majorityClassByOrder,
  parseFixes,
  parsePasses,
  PASSES,
  pickInatIds,
  regionEbirdLists,
  unlistedBirds,
} from "./fix-catalog-audit.js";

const FIXES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "data",
  "reference",
  "catalog-audit-fixes.json",
);

describe("parseFixes", () => {
  it("accepts the shipped fixes file", () => {
    const fixes = parseFixes(JSON.parse(readFileSync(FIXES, "utf8")));
    expect(fixes.renames.map((r) => r.to)).toContain("Urobatis halleri");
    expect(fixes.merges).toContain("Urobatis sloani");
  });

  it("refuses an entry without a reason or an override that sets nothing", () => {
    const empty = {
      merges: [],
      renames: [],
      wrongCommonNames: [],
      replacedNames: [],
      rangeExclusions: [],
      flagOverrides: [],
      basinAllow: [],
      seaLinks: [],
      additions: [],
    };
    expect(() => parseFixes({ ...empty, renames: [{ from: "A a", to: "B a" }] })).toThrow(/reason/);
    expect(() =>
      parseFixes({ ...empty, flagOverrides: [{ scientificName: "A a", country: "BLZ", reason: "x" }] }),
    ).toThrow(/sets nothing/);
    expect(() => parseFixes({ ...empty, basinAllow: undefined })).toThrow(/basinAllow/);
    expect(() =>
      parseFixes({ ...empty, additions: [{ scientificName: "A a", country: "Belize", source: "x", reason: "x" }] }),
    ).toThrow(/bad country/);
  });
});

describe("parsePasses", () => {
  it("runs every pass in order by default and the named ones in pipeline order otherwise", () => {
    expect(parsePasses([])).toEqual([...PASSES]);
    expect(parsePasses(["--passes=sea-basins,names"])).toEqual(["names", "sea-basins"]);
    expect(() => parsePasses(["--passes=nope"])).toThrow(/Unknown pass/);
  });
});

describe("majorityClassByOrder", () => {
  it("names the class most of a mixed order has, and skips ties and single-class orders", () => {
    const out = majorityClassByOrder([
      { order: "Artiodactyla", cls: "mammalia", n: 442 },
      { order: "Artiodactyla", cls: "actinopterygii", n: 99 },
      { order: "Sirenia", cls: "mammalia", n: 5 },
      { order: "Sirenia", cls: "actinopterygii", n: 4 },
      { order: "Tied", cls: "a", n: 2 },
      { order: "Tied", cls: "b", n: 2 },
      { order: "Passeriformes", cls: "aves", n: 6000 },
    ]);
    expect(Object.fromEntries(out)).toEqual({ Artiodactyla: "mammalia", Sirenia: "mammalia" });
  });
});

describe("regionEbirdLists", () => {
  it("unions provinces into their group and country, and knows nothing when one province is missing", () => {
    const files: Record<string, string[]> = { "ZZ-A": ["aaa"], "ZZ-B": ["bbb"], "YY-A": ["ccc"] };
    const lists = regionEbirdLists(
      [
        { id: "a", code: "ZZ-A", parents: ["zz", "g"] },
        { id: "b", code: "ZZ-B", parents: ["zz", "g"] },
        { id: "c", code: "YY-A", parents: ["yy"] },
        { id: "d", code: null, parents: ["yy"] },
      ],
      (code) => files[code] ?? null,
    );
    expect([...lists.get("zz")!].sort()).toEqual(["aaa", "bbb"]);
    expect([...lists.get("g")!].sort()).toEqual(["aaa", "bbb"]);
    expect([...lists.get("c")!]).toEqual(["ccc"]);
    expect(lists.get("d")).toBeNull();
    expect(lists.get("yy")).toBeNull();
  });
});

describe("pickInatIds", () => {
  it("takes the one active animal species of a name and skips ambiguous, inactive or non-animal ones", () => {
    const t = (id: number, name: string, active = true, rank = "species", ancestry = "48460/1/2") => ({
      id,
      name,
      active,
      rank,
      ancestry,
    });
    const picked = pickInatIds([
      t(1, "Aus bus"),
      t(2, "Aus cus", false),
      t(3, "Aus dus"),
      t(4, "Aus dus"),
      t(5, "Aus eus", true, "species", "48460/47126/1"),
      t(6, "Aus fus", true, "subspecies"),
      t(7, "Aus gus"),
    ]);
    expect(Object.fromEntries(picked)).toEqual({ "Aus bus": 1, "Aus gus": 7 });
  });
});

describe("unlistedBirds", () => {
  const lists = new Map<string, Set<string> | null>([
    ["full", new Set(["a", "b", "c"])],
    ["patchy", new Set(["a"])],
    ["unknown", null],
  ]);
  const known = new Set(["a", "b", "c", "x"]);
  const well = new Map([
    ["full", ["a", "b", "c"]],
    ["patchy", ["a", "b", "c"]],
    ["unknown", ["a", "b", "c"]],
  ]);
  it("drops a thin bird only where eBird's list is near complete, and never for a stale code", () => {
    const thin = [
      { region_id: "full", code: "x" },
      { region_id: "full", code: "a" },
      { region_id: "full", code: "stale" },
      { region_id: "patchy", code: "x" },
      { region_id: "unknown", code: "x" },
    ];
    expect(unlistedBirds(thin, well, lists, known, 3)).toEqual([{ region_id: "full", code: "x" }]);
    // Too few well-recorded birds to judge the list.
    expect(unlistedBirds(thin, well, lists, known, 4)).toEqual([]);
  });
});

describe("extinctReason", () => {
  const bird = {
    scientific_name: "Anas fossilis",
    taxon_class: "aves",
    common_name: null,
    ebird_code: null,
    gbif_key: "1",
  };
  const none = { ebirdByName: new Map(), ebirdByCode: new Map(), profile: () => null, recent: () => null };
  const known = {
    sci: "Anas fossilis",
    common: "Fossil Duck",
    code: "fosduc1",
    category: "species",
    family: "",
    order: "",
    extinct: false,
    reportAs: "",
  };

  it("hides a nameless bird eBird doesn't know, but not one it does or one with a name", () => {
    expect(extinctReason(bird, none)).toMatch(/fossil or a retired name/);
    expect(extinctReason(bird, { ...none, ebirdByName: new Map([[bird.scientific_name, known]]) })).toBeNull();
    expect(extinctReason({ ...bird, common_name: "Fossil Duck" }, none)).toBeNull();
    expect(extinctReason({ ...bird, taxon_class: "actinopterygii" }, none)).toBeNull();
  });

  it("follows eBird's extinct flag", () => {
    const lost = { ...known, extinct: true };
    expect(
      extinctReason(
        { ...bird, common_name: "Fossil Duck" },
        { ...none, ebirdByName: new Map([[bird.scientific_name, lost]]) },
      ),
    ).toMatch(/eBird/);
    // An old name eBird has moved, matched by its code.
    expect(
      extinctReason(
        { ...bird, scientific_name: "Porzana fossilis", common_name: "Fossil Duck", ebird_code: "fosduc1" },
        { ...none, ebirdByCode: new Map([["fosduc1", lost]]) },
      ),
    ).toMatch(/eBird/);
  });

  it("needs a taxonomic source, no source saying extant, and no recent observation", () => {
    const fish = { ...bird, taxon_class: "actinopterygii", common_name: "Old Fish" };
    const ev = (extinct: string[], extant: string[], recent: number | null) => ({
      ...none,
      profile: () => ({ extinct, extant }),
      recent: () => recent,
    });
    expect(extinctReason(fish, ev(["The Paleobiology Database"], [], 0))).toMatch(/Paleobiology/);
    expect(extinctReason(fish, ev(["The Paleobiology Database"], ["IUCN"], 0))).toBeNull();
    expect(extinctReason(fish, ev(["Some Checklist"], [], 0))).toBeNull();
    expect(extinctReason(fish, ev(["Catalogue of Life"], [], 3))).toBeNull();
    expect(extinctReason(fish, ev(["Catalogue of Life"], [], null))).toBeNull();
  });
});
