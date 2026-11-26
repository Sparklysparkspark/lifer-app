// The Tree of life demo's data: a real collection's land animals in one region, exported by
// scripts/tree-snapshot.mjs. Photos are the collector's own.
import snapshot from "../../data/treeSnapshot.json";

export const TIERS = ["common", "occasional", "uncommon", "rare", "legendary"] as const;
export type Tier = (typeof TIERS)[number];

export interface TreeNode {
  id: string;
  name: string;
  latin?: string;
  rank: "life" | "class" | "order" | "family" | "species";
  children: TreeNode[];
  parent: TreeNode | null;
  /** Catalogue species, photographed species and targets under the node. */
  total: number;
  collected: number;
  targets: number;
  /** Rated species per tier. */
  tiers: Partial<Record<Tier, number>>;
  /** The collector's photo for this group or species, a file in static/img/tree. */
  photo?: string;
  /** Layout: a span of species along the circle, and the ring depth (life is 0). */
  x0: number;
  x1: number;
  depth: number;
}

interface Raw {
  name: string;
  latin?: string;
  photo?: string;
  collected?: number;
  targets?: number;
  tiers?: Partial<Record<Tier, number>>;
  children?: Raw[];
}

const RANKS = ["life", "class", "order", "family", "species"] as const;

function build(raw: Raw, depth: number): TreeNode {
  const n: TreeNode = {
    id: "",
    name: raw.name,
    latin: raw.latin,
    rank: RANKS[depth],
    children: (raw.children ?? []).map((c) => build(c, depth + 1)),
    parent: null,
    total: raw.children ? 0 : 1,
    collected: raw.children ? 0 : (raw.collected ?? 0),
    targets: raw.children ? 0 : (raw.targets ?? 0),
    tiers: raw.children ? {} : { ...raw.tiers },
    photo: raw.photo,
    x0: 0,
    x1: 0,
    depth: 0,
  };
  return n;
}

// Sums up the tree, sorts each level largest first (so thin groups sit together at the end,
// where an "N more groups" segment can stand in for them) and lays out the species spans.
function layout(life: TreeNode): TreeNode {
  const count = (n: TreeNode): number => (n.rank === "species" ? 1 : n.children.reduce((k, c) => k + count(c), 0));
  const sort = (n: TreeNode) => {
    n.children.forEach(sort);
    n.children.sort((a, b) => count(b) - count(a));
  };
  const sum = (n: TreeNode, parent: TreeNode | null, depth: number, x: number, path: string) => {
    n.parent = parent;
    n.depth = depth;
    n.id = path;
    n.x0 = x;
    for (const ch of n.children) {
      sum(ch, n, depth + 1, x, `${path}/${ch.name}`);
      x = ch.x1;
      n.total += ch.total;
      n.collected += ch.collected;
      n.targets += ch.targets;
      for (const [t, k] of Object.entries(ch.tiers)) n.tiers[t as Tier] = (n.tiers[t as Tier] ?? 0) + k;
    }
    n.x1 = n.children.length ? x : x + n.total;
  };
  sort(life);
  sum(life, null, 0, 0, "life");
  return life;
}

export const COLLECTION_TREE = layout(build({ name: "All life", children: snapshot as Raw[] }, 0));
