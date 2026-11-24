import { describe, expect, it } from "vitest";
import {
  collisions,
  mergeAliases,
  namesOnDisk,
  planNames,
  type InatName,
  type NameRow,
} from "./apply-inat-common-names.js";

let n = 0;
const row = (over: Partial<NameRow>): NameRow => ({
  id: `id${++n}`,
  scientific_name: `Testus ${n}`,
  common_name: null,
  common_name_aliases: null,
  taxon_class: "amphibia",
  inat_taxon_id: n,
  ...over,
});
const names = (entries: Array<[number, InatName]>) => new Map(entries);

describe("mergeAliases", () => {
  it("adds the old name after the existing aliases, once, and never the new name", () => {
    expect(mergeAliases(["Baudin's Treefrog", "mexican tree frog"], "Mexican Smilisca", "Mexican Tree Frog")).toEqual([
      "Baudin's Treefrog",
      "Mexican Smilisca",
    ]);
    expect(mergeAliases(null, "Cory", "Cory")).toEqual([]);
    expect(mergeAliases(["Cory"], "cory", "Little Cory")).toEqual(["Cory"]);
    expect(mergeAliases(null, null, "X")).toEqual([]);
  });
});

describe("planNames", () => {
  it("title-cases iNaturalist's name the catalog way and keeps the old one as an alias", () => {
    const r = row({ common_name: "Mexican Smilisca", inat_taxon_id: 24277 });
    const [p] = planNames([r], names([[24277, { name: "common mexican treefrog", active: true }]]));
    expect(p).toMatchObject({ outcome: "changed", name: "Common Mexican Treefrog", aliases: ["Mexican Smilisca"] });
    const [h] = planNames(
      [row({ inat_taxon_id: 7 })],
      names([[7, { name: "new caledonia flying-fox", active: true }]]),
    );
    expect(h.name).toBe("New Caledonia Flying-Fox");
  });

  it("leaves birds, unknown, inactive and nameless taxa alone", () => {
    const rows = [
      row({ taxon_class: "aves", common_name: "Osprey", inat_taxon_id: 1 }),
      row({ common_name: "A", inat_taxon_id: 2 }),
      row({ common_name: "B", inat_taxon_id: 3 }),
      row({ common_name: "C", inat_taxon_id: 4 }),
      row({ common_name: "D", inat_taxon_id: null }),
    ];
    const plan = planNames(
      rows,
      names([
        [1, { name: "western osprey", active: true }],
        [3, { name: "other", active: false }],
        [4, { name: null, active: true }],
      ]),
    );
    expect(plan.map((p) => [p.outcome, p.name])).toEqual([
      ["kept", "Osprey"],
      ["no-inat-name", "A"],
      ["no-inat-name", "B"],
      ["no-inat-name", "C"],
      ["kept", "D"],
    ]);
  });

  it("holds back a rename onto a name another species of the class shows, and reports it", () => {
    const taken = row({ common_name: "Tree Frog", inat_taxon_id: null });
    const otherClass = row({ common_name: "Rock Frog", taxon_class: "squamata", inat_taxon_id: null });
    const a = row({ common_name: "Old A", inat_taxon_id: 100 });
    const b = row({ common_name: "Old B", inat_taxon_id: 101 });
    const swap = row({ common_name: "Old C", inat_taxon_id: 102 });
    const freed = row({ common_name: "Freed", inat_taxon_id: 103 });
    const inat = names([
      [100, { name: "tree frog", active: true }],
      [101, { name: "rock frog", active: true }],
      [102, { name: "freed", active: true }],
      [103, { name: "new freed", active: true }],
    ]);
    const plan = planNames([taken, otherClass, a, b, swap, freed], inat);
    expect(plan[2]).toMatchObject({ outcome: "held", name: "Old A", aliases: ["Tree Frog"] });
    // Another class's name, or one the other rename gives up, is free to take.
    expect(plan[3]).toMatchObject({ outcome: "changed", name: "Rock Frog" });
    expect(plan[4]).toMatchObject({ outcome: "changed", name: "Freed" });
    expect(collisions(plan, inat)).toEqual([expect.objectContaining({ wanted: "Tree Frog", holders: [plan[0]] })]);
  });
});

describe("planNames on a name iNaturalist gives two species", () => {
  const twoFrogs = () => [
    row({ common_name: "Red-Eyed Treefrog", inat_taxon_id: 200 }),
    row({ common_name: "Red-Eyed Green Treefrog", inat_taxon_id: 201 }),
  ];
  const inat = names([
    [200, { name: "red-eyed tree frog", active: true }],
    [201, { name: "red-eyed tree frog", active: true }],
  ]);

  it("gives it to the far more observed one", () => {
    const plan = planNames(
      twoFrogs(),
      inat,
      new Map([
        [200, 50_000],
        [201, 4_000],
      ]),
    );
    expect(plan.map((p) => [p.outcome, p.name])).toEqual([
      ["changed", "Red-Eyed Tree Frog"],
      ["held", "Red-Eyed Green Treefrog"],
    ]);
  });

  it("holds both back when neither clearly leads", () => {
    const plan = planNames(
      twoFrogs(),
      inat,
      new Map([
        [200, 500],
        [201, 400],
      ]),
    );
    expect(plan.map((p) => p.outcome)).toEqual(["held", "held"]);
  });
});

describe("namesOnDisk", () => {
  it("prefers this script's cache, then inat-taxa-cache, and lists the rest as missing", () => {
    const got = namesOnDisk(
      [1, 2, 3, 4],
      { "1": { name: "own", active: true }, "4": null },
      { "1": { common: "taxa" }, "2": { common: null, active: false }, "3x": {} },
    );
    expect(got.names.get(1)).toEqual({ name: "own", active: true });
    expect(got.names.get(2)).toEqual({ name: null, active: false });
    expect(got.names.get(4)).toBeNull();
    expect(got.missing).toEqual([3]);
    expect([got.fromOwn, got.fromTaxa]).toEqual([2, 1]);
  });
});

describe("planNames overrides", () => {
  const smilisca = () =>
    row({
      scientific_name: "Smilisca baudinii",
      common_name: "Mexican Treefrog",
      common_name_aliases: ["Mexican Smilisca"],
      inat_taxon_id: 24277,
    });
  const inat = names([[24277, { name: "Mexican Treefrog", active: true }]]);
  const ov = { "Smilisca baudinii": "Mexican Tree Frog" };

  it("wins over iNaturalist and keeps the old and iNaturalist names as aliases", () => {
    const [p] = planNames([smilisca()], inat, new Map(), ov);
    expect(p).toMatchObject({ outcome: "changed", name: "Mexican Tree Frog" });
    expect(p.aliases).toEqual(["Mexican Smilisca", "Mexican Treefrog"]);
  });

  it("changes nothing on a rerun", () => {
    const [p] = planNames([smilisca()], inat, new Map(), ov);
    const again = row({ ...smilisca(), common_name: p.name, common_name_aliases: p.aliases });
    expect(planNames([again], inat, new Map(), ov)[0].outcome).toBe("kept");
  });

  it("is never held back by a shared name", () => {
    const other = row({ common_name: "Mexican Tree Frog" });
    const plan = planNames([smilisca(), other], inat, new Map(), ov);
    expect(plan[0]).toMatchObject({ outcome: "changed", name: "Mexican Tree Frog" });
  });
});
