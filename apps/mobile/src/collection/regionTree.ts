// The region picker's country > group > province tree, from the hub's synced regions. Pure, so it is unit tested.
import type { TreeNode } from "../sync/regionTree";

const COUNTRY_DEPTH = 2;
const byName = (a: TreeNode, b: TreeNode) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
// Regions with a list of their own lead; a group that only holds provinces follows.
const listedFirst = (a: TreeNode, b: TreeNode) =>
  Number(b.speciesCount > 0) - Number(a.speciesCount > 0) || byName(a, b);

export interface RegionTree {
  /** Countries, those with a species list first. */
  top: TreeNode[];
  children(id: string): TreeNode[];
  /** From the country down to the node itself. */
  trail(id: string): TreeNode[];
  /** Regions with a word starting with the text, shallow ones first; never above country level. */
  search(text: string): TreeNode[];
  get(id: string): TreeNode | undefined;
}

export function buildRegionTree(nodes: TreeNode[]): RegionTree {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map<string, TreeNode[]>();
  for (const n of nodes) if (n.parentId) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
  for (const list of kids.values()) list.sort(listedFirst);
  const countries = nodes.filter((n) => n.depth === COUNTRY_DEPTH);
  // No continent above (a tree that starts lower): the shallowest regions stand in.
  const shallow = Math.min(...nodes.map((n) => n.depth));
  const top = (countries.length ? countries : nodes.filter((n) => n.depth === shallow)).sort(listedFirst);
  const trail = (id: string): TreeNode[] => {
    const out: TreeNode[] = [];
    for (
      let n = byId.get(id);
      n && n.depth >= (countries.length ? COUNTRY_DEPTH : shallow);
      n = n.parentId ? byId.get(n.parentId) : undefined
    )
      out.unshift(n);
    return out;
  };
  return {
    top,
    children: (id) => kids.get(id) ?? [],
    trail,
    search: (text) => {
      const q = text.trim().toLowerCase();
      if (!q) return [];
      const low = countries.length ? COUNTRY_DEPTH : shallow;
      return nodes
        .filter(
          (n) =>
            n.depth >= low &&
            n.name
              .toLowerCase()
              .split(/[\s-]+/)
              .some((w) => w.startsWith(q)),
        )
        .sort((a, b) => a.depth - b.depth || byName(a, b));
    },
    get: (id) => byId.get(id),
  };
}
