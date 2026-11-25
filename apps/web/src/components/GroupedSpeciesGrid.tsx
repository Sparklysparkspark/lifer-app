import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { CollectionItem } from "@lifer/shared";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import i18n from "../i18n";
import SpeciesCard, { type SpeciesChangeHandler } from "./SpeciesCard";
import { cardImageSrc } from "../lib/cardImage";
import { tierLabel } from "../lib/speciesGroups";
import { orderGroupKeys, speciesGroupKey, type SpeciesGroupBy } from "../lib/speciesGrouping";
import { useStorageVolumes } from "../hooks/useStorageVolumes";
import { useSettings } from "../hooks/useSettings";
import Chevron from "./Chevron";
import { useToast } from "../hooks/useToast";
import { groupInto } from "../lib/groupInto";
import { useSpeciesName } from "../lib/speciesName";
import { registerAnchorLocator } from "../hooks/useScrollMemory";
import { visibleRows } from "./justifyRows";
import { useWindowRange } from "./windowing";
import {
  blockTops,
  buildBlocks,
  gapPxFor,
  HEADING_GAP_PX,
  type GridBlock,
  type SpeciesGroup,
} from "./speciesGridLayout";
import Button from "./Button";
import ProgressBar from "./ProgressBar";
import { formatNumber } from "../lib/format";
import { useLatest } from "../hooks/useLatest";
import { rankBySearch } from "../pages/collection/filterItems";

// Only rows within this many screens are mounted, so "All species" (60,000+ cards) scrolls like a
// short list. More below than above: that's where scrolling usually heads.
const MOUNT_SCREENS = { above: 2, below: 3 };
// Images of rows this many screens past the mounted ones are fetched ahead, so cards scroll in
// already drawn.
const PRELOAD_SCREENS = 2;
// Unmeasured estimates: a heading's height, and a card's height beyond its square photo.
const HEADING_ESTIMATE_PX = 20;
const NAME_BOX_ESTIMATE_PX = 56;
const COMPACT_NAME_BOX_ESTIMATE_PX = 40;

/** Select mode for the grid: the page owns the set, the grid owns display order (ranges, groups). */
export interface GridSelection {
  selected: ReadonlySet<string>;
  /** Selects or deselects these species. */
  onChange: (speciesIds: string[], on: boolean) => void;
}

export type GroupBy = "none" | SpeciesGroupBy;
export type SortBy = "taxonomic" | "name" | "scientific" | "rarity" | "localRarity";

// At or below this card width the name box uses tighter spacing (see SpeciesCard `compact`).
const COMPACT_CARD_WIDTH = 150;

// "unrated" ranks after "common": it isn't easier, just unknown.
const TIER_RANK: Record<string, number> = { legendary: 0, rare: 1, uncommon: 2, occasional: 3, common: 4, unrated: 5 };
const COLLECTED_GROUP_KEY = "__collected__";
const SEEN_GROUP_KEY = "__seen__";
const TARGET_GROUP_KEY = "__target__";
const PINNED_KEYS: ReadonlySet<string> = new Set([COLLECTED_GROUP_KEY, SEEN_GROUP_KEY, TARGET_GROUP_KEY]);

// groupBy and sortBy are independent. Array.sort is stable, so a secondary sort keeps the
// primary order within each bucket.
function sortItems(
  items: CollectionItem[],
  sortBy: SortBy,
  nameOf: (item: CollectionItem) => string,
): CollectionItem[] {
  const sorted = [...items];
  if (sortBy === "rarity") {
    sorted.sort((a, b) => (TIER_RANK[a.tier ?? "common"] ?? 5) - (TIER_RANK[b.tier ?? "common"] ?? 5));
  } else if (sortBy === "localRarity") {
    // localTier only exists on region rows; falls back to the global tier.
    sorted.sort(
      (a, b) =>
        (TIER_RANK[a.localTier ?? a.tier ?? "common"] ?? 5) - (TIER_RANK[b.localTier ?? b.tier ?? "common"] ?? 5),
    );
  } else if (sortBy === "name") {
    // By the name each card shows.
    sorted.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  } else if (sortBy === "scientific") {
    sorted.sort((a, b) => a.scientificName.localeCompare(b.scientificName));
  }
  // "taxonomic" is the server's order: field-guide (taxonomic) order.
  return sorted;
}

