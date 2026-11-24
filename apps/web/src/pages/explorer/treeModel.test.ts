import { describe, expect, it } from "vitest";
import {
  ancestorIds,
  circleArcs,
  collectedLeaves,
  myBranches,
  indexTree,
  rarestFirst,
  searchTree,
  visibleRows,
  type TreeNode,
} from "./treeModel";

const leaf = (name: string, collected: number, tier = "common"): TreeNode => ({
  rank: "species",
  name,
  commonName: `${name} bird`,
  speciesId: name,
  collected,
  total: 1,
  photos: collected,
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
});
