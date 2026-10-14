import { useEffect, useMemo, useState } from "react";
import type { CollectionItem } from "@lifer/shared";
import { api } from "../api/client";
import SpeciesCard, { type SpeciesChangeHandler } from "./SpeciesCard";
import { speciesGroupLabel, tierLabel } from "../lib/speciesGroups";
import { primaryBroadGroup } from "../lib/broadGroups";
import { useStorageVolumes } from "../hooks/useStorageVolumes";
import { useSettings } from "../hooks/useSettings";
import { useConfirm } from "../hooks/useConfirm";
import { useToast } from "../hooks/useToast";
import { groupInto } from "../lib/groupInto";
import { useSpeciesName } from "../lib/speciesName";

// "All species" can be 60,000+ rows and every card mount forces a layout read (useFitText), so
// cards are revealed in small batches on scroll to keep each commit responsive.
const INITIAL_VISIBLE = 60;
const VISIBLE_STEP = 60;

export type GroupBy = "none" | "broad" | "group" | "tier" | "localTier";
export type SortBy = "taxonomic" | "name" | "rarity" | "localRarity" | "seasonality";

// CollectionItem.seasonality is a 12-entry monthly array (not WeeklyBar's 52 weeks).
function currentMonthIndex(): number {
  return new Date().getMonth();
}

type SpeciesGroup = { key: string; label: string; items: CollectionItem[] };

// At or below this card width the name box uses tighter spacing (see SpeciesCard `compact`).
const COMPACT_CARD_WIDTH = 150;

// In a taxonomic grouping each group is a compact cluster of up to CLUSTER_ROW_MAX species a row
// (fewer when the window can't fit that many cards), using as few rows as that allows and filled
// evenly (11 species: two rows of 6), so narrow blocks sit side by side. One that would need more
// than CLUSTER_ROWS rows takes the full width instead.
// Tier groupings never share rows: tiers read as a ranked list, top to bottom.
const CLUSTER_ROW_MAX = 8;
const CLUSTER_ROWS = 3;

/** Columns for a group packed as a cluster. */
function clusterColumns(count: number, rowMax: number): number {
  return Math.ceil(count / Math.ceil(count / rowMax));
}

// Same shrink-with-size gap as GalleryPage's grid.
function gapPxFor(cardMinWidth: number): number {
  return Math.round(Math.min(8, Math.max(3, cardMinWidth / 30)));
}