// A card's column grows up to about 1.6 times its minimum width. Steps of 160px, so moving the
// size slider doesn't cut a new image for every pixel.
function cardImageSideFor(cardMinWidth: number): number {
  const needed = cardMinWidth * 1.6 * (window.devicePixelRatio || 1);
  return Math.min(640, Math.max(160, Math.ceil(needed / 160) * 160));
}

// Heading text widths, for packing small groups into lines before they're rendered.
let measureContext: OffscreenCanvasRenderingContext2D | null | undefined;
let fontFamily = "";
const textWidths = new Map<string, number>();
function textWidth(text: string, sizePx: number, weight: number): number {
  const cacheKey = `${weight} ${sizePx} ${text}`;
  let width = textWidths.get(cacheKey);
  if (width != null) return width;
  if (measureContext === undefined) {
    measureContext = typeof OffscreenCanvas === "undefined" ? null : new OffscreenCanvas(1, 1).getContext("2d");
    fontFamily = getComputedStyle(document.body).fontFamily;
  }
  if (measureContext) {
    measureContext.font = `${weight} ${sizePx}px ${fontFamily}`;
    width = measureContext.measureText(text).width;
  } else {
    width = text.length * sizePx * 0.55;
  }
  textWidths.set(cacheKey, width);
  return width;
}

const CHEVRON_WIDTH = 16;

// Re-exported for the pages that took it from here before it moved to its own file.
export { Chevron };

// A link-variant Button: text-footnote, font-medium, and a 1px transparent border each side.
const linkButtonWidth = (text: string) => textWidth(text, 12, 500) + 2;

/** Photographed of shown, for a group's band. */
function groupProgress(group: SpeciesGroup): { collected: number; total: number } {
  let collected = 0;
  for (const i of group.items) if (i.state === "collected") collected++;
  return { collected, total: group.items.length };
}

// The heading's parts as rendered: arrow, gap-2, label (text-callout medium), gap-2, count (text-footnote),
// then gap-x-3 and the archive button when it has one. A band's label is text-title-3 semibold with
// no count beside it, and its number line (text-callout, the number semibold) can be the wider part.
function headingWidthFor(
  group: SpeciesGroup,
  collapsed: boolean,
  archivable: boolean,
  selecting: boolean,
  band: boolean,
): number {
  const buttons =
    (archivable && !collapsed && !selecting ? 12 + linkButtonWidth(i18n.t("speciesGrid.archiveGroup")) : 0) +
    (selecting && !collapsed ? 12 + linkButtonWidth(i18n.t("speciesGrid.deselectGroup")) : 0);
  if (band && !collapsed) {
    const { collected, total } = groupProgress(group);
    const top = CHEVRON_WIDTH + 8 + textWidth(group.label, 17, 600) + buttons;
    const number = textWidth(
      `${formatNumber(collected)} ${i18n.t("collection.breadcrumb.ofTotal", { total: formatNumber(total) })}`,
      14,
      600,
    );
    return Math.ceil(Math.max(top, number)) + 1;
  }
  const width =
    CHEVRON_WIDTH + 8 + textWidth(group.label, 14, 500) + 8 + textWidth(`(${group.items.length})`, 12, 400) + buttons;
  return Math.ceil(width) + 1;
}

// Card images already requested ahead of their cards, and the ones still loading (held so they
// aren't dropped before they land in the cache).
const preloaded = new Set<string>();
const preloading = new Set<HTMLImageElement>();
function preload(src: string) {
  if (preloaded.has(src)) return;
  preloaded.add(src);
  const img = new Image();
  img.decoding = "async";
  img.onload = img.onerror = () => preloading.delete(img);
  preloading.add(img);
  img.src = src;
}

