import { describe, expect, it } from "vitest";
import type { TreeNode } from "../sync/regionTree";
import { buildRegionTree } from "./regionTree";

const n = (id: string, name: string, parentId: string | null, depth: number, speciesCount = 0): TreeNode => ({
  id,
  name,
  parentId,
  depth,
  speciesCount,
});
const nodes = [
  n("w", "World", null, 0),
  n("na", "North America", "w", 1),
  n("as", "Asia", "w", 1),
  n("ca", "Canada", "na", 2, 2546),
  n("bc", "British Columbia", "ca", 3, 1632),
  n("ab", "Alberta", "ca", 3, 652),
  n("th", "Thailand", "as", 2, 0),
  n("nth", "Northern Thailand", "th", 3, 0),
  n("cm", "Chiang Mai", "nth", 4, 700),
  n("cr", "Costa Rica", "na", 2, 3251),
];

describe("buildRegionTree", () => {
  const tree = buildRegionTree(nodes);
  it("starts at the countries, those with a list first", () => {
    expect(tree.top.map((x) => x.name)).toEqual(["Canada", "Costa Rica", "Thailand"]);
  });
  it("walks country > group > province", () => {
    expect(tree.children("ca").map((x) => x.name)).toEqual(["Alberta", "British Columbia"]);
    expect(tree.children("th").map((x) => x.name)).toEqual(["Northern Thailand"]);
    expect(tree.trail("cm").map((x) => x.name)).toEqual(["Thailand", "Northern Thailand", "Chiang Mai"]);
    expect(tree.trail("bc").map((x) => x.name)).toEqual(["Canada", "British Columbia"]);
  });
  it("finds a province by the start of any word, never a continent", () => {
    expect(tree.search("bri").map((x) => x.name)).toEqual(["British Columbia"]);
    expect(tree.search("columbia").map((x) => x.name)).toEqual(["British Columbia"]);
    expect(tree.search("asia")).toEqual([]);
    expect(tree.search("  ")).toEqual([]);
  });
  it("copes with an empty tree", () => {
    expect(buildRegionTree([]).top).toEqual([]);
  });
});
