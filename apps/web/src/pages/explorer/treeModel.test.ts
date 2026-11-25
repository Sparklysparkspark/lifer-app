import { describe, expect, it } from "vitest";
import {
  ancestorIds,
  circleArcs,
  REST_PAGE,
  restChain,
  restOf,
  collectedLeaves,
  markable,
  myBranches,
  indexTree,
  onlyTargets,
  rarityOf,
  rarestFirst,
  shownTier,
  searchTree,
  visibleRows,
  type TreeNode,
} from "./treeModel";

const leaf = (name: string, collected: number, tier = "common", targetCount = 0, seenCount = 0): TreeNode => ({
  rank: "species",
  name,
  commonName: `${name} bird`,
  speciesId: name,
  collected,
  total: 1,
  photos: collected,
  targetCount,
  seenCount,
  tiers: { [tier]: 1 },
  photoId: collected ? `p-${name}` : null,
  tier,
  children: [],
});
const clade = (rank: TreeNode["rank"], name: string, children: TreeNode[]): TreeNode => ({
  rank,
  name,
  collected: children.reduce((n, c) => n + c.collected, 0),
  total: children.reduce((n, c) => n + c.total, 0),
  photos: 0,
  targetCount: children.reduce((n, c) => n + c.targetCount, 0),
  seenCount: children.reduce((n, c) => n + c.seenCount, 0),
  tiers: children.reduce<Record<string, number>>((out, c) => {
    for (const [tier, n] of Object.entries(c.tiers)) out[tier] = (out[tier] ?? 0) + n;
    return out;
  }, {}),
  photoId: null,
  children,
});

// 10 orders x 10 families x 10 genera x 10 species: 10,000 species, 11,110 rows in all.
const big = [
  clade(
    "class",
    "Aves",
    Array.from({ length: 10 }, (_, o) =>
      clade(
        "order",
        `O${o}`,
        Array.from({ length: 10 }, (_, f) =>
          clade(
            "family",
            `F${o}-${f}`,
            Array.from({ length: 10 }, (_, g) =>
              clade(
                "genus",
                `G${o}-${f}-${g}`,
                Array.from({ length: 10 }, (_, s) => leaf(`S${o}-${f}-${g}-${s}`, s % 3 === 0 ? 1 : 0)),
              ),
            ),
          ),
        ),
      ),
    ),
  ),
];