// "unrated" ranks after "common": it isn't easier, just unknown.
const TIER_RANK: Record<string, number> = { legendary: 0, rare: 1, uncommon: 2, occasional: 3, common: 4, unrated: 5 };
const COLLECTED_GROUP_KEY = "__collected__";
const SEEN_GROUP_KEY = "__seen__";
const TARGET_GROUP_KEY = "__target__";

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
  } else if (sortBy === "seasonality") {
    const month = currentMonthIndex();
    sorted.sort((a, b) => (b.seasonality?.[month] ?? 0) - (a.seasonality?.[month] ?? 0));
  }
  // "taxonomic" is the server's order.
  return sorted;
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
  resetKey,
  cardMinWidth = 160,
  regionName,
  countryRegionId,
  countryRegionName,
  hideLabels,
  hideNames,
  hideScientificName,
  initialVisibleCount,
  onVisibleCountChange,
}: {
  items: CollectionItem[];
  regionId?: string;
  groupBy: GroupBy;
  sortBy: SortBy;
  /** Minimum card width in px, from the page's Size slider. */
  cardMinWidth?: number;
  /** Passed through to SpeciesCard's province-vs-country hide picker. */
  regionName?: string;
  countryRegionId?: string;
  countryRegionName?: string;
  hideLabels?: boolean;
  hideNames?: boolean;
  /** Common name only on each card. */
  hideScientificName?: boolean;
  /** The three pin toggles are independent; when stacked the order is collected, seen, targets. */
  collectedFirst: boolean;
  seenFirst: boolean;
  targetFirst: boolean;
  /** A card or bulk action changed species in this list; the parent patches its rows. */
  onChanged?: SpeciesChangeHandler;
  /** Changes when the list is really a different one (new load, filter, search). Defaults to items identity. */
  resetKey?: string;
  /** How many cards to show at first, to return to a scroll position from before (useScrollMemory). */
  initialVisibleCount?: number;
  /** Called whenever more cards are revealed, so the count can be remembered. */
  onVisibleCountChange?: (count: number) => void;
}) {
  const speciesName = useSpeciesName();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [visibleCount, setVisibleCount] = useState(() => Math.max(INITIAL_VISIBLE, initialVisibleCount ?? 0));
  useEffect(() => {
    onVisibleCountChange?.(visibleCount);
  }, [visibleCount, onVisibleCountChange]);
  // A callback ref, not useRef: toggling grouping renders a new sentinel element, and an observer on
  // the old one would never fire again.
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  // The packed area's width, so a cluster never has more columns than fit the window.
  const [packedBox, setPackedBox] = useState<HTMLDivElement | null>(null);
  const [packedWidth, setPackedWidth] = useState(0);
  useEffect(() => {
    if (!packedBox) return;
    const observer = new ResizeObserver(() => setPackedWidth(packedBox.clientWidth));
    observer.observe(packedBox);
    return () => observer.disconnect();
  }, [packedBox]);
  const { multiDriveInUse } = useStorageVolumes();
  // Other Taxa group labels follow the species naming preference ("Insects" vs "Insecta").
  const { settings } = useSettings();
  const namingStyles = useMemo(() => settings?.speciesNamingStyles ?? [], [settings?.speciesNamingStyles]);

  // A new list starts back at the cap. Reset during render, not in an effect, so a stale large count
  // never commits. resetKey names what's viewed, so a background reload or one-row patch keeps cards.
  const listKey = resetKey ?? items;
  const [shownFor, setShownFor] = useState({ listKey, groupBy, sortBy, collectedFirst, seenFirst, targetFirst });
  const resetKeyChanged =
    shownFor.listKey !== listKey ||
    shownFor.groupBy !== groupBy ||
    shownFor.sortBy !== sortBy ||
    shownFor.collectedFirst !== collectedFirst ||
    shownFor.seenFirst !== seenFirst ||
    shownFor.targetFirst !== targetFirst;
  if (resetKeyChanged) {
    setShownFor({ listKey, groupBy, sortBy, collectedFirst, seenFirst, targetFirst });
    if (visibleCount !== INITIAL_VISIBLE) setVisibleCount(INITIAL_VISIBLE);
  }

  const groups = useMemo(() => {
    const sorted = sortItems(items, sortBy, speciesName);

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
    for (const item of sorted) {
      // "Rarity here" falls back to the global tier when localTier is null.
      const key =
        groupBy === "tier"
          ? (item.tier ?? "common")
          : groupBy === "localTier"
            ? (item.localTier ?? item.tier ?? "common")
            : // Other Taxa have no broad groups of their own; their iNat group (Insects, Fungi) is broad enough.
              groupBy === "broad" && !item.isOtherTaxa
              ? primaryBroadGroup(item)
              : speciesGroupLabel(item.taxonClass, item.family, item.isOtherTaxa, item.inatIconicTaxon, namingStyles);
      groupInto(byKey, key, item);
    }

    const keys = [...byKey.keys()];
    if (byTier) keys.sort((a, b) => (TIER_RANK[a] ?? 5) - (TIER_RANK[b] ?? 5));
    // Leftovers ("Other Birds") go after the named groups.
    else keys.sort((a, b) => Number(a.startsWith("Other ")) - Number(b.startsWith("Other ")) || a.localeCompare(b));

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
        pinned.push({ key: COLLECTED_GROUP_KEY, label: "Collected", items: collectedItems });
    }
    if (seenFirst) {
      const seenItems = sorted.filter((i) => i.state === "seen");
      if (seenItems.length > 0) pinned.push({ key: SEEN_GROUP_KEY, label: "Seen", items: seenItems });
    }
    if (targetFirst) {
      const targetItems = sorted.filter((i) => i.isTarget);
      if (targetItems.length > 0) pinned.push({ key: TARGET_GROUP_KEY, label: "Targets", items: targetItems });
    }
    return [...pinned, ...named];
  }, [items, groupBy, sortBy, collectedFirst, seenFirst, targetFirst, namingStyles, speciesName]);

  // How many cards each group renders under the page-wide cap (headers still show true counts).
  // Groups fill top to bottom, so only the last visible one is partial and scrolling only adds below.
  // Collapsed groups take none of it.
  const visibleCountByKey = useMemo(() => {
    const map = new Map<string, number>();
    let remaining = visibleCount;
    for (const g of groups) {
      if (collapsed.has(g.key)) continue;
      const shown = Math.min(g.items.length, remaining);
      map.set(g.key, shown);
      remaining -= shown;
    }
    return map;
  }, [groups, visibleCount, collapsed]);
  const totalItemCount = useMemo(
    () => groups.reduce((sum, g) => sum + (collapsed.has(g.key) ? 0 : g.items.length), 0),
    [groups, collapsed],
  );
  const hasMore = visibleCount < totalItemCount;

  // Re-observed after every reveal: on a tall screen the sentinel can still be in view after a
  // batch, and an observer only fires on a change, so it would otherwise stall.
  useEffect(() => {
    if (!hasMore) return;
    const el = sentinel;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) setVisibleCount((c) => c + VISIBLE_STEP);
      },
      { rootMargin: "600px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, visibleCount, sentinel]);

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

  // Ungrouped keeps the plain wide grid; the column packing below is for small groups.
  // Taxonomic groups (Owls next to Grebes) can share a row; ranked tiers can't.
  const packSmallGroups = groupBy === "group" || groupBy === "broad";

  if (groupBy === "none") {
    const visible = groups[0].items.slice(0, visibleCountByKey.get(groups[0].key) ?? groups[0].items.length);
    return (
      <>
        <div
          className="grid"
          style={{
            gridTemplateColumns: `repeat(auto-fill, minmax(${cardMinWidth}px, 1fr))`,
            gap: gapPxFor(cardMinWidth),
          }}
        >
          {visible.map((item) => (
            <SpeciesCard
              key={item.speciesId}
              item={item}
              regionId={regionId}
              regionName={regionName}
              countryRegionId={countryRegionId}
              countryRegionName={countryRegionName}
              onChanged={onChanged}
              showVolumeBadge={multiDriveInUse}
              hideLabels={hideLabels}
              hideNames={hideNames}
              hideScientificName={hideScientificName}
              compact={cardMinWidth <= COMPACT_CARD_WIDTH}
            />
          ))}
        </div>
        {hasMore && <div ref={setSentinel} className="h-10" />}
      </>
    );
  }

  const pinnedKeys = new Set([COLLECTED_GROUP_KEY, SEEN_GROUP_KEY, TARGET_GROUP_KEY]);
  const pinnedGroups = groups.filter((g) => pinnedKeys.has(g.key));
  const rest = groups.filter((g) => !pinnedKeys.has(g.key));
  const revealed = (g: SpeciesGroup) => (visibleCountByKey.get(g.key) ?? 0) > 0;
  // Groups with no budget yet aren't rendered: WebKit's layout cost scales with the number of
  // blocks, and the scroll sentinel reveals them later anyway. A collapsed group keeps its place as
  // a heading, shown once the reveal has reached it so headings never run ahead of the cards.
  let frontier = rest.length - 1;
  if (hasMore) while (frontier >= 0 && !revealed(rest[frontier])) frontier--;
  const shownGroups = rest.slice(0, frontier + 1).filter((g) => collapsed.has(g.key) || revealed(g));
  const shownPinnedGroups = pinnedGroups.filter((g) => collapsed.has(g.key) || revealed(g));

  const gap = gapPxFor(cardMinWidth);
  const fitColumns = packedWidth > 0 ? Math.floor((packedWidth + gap) / (cardMinWidth + gap)) : CLUSTER_ROW_MAX;
  const rowMax = Math.max(1, Math.min(CLUSTER_ROW_MAX, fitColumns));

  return (
    <div className="space-y-section">
      {shownPinnedGroups.map((group) =>
        collapsed.has(group.key) ? (
          <CollapsedGroupHeading key={group.key} group={group} onToggle={() => toggleCollapsed(group.key)} />
        ) : (
          <GroupSection
            key={group.key}
            group={group}
            visibleCount={visibleCountByKey.get(group.key) ?? group.items.length}
            regionId={regionId}
            onToggle={() => toggleCollapsed(group.key)}
            onChanged={onChanged}
            wide
            showVolumeBadge={multiDriveInUse}
            cardMinWidth={cardMinWidth}
            regionName={regionName}
            countryRegionId={countryRegionId}
            countryRegionName={countryRegionName}
            hideLabels={hideLabels}
            hideNames={hideNames}
            hideScientificName={hideScientificName}
          />
        ),
      )}

      {/* In a taxonomic grouping, a small group is just as wide as its cards and sits beside the next
          one until the row is full; a big group takes the full width. Wrapped boxes, not CSS columns,
          since WebKit rebalances every column on each revealed batch. */}
      <div ref={setPackedBox} className="flex flex-wrap items-start gap-section">
        {shownGroups.map((group) => {
          const packed = packSmallGroups && group.items.length <= rowMax * CLUSTER_ROWS;
          // Just its heading, so the groups after it can use the space.
          if (collapsed.has(group.key))
            return (
              <div key={group.key} className="w-max max-w-full">
                <CollapsedGroupHeading group={group} onToggle={() => toggleCollapsed(group.key)} />
              </div>
            );
          return (
            // A packed group is as wide as its cluster of cards, or its one-line heading if that's wider.
            <div key={group.key} className={packed ? "w-max max-w-full" : "w-full"}>
              <GroupSection
                group={group}
                visibleCount={visibleCountByKey.get(group.key) ?? group.items.length}
                regionId={regionId}
                onToggle={() => toggleCollapsed(group.key)}
                onChanged={onChanged}
                archivableGroup={groupBy === "group" || groupBy === "broad"}
                showVolumeBadge={multiDriveInUse}
                cardMinWidth={cardMinWidth}
                regionName={regionName}
                countryRegionId={countryRegionId}
                countryRegionName={countryRegionName}
                hideLabels={hideLabels}
                hideNames={hideNames}
                hideScientificName={hideScientificName}
                clusterColumns={packed ? clusterColumns(group.items.length, rowMax) : undefined}
              />
            </div>
          );
        })}
      </div>
      {hasMore && <div ref={setSentinel} className="h-10" />}
    </div>
  );
}