export default function GroupedSpeciesGrid({
  items,
  regionId,
  groupBy,
  sortBy,
  collectedFirst,
  seenFirst,
  targetFirst,
  onChanged,
  onWidthChange,
  cardMinWidth = 160,
  regionName,
  countryRegionId,
  countryRegionName,
  hideLabels,
  showRarityTags,
  hideNames,
  groupBands = false,
  selection,
  backLabel,
  tripId,
  searchRanks,
}: {
  items: CollectionItem[];
  /** While searching, each species' match score (searchRanks); better matches lead within each group. */
  searchRanks?: ReadonlyMap<string, number> | null;
  regionId?: string;
  groupBy: GroupBy;
  sortBy: SortBy;
  /** The three pin toggles are independent; when stacked the order is collected, seen, targets. */
  collectedFirst: boolean;
  seenFirst: boolean;
  targetFirst: boolean;
  /** Minimum card width in px, from the page's Size slider. */
  cardMinWidth?: number;
  /** Passed through to SpeciesCard's province-vs-country hide picker. */
  regionName?: string;
  countryRegionId?: string;
  countryRegionName?: string;
  hideLabels?: boolean;
  showRarityTags?: boolean;
  hideNames?: boolean;
  /** Grouped by animal group: each group heads with a band of its photographed count and bar. */
  groupBands?: boolean;
  /** Present while selecting: cards pick instead of open, and headings offer "Select group". */
  selection?: GridSelection;
  /** A card or bulk action changed species in this list; the parent patches its rows. */
  onChanged?: SpeciesChangeHandler;
  /** The grid's content width, for the Size slider's column stops. */
  onWidthChange?: (width: number) => void;
  /** Passed to every card: the species page's back link, and the trip it was opened from. */
  backLabel?: string;
  tripId?: string;
}) {
  const speciesName = useSpeciesName();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const { multiDriveInUse } = useStorageVolumes();
  // Other Taxa group labels follow the species naming preference ("Insects" vs "Insecta").
  const { settings } = useSettings();
  const namingStyles = useMemo(() => settings?.speciesNamingStyles ?? [], [settings?.speciesNamingStyles]);

  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  // Layout effect: the first paint already has the real width, so rows never jump into place.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setContainerWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setContainerWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // Not laid out yet (or hidden): the window's width is a close enough guess.
  const width = containerWidth || window.innerWidth;
  useEffect(() => onWidthChange?.(width), [width, onWidthChange]);

  const groups = useMemo((): SpeciesGroup[] => {
    // Search ranking leads, the sort control breaks ties; groups and pins then keep that order.
    const sorted = rankBySearch(sortItems(items, sortBy, speciesName), searchRanks);

    // Ungrouped "float to top" rank: only a state whose toggle is on moves ahead of the rest.
    function floatRank(item: CollectionItem): number {
      if (collectedFirst && item.state === "collected") return 0;
      if (seenFirst && item.state === "seen") return collectedFirst ? 1 : 0;
      if (targetFirst && item.isTarget) return (collectedFirst ? 1 : 0) + (seenFirst ? 1 : 0);
      return 3;
    }

    if (groupBy === "none") {
      const list =
        collectedFirst || seenFirst || targetFirst ? [...sorted].sort((a, b) => floatRank(a) - floatRank(b)) : sorted;
      return [{ key: "", label: "", items: list }];
    }

    const byTier = groupBy === "tier" || groupBy === "localTier";
    const byKey = new Map<string, CollectionItem[]>();
    for (const item of sorted) groupInto(byKey, speciesGroupKey(item, groupBy, namingStyles), item);
    const keys = orderGroupKeys([...byKey.keys()], groupBy, (key) => byKey.get(key)!);

    const named = keys.map((key) => ({
      key,
      label: byTier ? tierLabel(key) : key,
      items: byKey.get(key)!,
    }));

    // While grouped, the pin toggles add pinned groups above the normal breakdown, which still
    // lists every species in its usual group.
    const pinned: typeof named = [];
    if (collectedFirst) {
      const collectedItems = sorted.filter((i) => i.state === "collected");
      if (collectedItems.length > 0)
        pinned.push({
          key: COLLECTED_GROUP_KEY,
          label: i18n.t("speciesGrid.pinned.photographed"),
          items: collectedItems,
        });
    }
    if (seenFirst) {
      const seenItems = sorted.filter((i) => i.state === "seen");
      if (seenItems.length > 0)
        pinned.push({ key: SEEN_GROUP_KEY, label: i18n.t("speciesGrid.pinned.seen"), items: seenItems });
    }
    if (targetFirst) {
      const targetItems = sorted.filter((i) => i.isTarget);
      if (targetItems.length > 0)
        pinned.push({ key: TARGET_GROUP_KEY, label: i18n.t("speciesGrid.pinned.targets"), items: targetItems });
    }
    return [...pinned, ...named];
  }, [items, groupBy, sortBy, collectedFirst, seenFirst, targetFirst, namingStyles, speciesName, searchRanks]);

  // Ungrouped keeps the plain wide grid; packing is for small groups.
  // Taxonomic groups (Owls next to Grebes) can share a row; ranked tiers can't.
  const packSmallGroups = groupBy === "group" || groupBy === "broad";
  // Only real taxonomic groups offer "Archive group"; dropping a whole tier would be a surprise.
  const archivable = (group: SpeciesGroup) => packSmallGroups && !PINNED_KEYS.has(group.key);
  // Animal groups (Owls, Frogs & Toads) head with a band and their own "22 of 48"; families and
  // tiers keep the one-line heading.
  const banded = (group: SpeciesGroup) => groupBands && groupBy === "broad" && !PINNED_KEYS.has(group.key);
  const gap = gapPxFor(cardMinWidth);
  const selecting = !!selection;
  const blocks = useMemo(
    () =>
      buildBlocks({
        groups,
        ungrouped: groupBy === "none",
        pinnedKeys: PINNED_KEYS,
        collapsed,
        packSmallGroups,
        width,
        cardMinWidth,
        gap,
        headingWidth: (group, isCollapsed) =>
          headingWidthFor(
            group,
            isCollapsed,
            packSmallGroups && !PINNED_KEYS.has(group.key),
            selecting,
            groupBands && groupBy === "broad" && !PINNED_KEYS.has(group.key),
          ),
      }),
    [groups, groupBy, collapsed, packSmallGroups, width, cardMinWidth, gap, selecting, groupBands],
  );

  // Measured heights, keyed by block (a row by its first species), kept across re-layouts. A
  // row's is stored beyond its square photos, so it still fits after a resize; unmeasured rows
  // and headings borrow the latest measurement.
  const [measuredHeights] = useState(() => new Map<string, number>());
  const nameBoxGuess = hideNames
    ? 2
    : cardMinWidth <= COMPACT_CARD_WIDTH
      ? COMPACT_NAME_BOX_ESTIMATE_PX
      : NAME_BOX_ESTIMATE_PX;
  const [measured, setMeasured] = useState({ version: 0, row: -1, heading: -1 });
  const [blockObserver] = useState(() =>
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver((entries) => {
          let changed = false;
          const latest: { row?: number; heading?: number } = {};
          for (const { target } of entries) {
            const el = target as HTMLElement;
            const height = el.getBoundingClientRect().height;
            const key = el.dataset.blockKey;
            // Zero while hidden: nothing to learn.
            if (!height || !key) continue;
            const value = Math.max(0, height - Number(el.dataset.base ?? 0));
            if (el.dataset.kind === "row") latest.row = value;
            if (el.dataset.kind === "heading") latest.heading = value;
            if (Math.abs((measuredHeights.get(key) ?? -1) - value) > 0.5) {
              measuredHeights.set(key, value);
              changed = true;
            }
          }
          // Synchronously, so a block above the view that measured off its estimate is
          // compensated (useWindowRange) before this frame paints.
          if (changed)
            flushSync(() =>
              setMeasured((m) => ({
                version: m.version + 1,
                row: latest.row ?? m.row,
                heading: latest.heading ?? m.heading,
              })),
            );
        }),
  );
  useEffect(() => () => blockObserver?.disconnect(), [blockObserver]);
  const observeBlock = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el || !blockObserver) return;
      blockObserver.observe(el);
      return () => blockObserver.unobserve(el);
    },
    [blockObserver],
  );

  const layout = useMemo(() => {
    const rowExtra = measured.row >= 0 ? measured.row : nameBoxGuess;
    const headingHeight = measured.heading >= 0 ? measured.heading : HEADING_ESTIMATE_PX;
    const heights = blocks.map((block) => {
      const known = measuredHeights.get(block.key);
      if (block.kind === "row") return block.cardWidth + (known ?? rowExtra);
      if (known != null) return known;
      if (block.kind === "heading") return headingHeight;
      const rows = block.maxRows;
      return rows > 0
        ? headingHeight + HEADING_GAP_PX + rows * (cardMinWidth + rowExtra) + (rows - 1) * gap
        : headingHeight;
    });
    return {
      structure: blocks,
      heights,
      tops: blockTops(
        heights,
        blocks.map((b) => b.gapBefore),
      ),
    };
    // `measured` bumps whenever measuredHeights changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, measured, nameBoxGuess, cardMinWidth, gap]);

  const range = useWindowRange(containerRef, layout, MOUNT_SCREENS);

  // The block holding keyboard focus stays mounted, so scrolling away never drops focus.
  const [focusKey, setFocusKey] = useState<string | null>(null);

  const cardImageSide = cardImageSideFor(cardMinWidth);

  // Fetch the images of the rows just past the mounted ones, so they're cached when those mount.
  useEffect(() => {
    if (!range || range[0] > range[1]) return;
    const { tops, heights } = layout;
    const screen = window.innerHeight;
    const bottom = tops[range[1]] + heights[range[1]];
    const ahead = [
      visibleRows(tops, heights, bottom, bottom + PRELOAD_SCREENS * screen),
      visibleRows(tops, heights, tops[range[0]] - screen, tops[range[0]]),
    ];
    for (const [first, last] of ahead) {
      for (let i = first; i <= last; i++) {
        const block = blocks[i];
        const cards =
          block.kind === "row"
            ? block.items
            : block.kind === "packed"
              ? block.groups.flatMap((g) => (g.collapsed ? [] : g.group.items))
              : [];
        for (const item of cards) {
          const src = cardImageSrc(item, cardImageSide);
          if (src) preload(src);
        }
      }
    }
  }, [range, layout, blocks, cardImageSide]);

  // Back to a card that isn't mounted: useScrollMemory scrolls to where it would be, and the
  // card mounts there.
  const blockOfSpecies = useMemo(() => {
    const map = new Map<string, number>();
    blocks.forEach((block, i) => {
      const cards =
        block.kind === "row" ? block.items : block.kind === "packed" ? block.groups.flatMap((g) => g.group.items) : [];
      for (const item of cards) if (!map.has(item.speciesId)) map.set(item.speciesId, i);
    });
    return map;
  }, [blocks]);
  useEffect(
    () =>
      registerAnchorLocator((id) => {
        const i = blockOfSpecies.get(id);
        const el = containerRef.current;
        return i == null || !el ? null : el.getBoundingClientRect().top + layout.tops[i];
      }),
    [blockOfSpecies, layout],
  );

  // Collapsing frees the group's space and the groups after it move up, so the page scrolls by as
  // much as the clicked heading moved: it stays under the pointer while the rest reflows.
  function toggleCollapsed(key: string) {
    const heading = () => document.querySelector(`[data-group-heading="${CSS.escape(key)}"]`);
    const before = heading()?.getBoundingClientRect().top;
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (before == null) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const after = heading()?.getBoundingClientRect().top;
        if (after != null) window.scrollBy(0, after - before);
      }),
    );
  }

  // Display order across groups, for Shift-click ranges; a species in two groups counts once.
  const order = useMemo(() => {
    if (!selecting) return [];
    const seen = new Set<string>();
    for (const g of groups) for (const i of g.items) seen.add(i.speciesId);
    return [...seen];
  }, [groups, selecting]);
  const selectionRef = useLatest(selection);
  const orderRef = useLatest(order);
  const anchorRef = useRef<string | null>(null);
  const onToggleSelect = useCallback(
    (speciesId: string, shiftKey: boolean) => {
      const sel = selectionRef.current;
      if (!sel) return;
      const on = !sel.selected.has(speciesId);
      const from = shiftKey && anchorRef.current ? orderRef.current.indexOf(anchorRef.current) : -1;
      const to = orderRef.current.indexOf(speciesId);
      if (from >= 0 && to >= 0) {
        sel.onChange(orderRef.current.slice(Math.min(from, to), Math.max(from, to) + 1), on);
      } else sel.onChange([speciesId], on);
      anchorRef.current = speciesId;
    },
    [selectionRef, orderRef],
  );
  const groupSelect = (group: SpeciesGroup) => {
    if (!selection) return undefined;
    const all = group.items.every((i) => selection.selected.has(i.speciesId));
    return {
      all,
      onToggle: () =>
        selection.onChange(
          group.items.map((i) => i.speciesId),
          !all,
        ),
    };
  };

  const cardProps = {
    selectMode: !!selection,
    onToggleSelect,
    regionId,
    regionName,
    countryRegionId,
    countryRegionName,
    onChanged,
    showVolumeBadge: multiDriveInUse,
    hideLabels,
    showRarityTags,
    hideNames,
    compact: cardMinWidth <= COMPACT_CARD_WIDTH,
    cardImageSide,
    backLabel,
    tripId,
  };

  const renderBlock = (block: GridBlock): ReactNode => {
    const common = {
      ref: observeBlock,
      "data-block-key": block.key,
      "data-kind": block.kind,
      style: { marginTop: block.gapBefore },
    };
    if (block.kind === "heading") {
      return (
        <div key={block.key} {...common}>
          {block.collapsed ? (
            <CollapsedGroupHeading group={block.group} onToggle={() => toggleCollapsed(block.group.key)} />
          ) : (
            <GroupHeading
              group={block.group}
              onToggle={() => toggleCollapsed(block.group.key)}
              onChanged={onChanged}
              archivable={archivable(block.group)}
              select={groupSelect(block.group)}
              band={banded(block.group)}
            />
          )}
        </div>
      );
    }
    if (block.kind === "row") {
      return (
        <div
          key={block.key}
          {...common}
          data-base={block.cardWidth}
          className="grid"
          style={{
            ...common.style,
            // Grouped cards stay at the size the slider picked, so groups side by side always match.
            gridTemplateColumns: block.fluid
              ? `repeat(${block.columns}, minmax(0, 1fr))`
              : `repeat(${block.columns}, ${cardMinWidth}px)`,
            gap,
          }}
        >
          {block.items.map((item) => (
            <SpeciesCard
              key={item.speciesId}
              item={item}
              {...cardProps}
              selected={selection?.selected.has(item.speciesId)}
            />
          ))}
        </div>
      );
    }
    // A line of small groups, each as wide as its cluster of cards (or its one-line heading). The
    // groups share one set of rows (subgrid), so a two-line name lifts its whole line, not one group.
    return (
      <div
        key={block.key}
        {...common}
        className="grid grid-flow-col justify-start gap-x-section"
        style={{ ...common.style, gridTemplateRows: `auto repeat(${block.maxRows}, auto)`, rowGap: gap }}
      >
        {block.groups.map(({ group, collapsed: isCollapsed, columns, width: groupWidth }) =>
          isCollapsed ? (
            <div key={group.key} className="row-start-1 w-max">
              <CollapsedGroupHeading group={group} onToggle={() => toggleCollapsed(group.key)} />
            </div>
          ) : (
            <GroupSection
              key={group.key}
              group={group}
              onToggle={() => toggleCollapsed(group.key)}
              onChanged={onChanged}
              archivable={archivable(group)}
              select={groupSelect(group)}
              band={banded(group)}
              selectedIds={selection?.selected}
              columns={columns}
              width={groupWidth}
              rows={block.maxRows}
              cardMinWidth={cardMinWidth}
              gap={gap}
              cardProps={cardProps}
            />
          ),
        )}
      </div>
    );
  };

  const { heights, tops } = layout;
  const first = range?.[0] ?? 0;
  const last = Math.min(range?.[1] ?? -1, blocks.length - 1);
  const mounted: number[] = [];
  for (let i = first; i <= last; i++) mounted.push(i);
  const focused = focusKey == null ? -1 : blocks.findIndex((b) => b.key === focusKey);
  if (focused >= 0 && (focused < first || focused > last)) {
    mounted.splice(focused < first ? 0 : mounted.length, 0, focused);
  }
  // Unmounted blocks between mounted ones collapse into one spacer of their exact height.
  const spacer = (a: number, b: number) => (
    <div
      key={`spacer-${a}`}
      aria-hidden
      style={{ marginTop: blocks[a].gapBefore, height: tops[b] + heights[b] - tops[a] }}
    />
  );
  const children: ReactNode[] = [];
  let prev = -1;
  for (const i of mounted) {
    if (i > prev + 1) children.push(spacer(prev + 1, i - 1));
    children.push(renderBlock(blocks[i]));
    prev = i;
  }
  if (prev < blocks.length - 1) children.push(spacer(prev + 1, blocks.length - 1));

  return (
    <div
      ref={containerRef}
      className="flex flex-col"
      style={{ overflowAnchor: "none" }}
      onFocus={(e) => setFocusKey(e.target.closest<HTMLElement>("[data-block-key]")?.dataset.blockKey ?? null)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFocusKey(null);
      }}
    >
      {children}
    </div>
  );
}