describe("treeModel", () => {
  it("indexes 10,000 species and shows only expanded rows", () => {
    const index = indexTree(big);
    expect(index.byId.size).toBe(11_111);
    expect(visibleRows(index, new Set())).toHaveLength(1);
    const aves = index.roots[0];
    expect(visibleRows(index, new Set([aves]))).toHaveLength(11);
  });

  it("draws connector lines from each row's later siblings", () => {
    const index = indexTree(big);
    const o0 = "class:Aves/order:O0";
    const rows = visibleRows(index, new Set(["class:Aves", o0]));
    expect(rows[0].lines).toEqual([]);
    expect(rows[1]).toMatchObject({ id: o0, depth: 1, lines: [true] });
    // O0's families: the line for O0's later siblings runs on through them.
    expect(rows[2].lines).toEqual([true, true]);
    expect(rows[11].lines).toEqual([true, false]);
    expect(rows.at(-1)!.lines).toEqual([false]);
  });

  it("hides genera by listing a family's species, photographed first, and re-roots on a focus", () => {
    const index = indexTree(big);
    const family = "class:Aves/order:O0/family:F0-0";
    const rows = visibleRows(index, new Set([family]), { focus: "class:Aves/order:O0", genus: false });
    expect(rows[0]).toMatchObject({ id: family, depth: 0, parentId: "class:Aves/order:O0" });
    const species = rows.filter((r) => r.parentId === family);
    expect(species).toHaveLength(100);
    expect(species.every((r) => r.node.rank === "species" && r.depth === 1)).toBe(true);
    expect(species.slice(0, 40).every((r) => r.node.collected === 1)).toBe(true);
    expect(species[40].node.collected).toBe(0);
  });

  it("opens on photographed classes and orders, within the row cap", () => {
    const index = indexTree(big);
    expect(myBranches(index)).toEqual(
      new Set(["class:Aves", ...Array.from({ length: 10 }, (_, o) => `class:Aves/order:O${o}`)]),
    );
    // 1 + 10 rows fit in 20, then only one order's 10 families more.
    expect(myBranches(index, 20).size).toBe(1);
    expect(myBranches(index, 21).size).toBe(2);
  });

  it("lists photographed children first and gives paths as ids", () => {
    const index = indexTree(big);
    const genus = "class:Aves/order:O0/family:F0-0/genus:G0-0-0";
    const kids = index.byId.get(genus)!.childIds.map((id) => index.byId.get(id)!.node);
    expect(kids.map((k) => k.collected)).toEqual([1, 1, 1, 1, 0, 0, 0, 0, 0, 0]);
    expect(ancestorIds(index, `${genus}/species:S0-0-0-3`)).toEqual([
      "class:Aves",
      "class:Aves/order:O0",
      "class:Aves/order:O0/family:F0-0",
      genus,
    ]);
  });

  it("searches names and shown labels, case-insensitively, from two letters", () => {
    const index = indexTree(big);
    const label = (n: TreeNode) => n.commonName ?? n.name;
    expect(searchTree(index, "s", label)).toEqual([]);
    expect(searchTree(index, "s9-9-9-9 BIRD", label)).toEqual([
      "class:Aves/order:O9/family:F9-9/genus:G9-9-9/species:S9-9-9-9",
    ]);
  });

  it("finds a group's photographed species, rarest first", () => {
    const tree = [clade("genus", "G", [leaf("a", 1), leaf("b", 0, "legendary"), leaf("c", 1, "rare")])];
    const index = indexTree(tree);
    expect(rarestFirst(collectedLeaves(index, "genus:G")).map((l) => l.node.name)).toEqual(["c", "a"]);
  });

  it("ranks by the region's local tier where a species has one, as species cards do", () => {
    // a is common worldwide but legendary in the picked region.
    const a = { ...leaf("a", 1), tiers: { legendary: 1 } };
    const index = indexTree([clade("genus", "G", [leaf("c", 1, "rare"), a])]);
    expect(shownTier(a)).toBe("legendary");
    expect(rarestFirst(collectedLeaves(index, "genus:G")).map((l) => l.node.name)).toEqual(["a", "c"]);
  });
});

describe("marks", () => {
  // a: photographed; b: targeted; c: seen; d: photographed and targeted; e: nothing yet.
  const family = clade("family", "F", [
    leaf("a", 1),
    leaf("b", 0, "common", 1),
    leaf("c", 0, "common", 0, 1),
    leaf("d", 1, "common", 1),
    leaf("e", 0),
  ]);
  const tree = [clade("class", "C", [family, clade("family", "Bare", [leaf("x", 0)])])];

  it("changes only the species not photographed yet when targeting or marking a group as seen", () => {
    expect(markable(family, "target")).toEqual(["c", "e"]);
    expect(markable(family, "seen")).toEqual(["b", "e"]);
    // Removing takes every target, photographed or not.
    expect(markable(family, "untarget")).toEqual(["b", "d"]);
    expect(markable(family, "unseen")).toEqual(["c"]);
  });

  it("targets a single species whether photographed or not, but never marks a photographed one seen", () => {
    expect(markable(leaf("a", 1), "target")).toEqual(["a"]);
    expect(markable(leaf("a", 1), "seen")).toEqual([]);
    expect(markable(leaf("b", 0, "common", 1), "target")).toEqual([]);
  });

  it("keeps only the branches holding a target, down to the targeted species", () => {
    const shown = onlyTargets(tree);
    expect(shown).toHaveLength(1);
    expect(shown[0].children.map((f) => f.name)).toEqual(["F"]);
    expect(shown[0].children[0].children.map((s) => s.name)).toEqual(["b", "d"]);
    // A group keeps its own progress.
    expect(shown[0].children[0].total).toBe(5);
  });

  it("carries targets onto arcs, merged ones included", () => {
    const arcs = circleArcs(indexTree(tree), "class:C", { rings: 1 });
    expect(arcs.find((a) => a.id === "class:C/family:F")!.targetCount).toBe(2);
    const merged = circleArcs(indexTree(tree), "class:C", { rings: 1, minAngle: 10 });
    expect(merged).toMatchObject([{ id: null, more: 2, targetCount: 2 }]);
  });

  it("merges tiers onto a merged arc, so its rarity band still shows", () => {
    const merged = circleArcs(indexTree(tree), "class:C", { rings: 1, minAngle: 10 });
    const species = merged[0].total;
    expect(Object.values(merged[0].tiers).reduce((n, c) => n + c, 0)).toBe(species);
    expect(rarityOf(merged[0])).not.toBeNull();
  });
});

