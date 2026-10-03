import { useEffect, useMemo, useRef, useState } from "react";
import type { CollectionItem } from "@lifer/shared";
import { api } from "../api/client";
import SpeciesCard, { type SpeciesChangeHandler } from "./SpeciesCard";
import { TIER_LABEL, speciesGroupLabel } from "../lib/speciesGroups";
import { primaryBroadGroup } from "../lib/broadGroups";
import { useStorageVolumes } from "../hooks/useStorageVolumes";
import { useSettings } from "../hooks/useSettings";
import { useConfirm } from "../hooks/useConfirm";
import { useToast } from "../hooks/useToast";

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

// At or below this card width the name box uses tighter spacing (see SpeciesCard `compact`).
const COMPACT_CARD_WIDTH = 150;

// Groups with more species than this span the full width instead of sharing a row.
const WIDE_GROUP_MIN = 8;

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
function sortItems(items: CollectionItem[], sortBy: SortBy): CollectionItem[] {
  const sorted = [...items];
  if (sortBy === "rarity") {
    sorted.sort((a, b) => (TIER_RANK[a.tier ?? "common"] ?? 5) - (TIER_RANK[b.tier ?? "common"] ?? 5));
  } else if (sortBy === "localRarity") {
    // localTier only exists on region rows; falls back to the global tier.
    sorted.sort((a, b) => (TIER_RANK[a.localTier ?? a.tier ?? "common"] ?? 5) - (TIER_RANK[b.localTier ?? b.tier ?? "common"] ?? 5));
  } else if (sortBy === "name") {
    sorted.sort((a, b) => (a.commonName ?? a.scientificName).localeCompare(b.commonName ?? b.scientificName));
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
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  // A callback ref, not useRef: toggling grouping renders a new sentinel element, and an observer on
  // the old one would never fire again.
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  const { multiDriveInUse } = useStorageVolumes();
  // Other Taxa group labels follow the species naming preference ("Insects" vs "Insecta").
  const { settings } = useSettings();
  const namingStyles = useMemo(() => settings?.speciesNamingStyles ?? [], [settings?.speciesNamingStyles]);

  // A new list starts back at the cap. Reset during render, not in an effect, so a stale large count
  // never commits. resetKey names what's viewed, so a background reload or one-row patch keeps cards.
  const listKey = resetKey ?? items;
  const resetKeyRef = useRef({ listKey, groupBy, sortBy, collectedFirst, seenFirst, targetFirst });
  const resetKeyChanged =
    resetKeyRef.current.listKey !== listKey ||
    resetKeyRef.current.groupBy !== groupBy ||
    resetKeyRef.current.sortBy !== sortBy ||
    resetKeyRef.current.collectedFirst !== collectedFirst ||
    resetKeyRef.current.seenFirst !== seenFirst ||
    resetKeyRef.current.targetFirst !== targetFirst;
  if (resetKeyChanged) {
    resetKeyRef.current = { listKey, groupBy, sortBy, collectedFirst, seenFirst, targetFirst };
    if (visibleCount !== INITIAL_VISIBLE) setVisibleCount(INITIAL_VISIBLE);
  }

  // Ungrouped "float to top" rank: only a state whose toggle is on moves ahead of the rest.
  function floatRank(item: CollectionItem): number {
    if (collectedFirst && item.state === "collected") return 0;
    if (seenFirst && item.state === "seen") return collectedFirst ? 1 : 0;
    if (targetFirst && item.isTarget) return (collectedFirst ? 1 : 0) + (seenFirst ? 1 : 0);
    return 3;
  }

  const groups = useMemo(() => {
    const sorted = sortItems(items, sortBy);

    if (groupBy === "none") {
      const list =
        collectedFirst || seenFirst || targetFirst
          ? [...sorted].sort((a, b) => floatRank(a) - floatRank(b))
          : sorted;
      return [{ key: "", label: "", items: list }];
    }

    const byTier = groupBy === "tier" || groupBy === "localTier";
    const byKey = new Map<string, CollectionItem[]>();
    for (const item of sorted) {
      // "Rarity here" falls back to the global tier when localTier is null.
      const key = groupBy === "tier"
        ? item.tier ?? "common"
        : groupBy === "localTier"
          ? item.localTier ?? item.tier ?? "common"
          : groupBy === "broad"
            ? primaryBroadGroup(item)
            : speciesGroupLabel(item.taxonClass, item.family, item.isOtherTaxa, item.inatIconicTaxon, namingStyles);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(item);
    }

    const keys = [...byKey.keys()];
    if (byTier) keys.sort((a, b) => (TIER_RANK[a] ?? 5) - (TIER_RANK[b] ?? 5));
    // Leftovers ("Other Birds") go after the named groups.
    else keys.sort((a, b) => Number(a.startsWith("Other ")) - Number(b.startsWith("Other ")) || a.localeCompare(b));

    const named = keys.map((key) => ({
      key,
      label: byTier ? TIER_LABEL[key] ?? key : key,
      items: byKey.get(key)!,
    }));

    // While grouped, the pin toggles add pinned groups above the normal breakdown, which still
    // lists every species in its usual group.
    const pinned: typeof named = [];
    if (collectedFirst) {
      const collectedItems = sorted.filter((i) => i.state === "collected");
      if (collectedItems.length > 0) pinned.push({ key: COLLECTED_GROUP_KEY, label: "Collected", items: collectedItems });
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
  }, [items, groupBy, sortBy, collectedFirst, seenFirst, targetFirst, namingStyles]);

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
  const totalItemCount = useMemo(() => groups.reduce((sum, g) => sum + (collapsed.has(g.key) ? 0 : g.items.length), 0), [groups, collapsed]);
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

  function toggleCollapsed(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Ungrouped keeps the plain wide grid; the column packing below is for small groups.
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
  const collapsedGroups = rest.filter((g) => collapsed.has(g.key));
  // Groups with no budget yet aren't rendered: WebKit's column balancing cost scales with the
  // number of blocks, and the scroll sentinel reveals them later anyway.
  const expandedGroups = rest.filter((g) => !collapsed.has(g.key) && (visibleCountByKey.get(g.key) ?? 0) > 0);
  const expandedPinnedGroups = pinnedGroups.filter((g) => !collapsed.has(g.key) && (visibleCountByKey.get(g.key) ?? 0) > 0);
  const collapsedPinnedGroups = pinnedGroups.filter((g) => collapsed.has(g.key));

  return (
    <div className="space-y-4">
      {expandedPinnedGroups.map((group) => (
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
      ))}

      {/* Collapsed groups become chips so they don't take vertical space. */}
      {(collapsedGroups.length > 0 || collapsedPinnedGroups.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface p-2">
          <span className="text-xs uppercase tracking-wide text-muted">Collapsed:</span>
          {[...collapsedPinnedGroups, ...collapsedGroups].map((g) => (
            <button
              key={g.key}
              onClick={() => toggleCollapsed(g.key)}
              className="rounded-full border border-line px-2.5 py-1 text-xs text-muted hover:bg-surface-muted"
            >
              {g.label} ({g.items.length})
            </button>
          ))}
        </div>
      )}

      {/* Small groups sit side by side; a big one takes the full width. A grid, not CSS columns,
          since WebKit rebalances every column on each revealed batch. */}
      <div className="grid items-start gap-x-6 sm:grid-cols-2 xl:grid-cols-3">
        {expandedGroups.map((group) => (
          <div key={group.key} className={group.items.length > WIDE_GROUP_MIN ? "sm:col-span-2 xl:col-span-3" : undefined}>
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
            />
          </div>
        ))}
      </div>
      {hasMore && <div ref={setSentinel} className="h-10" />}
    </div>
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
  showVolumeBadge,
  cardMinWidth = 160,
  regionName,
  countryRegionId,
  countryRegionName,
  hideLabels,
  hideNames,
  hideScientificName,
}: {
  group: { key: string; label: string; items: CollectionItem[] };
  /** Cards rendered; the header count and bulk archive use the full list. */
  visibleCount: number;
  regionId: string | undefined;
  onToggle: () => void;
  onChanged?: SpeciesChangeHandler;
  /** Only real taxonomic groups offer "Archive group"; archiving a whole tier would be a surprise. */
  archivableGroup?: boolean;
  /** Pinned sections use the full-width grid, like ungrouped. */
  wide?: boolean;
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
    <section className="mb-6" style={{ contentVisibility: "auto", containIntrinsicSize: "auto 320px" }}>
      <div className="mb-2 flex items-center gap-2">
        <button onClick={onToggle} aria-expanded="true" className="flex flex-1 items-center gap-2 text-left text-sm font-medium text-ink">
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
          gridTemplateColumns: `repeat(auto-fill, minmax(${wide ? cardMinWidth : Math.min(cardMinWidth, 160)}px, 1fr))`,
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
