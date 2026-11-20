import type { CollectionItem } from "@lifer/shared";

export type SpeciesGroup = { key: string; label: string; items: CollectionItem[] };

/** One piece of the windowed species list, stacked top to bottom. `gapBefore` is the space above it. */
export type GridBlock =
  | { kind: "heading"; key: string; gapBefore: number; group: SpeciesGroup; collapsed: boolean }
  | {
      kind: "row";
      key: string;
      gapBefore: number;
      items: CollectionItem[];
      columns: number;
      cardWidth: number;
      /** Ungrouped cards stretch to fill the width (1fr); grouped ones keep the slider's width. */
      fluid: boolean;
    }
  | {
      kind: "packed";
      key: string;
      gapBefore: number;
      /** Small groups side by side, mounted whole. Columns 0 for a collapsed one (heading only). */
      groups: { group: SpeciesGroup; collapsed: boolean; columns: number; width: number }[];
      /** Card rows in its tallest group. */
      maxRows: number;
    };

// --spacing-section: between groups, and between lines of packed groups.
export const SECTION_GAP_PX = 24;
// The heading's mb-2.
export const HEADING_GAP_PX = 8;

// In a taxonomic grouping each group is a compact cluster of up to CLUSTER_ROW_MAX species a row
// (fewer when the window can't fit that many cards), using as few rows as that allows and filled
// evenly (11 species: two rows of 6), so narrow blocks sit side by side. One that would need more
// than CLUSTER_ROWS rows takes the full width instead.
const CLUSTER_ROW_MAX = 8;
const CLUSTER_ROWS = 3;

/** Columns for a group packed as a cluster. */
function clusterColumns(count: number, rowMax: number): number {
  return Math.ceil(count / Math.ceil(count / rowMax));
}

/** Tracks CSS `repeat(auto-fill, minmax(min, 1fr))` (or a fixed `min`) would make in `width`. */
export function autoFillColumns(width: number, minWidth: number, gap: number): number {
  return Math.max(1, Math.floor((width + gap) / (minWidth + gap)));
}

// Same shrink-with-size gap as GalleryPage's grid.
export function gapPxFor(cardMinWidth: number): number {
  return Math.round(Math.min(8, Math.max(3, cardMinWidth / 30)));
}

/** The Size slider's stops for a fluid (stretching) grid `width` wide: one per reachable column
 *  count, each the largest card width giving that count, smallest (most columns) first. Between
 *  them the cards only stretch, so any other value would look the same. */
export function fluidSizeSteps(width: number, min: number, max: number): number[] {
  // The gap grows with the card size, so each width is checked rather than solved for.
  const largestFor = new Map<number, number>();
  for (let size = min; size <= max; size++) largestFor.set(autoFillColumns(width, size, gapPxFor(size)), size);
  return [...largestFor.values()].sort((a, b) => a - b);
}

/** The stop showing `size`'s layout: each stop covers the sizes up to it. */
export function fluidSizeStepIndex(steps: number[], size: number): number {
  const index = steps.findIndex((step) => step >= size);
  return index === -1 ? steps.length - 1 : index;
}

function rowBlocks(
  prefix: string,
  items: CollectionItem[],
  columns: number,
  cardWidth: number,
  fluid: boolean,
  gap: number,
  firstGap: number,
): GridBlock[] {
  const rows: GridBlock[] = [];
  for (let i = 0; i < items.length; i += columns) {
    rows.push({
      kind: "row",
      key: `r:${prefix}:${items[i].speciesId}`,
      gapBefore: i === 0 ? firstGap : gap,
      items: items.slice(i, i + columns),
      columns,
      cardWidth,
      fluid,
    });
  }
  return rows;
}

/** The whole list as blocks: ungrouped is just card rows; grouped is pinned groups first, then
 *  the rest, with small (or collapsed) groups packed into lines that fit `width`. */
export function buildBlocks({
  groups,
  ungrouped,
  pinnedKeys,
  collapsed,
  packSmallGroups,
  width,
  cardMinWidth,
  gap,
  headingWidth,
}: {
  groups: SpeciesGroup[];
  ungrouped: boolean;
  pinnedKeys: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  packSmallGroups: boolean;
  width: number;
  cardMinWidth: number;
  gap: number;
  /** One-line width of a group's heading as rendered (open, or collapsed). */
  headingWidth: (group: SpeciesGroup, collapsed: boolean) => number;
}): GridBlock[] {
  const columns = autoFillColumns(width, cardMinWidth, gap);
  if (ungrouped) {
    const cardWidth = (width - gap * (columns - 1)) / columns;
    return rowBlocks("", groups[0]?.items ?? [], columns, cardWidth, true, gap, 0);
  }

  const blocks: GridBlock[] = [];
  const sectionGap = () => (blocks.length > 0 ? SECTION_GAP_PX : 0);
  const pushGroup = (group: SpeciesGroup, isCollapsed: boolean) => {
    blocks.push({ kind: "heading", key: `h:${group.key}`, gapBefore: sectionGap(), group, collapsed: isCollapsed });
    if (!isCollapsed)
      blocks.push(...rowBlocks(group.key, group.items, columns, cardMinWidth, false, gap, HEADING_GAP_PX));
  };
  for (const group of groups) if (pinnedKeys.has(group.key)) pushGroup(group, collapsed.has(group.key));

  const rowMax = Math.min(CLUSTER_ROW_MAX, columns);
  let line: Extract<GridBlock, { kind: "packed" }>["groups"] = [];
  let lineWidth = 0;
  let maxRows = 0;
  const flush = () => {
    if (line.length === 0) return;
    blocks.push({ kind: "packed", key: `p:${line[0].group.key}`, gapBefore: sectionGap(), groups: line, maxRows });
    line = [];
    lineWidth = 0;
    maxRows = 0;
  };
  for (const group of groups) {
    if (pinnedKeys.has(group.key)) continue;
    const isCollapsed = collapsed.has(group.key);
    // A collapsed group is just its heading, so the groups after it can use the space.
    if (!isCollapsed && !(packSmallGroups && group.items.length <= rowMax * CLUSTER_ROWS)) {
      flush();
      pushGroup(group, false);
      continue;
    }
    const cols = isCollapsed ? 0 : clusterColumns(group.items.length, rowMax);
    const cardsWidth = cols > 0 ? cols * cardMinWidth + (cols - 1) * gap : 0;
    // As wide as its cluster of cards, or its one-line heading if that's wider (max-w-full).
    const groupWidth = Math.min(width, Math.max(cardsWidth, headingWidth(group, isCollapsed)));
    if (line.length > 0 && lineWidth + SECTION_GAP_PX + groupWidth > width) flush();
    lineWidth += (line.length > 0 ? SECTION_GAP_PX : 0) + groupWidth;
    line.push({ group, collapsed: isCollapsed, columns: cols, width: groupWidth });
    if (cols > 0) maxRows = Math.max(maxRows, Math.ceil(group.items.length / cols));
  }
  flush();
  return blocks;
}

/** Each block's top: the blocks stacked with their own gaps above them. */
export function blockTops(heights: readonly number[], gapsBefore: readonly number[]): number[] {
  const tops = new Array<number>(heights.length);
  let y = 0;
  for (let i = 0; i < heights.length; i++) {
    y += gapsBefore[i];
    tops[i] = y;
    y += heights[i];
  }
  return tops;
}
