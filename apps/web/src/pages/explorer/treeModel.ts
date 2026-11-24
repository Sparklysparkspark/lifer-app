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
  /** Nothing photographed yet: the species' catalogue picture, or a common species' for a group. */
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

/** The explorer's expansion (null until first shown, so it can open on your branches), selection
 *  and focused group, kept for the session so the tree is as you left it after a species page. */
export const explorerMemory: { expanded: Set<string> | null; selected: string | null; focus: string | null } = {
  expanded: null,
  selected: null,
  focus: null,
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

/** A node's children as listed: with genera hidden, a family lists its species straight away,
 *  photographed first. */
export function childrenOf(index: TreeIndex, id: string, genus: boolean): string[] {
  const { childIds } = index.byId.get(id)!;
  if (genus || index.byId.get(childIds[0])?.node.rank !== "genus") return childIds;
  return childIds
    .flatMap((g) => index.byId.get(g)!.childIds)
    .sort((a, b) => collectedFirst(index.byId.get(a)!.node, index.byId.get(b)!.node));
}

export interface VisibleRow {
  id: string;
  node: TreeNode;
  /** The row's parent as listed (a family, not the hidden genus), or the focused group. */
  parentId: string | null;
  /** Depth below the list's top level. */
  depth: number;
  childIds: string[];
  /** Per level of indent, whether its connector line runs on below this row; the last entry is
   *  this row's own (it has a later sibling). */
  lines: boolean[];
}

/** The rows an expansion shows, top to bottom, under `focus` (or from the top). */
export function visibleRows(
  index: TreeIndex,
  expanded: ReadonlySet<string>,
  { focus = null, genus = true }: { focus?: string | null; genus?: boolean } = {},
): VisibleRow[] {
  const out: VisibleRow[] = [];
  const add = (ids: string[], parentId: string | null, parentLines: boolean[] | null) => {
    ids.forEach((id, i) => {
      const childIds = childrenOf(index, id, genus);
      const lines = parentLines ? [...parentLines, i < ids.length - 1] : [];
      out.push({ id, node: index.byId.get(id)!.node, parentId, depth: lines.length, childIds, lines });
      if (expanded.has(id)) add(childIds, id, lines);
    });
  };
  const top = focus && index.byId.has(focus) ? childrenOf(index, focus, genus) : index.roots;
  add(top, focus && index.byId.has(focus) ? focus : null, null);
  return out;
}

/** The groups to open on a first visit: every class and order with something photographed, while
 *  the list stays under `cap` rows, so the first screen shows your life list. */
export function myBranches(index: TreeIndex, cap = 150): Set<string> {
  const open = new Set<string>();
  let rows = index.roots.length;
  for (const rank of ["class", "order"])
    for (const [id, entry] of index.byId) {
      const { node, parentId, childIds } = entry;
      if (node.rank !== rank || node.collected === 0 || (parentId && !open.has(parentId))) continue;
      if (rows + childIds.length > cap) continue;
      open.add(id);
      rows += childIds.length;
    }
  return open;
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

export interface Arc {
  /** Null for the "N more" arc that stands in for groups too thin to see. */
  id: string | null;
  /** 1 is the ring next to the centre. */
  ring: number;
  start: number;
  end: number;
  /** Groups merged into a "more" arc. */
  more?: number;
  /** Species you have and catalogue species under the arc. */
  collected: number;
  total: number;
}

/** The Circle view's arcs: `rings` levels below `center` (or the whole tree), each child's angle
 *  in proportion to its catalogue species. Siblings thinner than `minAngle` merge into one arc. */
export function circleArcs(
  index: TreeIndex,
  center: string | null,
  { rings = 3, minAngle = 0.008, genus = false }: { rings?: number; minAngle?: number; genus?: boolean } = {},
): Arc[] {
  const out: Arc[] = [];
  const place = (ids: string[], ring: number, start: number, end: number) => {
    const total = ids.reduce((n, id) => n + index.byId.get(id)!.node.total, 0);
    if (total === 0) return;
    const span = end - start;
    let at = start;
    const thin = { id: null, ring, start: 0, end, more: 0, collected: 0, total: 0 };
    for (const id of ids) {
      const { collected, total: species } = index.byId.get(id)!.node;
      const angle = (span * species) / total;
      if (angle < minAngle) {
        thin.more++;
        thin.collected += collected;
        thin.total += species;
        continue;
      }
      out.push({ id, ring, start: at, end: at + angle, collected, total: species });
      if (ring < rings) place(childrenOf(index, id, genus), ring + 1, at, at + angle);
      at += angle;
    }
    if (thin.more > 0) out.push({ ...thin, start: at });
  };
  place(center && index.byId.has(center) ? childrenOf(index, center, genus) : index.roots, 1, 0, 2 * Math.PI);
  return out;
}
