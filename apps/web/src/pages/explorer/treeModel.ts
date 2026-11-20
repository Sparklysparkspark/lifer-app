// The Tree of life's data, apart from how it draws: ids, the rows an expansion shows, search and
// the detail pane's picks. Pure, so a 10,000-species tree is tested without a DOM.
import { TIER_ORDER } from "../../lib/speciesGroups";

// GET /collection/tree?include=uncollected. Its children are loosely typed in the API schema.
export interface TreeNode {
  rank: "class" | "order" | "family" | "genus" | "species";
  name: string;
  collected: number;
  total: number;
  photos: number;
  photoId: string | null;
  speciesId?: string;
  commonName?: string | null;
  tier?: string | null;
  referenceUrl?: string | null;
  children: TreeNode[];
}

export interface IndexedNode {
  id: string;
  node: TreeNode;
  parentId: string | null;
  depth: number;
  /** Children ids: photographed first, then the rest, each in catalogue order. */
  childIds: string[];
}

export type TreeIndex = { roots: string[]; byId: Map<string, IndexedNode> };

/** The explorer's expansion and selection, kept for the session so the tree is as you left it
 *  after a species page. */
export const explorerMemory: { expanded: Set<string>; selected: string | null } = {
  expanded: new Set(),
  selected: null,
};

const collectedFirst = (a: TreeNode, b: TreeNode) => Number(b.collected > 0) - Number(a.collected > 0);

/** Ids are the path of rank:name pairs, so they are stable across reloads and unique per branch. */
export function indexTree(tree: TreeNode[]): TreeIndex {
  const byId = new Map<string, IndexedNode>();
  const walk = (nodes: TreeNode[], parentId: string | null, depth: number): string[] =>
    [...nodes].sort(collectedFirst).map((node) => {
      const id = `${parentId ? `${parentId}/` : ""}${node.rank}:${node.name}`;
      const entry: IndexedNode = { id, node, parentId, depth, childIds: [] };
      byId.set(id, entry);
      entry.childIds = walk(node.children, id, depth + 1);
      return id;
    });
  return { roots: walk(tree, null, 0), byId };
}

/** The rows an expansion shows, top to bottom. */
export function visibleRows(index: TreeIndex, expanded: ReadonlySet<string>): IndexedNode[] {
  const out: IndexedNode[] = [];
  const add = (ids: string[]) => {
    for (const id of ids) {
      const entry = index.byId.get(id)!;
      out.push(entry);
      if (expanded.has(id)) add(entry.childIds);
    }
  };
  add(index.roots);
  return out;
}

export function ancestorIds(index: TreeIndex, id: string): string[] {
  const out: string[] = [];
  for (let at = index.byId.get(id)?.parentId; at; at = index.byId.get(at)?.parentId) out.unshift(at);
  return out;
}

/** Every node whose name (or species' shown name) holds the query, in tree order. */
export function searchTree(index: TreeIndex, query: string, label: (node: TreeNode) => string): string[] {
  const q = query.trim().toLocaleLowerCase();
  if (q.length < 2) return [];
  const out: string[] = [];
  const walk = (ids: string[]) => {
    for (const id of ids) {
      const { node, childIds } = index.byId.get(id)!;
      if (node.name.toLocaleLowerCase().includes(q) || label(node).toLocaleLowerCase().includes(q)) out.push(id);
      walk(childIds);
    }
  };
  walk(index.roots);
  return out;
}

/** The photographed species under a node (itself, for a species). */
export function collectedLeaves(index: TreeIndex, id: string): IndexedNode[] {
  const out: IndexedNode[] = [];
  const walk = (entry: IndexedNode) => {
    if (entry.node.collected === 0) return;
    if (entry.node.rank === "species") out.push(entry);
    else for (const c of entry.childIds) walk(index.byId.get(c)!);
  };
  const start = index.byId.get(id);
  if (start) walk(start);
  return out;
}

const tierRank = (tier: string | null | undefined) => {
  const i = TIER_ORDER.indexOf(tier ?? "unrated");
  return i < 0 ? TIER_ORDER.length : i;
};

/** Rarest photographed species first; ties keep tree order. */
export function rarestFirst(leaves: IndexedNode[]): IndexedNode[] {
  return [...leaves].sort((a, b) => tierRank(a.node.tier) - tierRank(b.node.tier));
}
