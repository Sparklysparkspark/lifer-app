import { describe, expect, it } from "vitest";
import {
  ancestorIds,
  collectedLeaves,
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