describe("rarityOf", () => {
  it("averages the rated species' tiers and counts the rare or rarer ones", () => {
    const family = clade("family", "F", [leaf("a", 0, "common"), leaf("b", 0, "rare"), leaf("c", 0, "legendary")]);
    // (0 + 3 + 4) / 3 rounds to uncommon.
    expect(rarityOf(family)).toEqual({ step: 2, rarePlus: 2, rated: 3 });
    expect(rarityOf(leaf("u", 0, "unrated"))).toBeNull();
    expect(rarityOf(clade("family", "G", [leaf("a", 0, "common"), leaf("u", 0, "unrated")]))).toEqual({
      step: 0,
      rarePlus: 0,
      rated: 1,
    });
  });
});

describe("circleArcs", () => {
  const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

  it("fills each ring: children's arcs add up to their parent's", () => {
    const index = indexTree(big);
    const arcs = circleArcs(index, null, { rings: 3 });
    const ring1 = arcs.filter((a) => a.ring === 1);
    close(
      ring1.reduce((n, a) => n + a.end - a.start, 0),
      2 * Math.PI,
    );
    const o3 = arcs.find((a) => a.id === "class:Aves/order:O3")!;
    const kids = arcs.filter((a) => a.ring === 3 && a.start >= o3.start - 1e-9 && a.end <= o3.end + 1e-9);
    close(
      kids.reduce((n, a) => n + a.end - a.start, 0),
      o3.end - o3.start,
    );
    expect(arcs.some((a) => a.ring === 4)).toBe(false);
  });

  it("merges arcs thinner than the minimum into one more arc", () => {
    const index = indexTree(big);
    // 100 families of 100 species share the circle: 0.063 rad each.
    const arcs = circleArcs(index, "class:Aves", { rings: 2, minAngle: 0.1 });
    const ring2 = arcs.filter((a) => a.ring === 2);
    expect(ring2.every((a) => a.id === null && a.more === 10)).toBe(true);
    close(
      ring2.reduce((n, a) => n + a.end - a.start, 0),
      2 * Math.PI,
    );
  });

  it("turns a more arc back into the groups it merged, and pages a huge set", () => {
    const index = indexTree(big);
    const arcs = circleArcs(index, "class:Aves", { rings: 2, minAngle: 0.1 });
    const more = arcs.find((a) => a.id === null)!;
    expect(more).toMatchObject({ more: 10, parent: "class:Aves/order:O0", offset: 0, ring: 2 });
    const kids = index.byId.get("class:Aves/order:O0")!.childIds;
    expect(restOf(index, kids, 0)).toHaveLength(10);
    expect(restOf(index, kids, 4)).toHaveLength(6);
    expect(restChain(index, "class:Aves/order:O0", false, [0, 4]).map((l) => l.length)).toEqual([10, 6]);
    expect(restChain(index, "class:Aves/order:O0", false, [10, 4])).toEqual([]);

    // 3,000 equal genera: each layer draws a page and merges the rest, so it always makes progress.
    const family = clade(
      "family",
      "Huge",
      Array.from({ length: 3000 }, (_, i) => clade("genus", `G${i}`, [leaf(`s${i}`, 0)])),
    );
    const huge = indexTree([family]);
    const top = huge.byId.get("family:Huge")!.childIds;
    const page = circleArcs(huge, null, { rings: 1, top });
    expect(page.filter((a) => a.id).length).toBe(REST_PAGE);
    expect(page.find((a) => !a.id)).toMatchObject({ more: 3000 - REST_PAGE, offset: REST_PAGE });
  });
});