/** A collapsed group, in its own place in the list: just its heading, which opens it again there. */
function CollapsedGroupHeading({ group, onToggle }: { group: SpeciesGroup; onToggle: () => void }) {
  return (
    // raw-control: the group's heading is its disclosure.
    <button
      type="button"
      onClick={onToggle}
      aria-expanded="false"
      data-group-heading={group.key}
      className="flex w-max items-center gap-2 text-left text-callout font-medium text-ink hover:underline"
    >
      <Chevron open={false} />
      {group.label}
      <span className="text-footnote font-normal text-muted">({group.items.length})</span>
    </button>
  );
}

/** An open group's heading. In a packed cluster (`nowrap`) it stays on one line. */
function GroupHeading({
  group,
  onToggle,
  onChanged,
  archivable,
  select,
  nowrap,
  band = false,
  className = "",
}: {
  group: SpeciesGroup;
  onToggle: () => void;
  onChanged?: SpeciesChangeHandler;
  archivable: boolean;
  /** While selecting: whether every species in the group is picked, and how to pick or drop them. */
  select?: { all: boolean; onToggle: () => void };
  nowrap?: boolean;
  /** A bigger heading with the group's photographed count and bar, for animal groups. */
  band?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const [archiving, setArchiving] = useState(false);
  const toast = useToast();

  // Reversible, so no confirm: the toast's Undo brings the group back. The server skips species
  // you've photographed or seen, so only the ids it changed leave the grid.
  async function archiveGroup() {
    setArchiving(true);
    try {
      const { changedIds } = await api.post("/collection/bulk", {
        action: "archive",
        speciesIds: group.items.map((i) => i.speciesId),
      });
      if (changedIds.length > 0) onChanged?.(changedIds, "removed");
      toast.show(t("collection.select.doneArchive", { count: changedIds.length }), {
        tone: "success",
        actions:
          changedIds.length > 0
            ? [
                {
                  label: t("species.edits.undo"),
                  onClick: () =>
                    void api
                      .post("/collection/bulk", { action: "unarchive", speciesIds: changedIds })
                      .then(() => onChanged?.(changedIds, "reload"))
                      .catch(() => toast.error(t("collection.select.failed"))),
                },
              ]
            : undefined,
      });
    } catch {
      toast.error(t("speciesGrid.archiveFailed"));
    } finally {
      setArchiving(false);
    }
  }

  const progress = band ? groupProgress(group) : null;
  const heading = (
    // The archive action sits right after the name, not across the group's width.
    <div className={`flex items-center gap-x-3 gap-y-1 ${nowrap ? "whitespace-nowrap" : "flex-wrap"} ${className}`}>
      {/* raw-control: the group's heading is its disclosure. */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded="true"
        data-group-heading={group.key}
        className={`flex items-center gap-2 text-left text-ink hover:underline ${
          band ? "text-title-3 font-semibold" : "text-callout font-medium"
        }`}
      >
        <Chevron open />
        {group.label}
        {!band && <span className="text-footnote font-normal text-muted">({group.items.length})</span>}
      </button>
      {select && (
        <Button variant="link" size="sm" onClick={select.onToggle} className="shrink-0">
          {select.all ? t("speciesGrid.deselectGroup") : t("speciesGrid.selectGroup")}
        </Button>
      )}
      {archivable && !select && (
        <Button
          variant="link"
          size="sm"
          onClick={archiveGroup}
          disabled={archiving}
          tooltip={{ label: t("speciesGrid.archiveTitle") }}
          className="shrink-0"
        >
          {archiving ? t("common.saving") : t("speciesGrid.archiveGroup")}
        </Button>
      )}
    </div>
  );
  if (!progress) return heading;
  return (
    <div className="flex flex-col gap-1">
      {heading}
      {/* As the page header's count, quieter than the group's name. */}
      <p className="whitespace-nowrap text-callout text-muted">
        <span className="font-semibold tabular-nums text-ink">{formatNumber(progress.collected)}</span>{" "}
        {t("collection.breadcrumb.ofTotal", { total: formatNumber(progress.total) })}
      </p>
      <ProgressBar
        determinate
        size="xs"
        value={progress.total ? progress.collected / progress.total : 0}
        label={t("speciesGrid.groupProgress", { group: group.label })}
        className="w-full max-w-56"
      />
    </div>
  );
}

/** A small group packed beside others: its heading over a cluster of `columns` cards, on the rows
 *  of its line (`rows` card rows under the heading row). */
function GroupSection({
  group,
  onToggle,
  onChanged,
  archivable,
  select,
  band,
  selectedIds,
  columns,
  width,
  rows,
  cardMinWidth,
  gap,
  cardProps,
}: {
  group: SpeciesGroup;
  onToggle: () => void;
  onChanged?: SpeciesChangeHandler;
  archivable: boolean;
  select?: { all: boolean; onToggle: () => void };
  band: boolean;
  selectedIds?: ReadonlySet<string>;
  columns: number;
  /** The width the layout gave it: a heading wider than its cards widens the group. */
  width: number;
  rows: number;
  cardMinWidth: number;
  gap: number;
  cardProps: Omit<React.ComponentProps<typeof SpeciesCard>, "item">;
}) {
  return (
    <section
      className="grid"
      style={{
        gridRow: `1 / span ${rows + 1}`,
        minWidth: width,
        gridTemplateRows: "subgrid",
        gridTemplateColumns: `repeat(${columns}, ${cardMinWidth}px)`,
        columnGap: gap,
      }}
    >
      {/* The line's row gap is the cards' gap; this keeps the heading's own spacing. */}
      <div className="col-span-full" style={{ marginBottom: HEADING_GAP_PX - gap }}>
        <GroupHeading
          group={group}
          onToggle={onToggle}
          onChanged={onChanged}
          archivable={archivable}
          select={select}
          band={band}
          nowrap
        />
      </div>
      {group.items.map((item) => (
        <SpeciesCard key={item.speciesId} item={item} {...cardProps} selected={selectedIds?.has(item.speciesId)} />
      ))}
    </section>
  );
}