/** A collapsed group, in its own place in the list: just its heading, which opens it again there. */
function CollapsedGroupHeading({ group, onToggle }: { group: SpeciesGroup; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      aria-expanded="false"
      data-group-heading={group.key}
      className="flex w-max items-center gap-2 text-left text-sm font-medium text-ink hover:underline"
    >
      <span className="text-muted">▸</span>
      {group.label}
      <span className="text-xs font-normal text-muted">({group.items.length})</span>
    </button>
  );
}

function GroupSection({
  group,
  visibleCount,
  regionId,
  onToggle,
  onChanged,
  archivableGroup,
  wide,
  clusterColumns: clusterCols,
  showVolumeBadge,
  cardMinWidth = 160,
  regionName,
  countryRegionId,
  countryRegionName,
  hideLabels,
  hideNames,
  hideScientificName,
}: {
  group: SpeciesGroup;
  /** Cards rendered; the header count and bulk archive use the full list. */
  visibleCount: number;
  regionId: string | undefined;
  onToggle: () => void;
  onChanged?: SpeciesChangeHandler;
  /** Only real taxonomic groups offer "Archive group"; archiving a whole tier would be a surprise. */
  archivableGroup?: boolean;
  /** Pinned sections use the full-width grid, like ungrouped. */
  wide?: boolean;
  /** Set for a cluster beside other groups: its column count. Its heading stays on one line. */
  clusterColumns?: number;
  showVolumeBadge?: boolean;
  cardMinWidth?: number;
  regionName?: string;
  countryRegionId?: string;
  countryRegionName?: string;
  hideLabels?: boolean;
  hideNames?: boolean;
  hideScientificName?: boolean;
}) {
  const [archiving, setArchiving] = useState(false);
  const confirm = useConfirm();
  const toast = useToast();
  const archivable = archivableGroup && group.key !== COLLECTED_GROUP_KEY;

  async function archiveGroup() {
    const ok = await confirm({
      title: `Archive all ${group.items.length} species in "${group.label}"?`,
      message: "You can unarchive them later from the Archived page.",
      confirmLabel: "Archive group",
    });
    if (!ok) return;
    setArchiving(true);
    try {
      const speciesIds = group.items.map((i) => i.speciesId);
      await api.post("/archive/bulk", { speciesIds });
      onChanged?.(speciesIds, "removed");
    } catch {
      toast.error("Couldn't archive this group. Try again.");
    } finally {
      setArchiving(false);
    }
  }

  // Off-screen groups skip layout and paint until scrolled near (content-visibility), so a region
  // grouped into a hundred families doesn't lay out every one of them on each change.
  return (
    <section style={{ contentVisibility: "auto", containIntrinsicSize: "auto 320px" }}>
      {/* The archive action sits right after the name, not across the group's width. */}
      <div className={`mb-2 flex items-center gap-x-3 gap-y-1 ${clusterCols ? "whitespace-nowrap" : "flex-wrap"}`}>
        <button
          onClick={onToggle}
          aria-expanded="true"
          data-group-heading={group.key}
          className="flex items-center gap-2 text-left text-sm font-medium text-ink"
        >
          <span className="text-muted">▾</span>
          {group.label}
          <span className="text-xs font-normal text-muted">({group.items.length})</span>
        </button>
        {archivable && (
          <button
            onClick={archiveGroup}
            disabled={archiving}
            title="Archive every species in this group. They'll stop counting toward your to-collect total, and you can unarchive them later."
            className="shrink-0 text-xs text-muted hover:text-ink hover:underline disabled:opacity-50"
          >
            {archiving ? "Archiving…" : "Archive group"}
          </button>
        )}
      </div>
      <div
        className="grid"
        style={{
          // Every card at the size the slider picked, so groups side by side always match.
          gridTemplateColumns: wide
            ? `repeat(auto-fill, ${cardMinWidth}px)`
            : clusterCols
              ? `repeat(${clusterCols}, ${cardMinWidth}px)`
              : `repeat(auto-fill, ${cardMinWidth}px)`,
          gap: gapPxFor(cardMinWidth),
        }}
      >
        {group.items.slice(0, visibleCount).map((item) => (
          <SpeciesCard
            key={item.speciesId}
            item={item}
            regionId={regionId}
            regionName={regionName}
            countryRegionId={countryRegionId}
            countryRegionName={countryRegionName}
            onChanged={onChanged}
            showVolumeBadge={showVolumeBadge}
            hideLabels={hideLabels}
            hideNames={hideNames}
            hideScientificName={hideScientificName}
            compact={cardMinWidth <= COMPACT_CARD_WIDTH}
          />
        ))}
      </div>
    </section>
  );
}
