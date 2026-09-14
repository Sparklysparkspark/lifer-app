import { useEffect, useMemo, useRef, useState } from "react";
import type { CollectionItem } from "@lifer/shared";
import { api } from "../api/client";
import SpeciesCard from "./SpeciesCard";
import { speciesGroupLabel } from "../lib/speciesGroups";
import { useStorageVolumes } from "../hooks/useStorageVolumes";

// Rendering every matching species as a real DOM node (each with its own <img> and, via
// SpeciesCard's useFitText, a ResizeObserver) is fine for a region's checklist — usually a few
// hundred to a couple thousand — but "All species" / no region selected can be 60,000+, which
// locks up the main thread badly enough that even clicking "Browse by region" stops responding.
// Rendered items are capped and revealed incrementally on scroll instead of all at once.
// Each newly-mounted SpeciesCard runs useFitText's useLayoutEffect — a synchronous, paint-
// blocking reflow (getComputedStyle + scrollHeight, both force layout) — so mounting a whole
// batch at once means that many forced reflows back to back on the main thread before the
// browser can paint anything. 300 was fine for the checklist sizes this was tuned against, but
// now that region checklists can run into the thousands (see compute-provinces-inat.ts), a
// group-by/sort change or a scroll-triggered reveal on one of those regions mounts 300 cards in
// one commit, which is exactly what turned "grouping by rarity" into a multi-second freeze on a
// large country. Smaller batches trade a few more scroll-triggered reveals for a commit that
// actually stays responsive.
const INITIAL_VISIBLE = 60;
const VISIBLE_STEP = 60;

export type GroupBy = "none" | "group" | "tier" | "localTier";
export type SortBy = "taxonomic" | "name" | "rarity" | "localRarity" | "seasonality";

// Approximate week-of-year index (0-51), matching WeeklyBar's own 52-bucket indexing (index 0 =
// week 1). Good enough for "what's most likely to turn up this week" sorting - not meant to be
// exact ISO-week arithmetic.
function currentWeekIndex(): number {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const dayOfYear = Math.floor((now.getTime() - start.getTime()) / 86_400_000);
  return Math.min(51, Math.floor(dayOfYear / 7));
}

// Same shrink-with-size formula GalleryPage uses for its own grid gap (thumbSizePx / 30,
// clamped 3-8px) — at the smallest card size the fixed gap-4 (16px) read as disproportionately
// wide next to a tiny card, and didn't match how Gallery's own grid tightens up already.
function gapPxFor(cardMinWidth: number): number {
  return Math.round(Math.min(8, Math.max(3, cardMinWidth / 30)));
}

// "unrated" ranks after "common", not before — it isn't easier than common, it's simply
// unknown (mammals/fish with no real distinguishing data at all).
const TIER_RANK: Record<string, number> = { legendary: 0, epic: 1, rare: 2, uncommon: 3, common: 4, unrated: 5 };
const TIER_LABEL: Record<string, string> = {
  legendary: "Legendary",
  epic: "Epic",
  rare: "Rare",
  uncommon: "Uncommon",
  common: "Common",
  unrated: "Unrated",
};
const COLLECTED_GROUP_KEY = "__collected__";
const SEEN_GROUP_KEY = "__seen__";
const TARGET_GROUP_KEY = "__target__";

// groupBy and sortBy are independent: group by folk-taxonomy or rarity tier, then sort
// within (or across, if ungrouped) by whichever of taxonomic/name/rarity order. Array.sort
// is stable in every engine this app runs on, so applying a secondary sort preserves the
// primary one within each bucket.
function sortItems(items: CollectionItem[], sortBy: SortBy): CollectionItem[] {
  const sorted = [...items];
  if (sortBy === "rarity") {
    sorted.sort((a, b) => (TIER_RANK[a.tier ?? "common"] ?? 5) - (TIER_RANK[b.tier ?? "common"] ?? 5));
  } else if (sortBy === "localRarity") {
    // Only populated on GET /regions/:id/species rows (see CollectionItem.localTier's own
    // comment) — falls back to the global tier when it's null, same "common" default as the
    // plain rarity sort above, so this option degrades gracefully rather than bunching
    // everything together if somehow used outside a region view.
    sorted.sort((a, b) => (TIER_RANK[a.localTier ?? a.tier ?? "common"] ?? 5) - (TIER_RANK[b.localTier ?? b.tier ?? "common"] ?? 5));
  } else if (sortBy === "name") {
    sorted.sort((a, b) => (a.commonName ?? a.scientificName).localeCompare(b.commonName ?? b.scientificName));
  } else if (sortBy === "seasonality") {
    const week = currentWeekIndex();
    sorted.sort((a, b) => (b.seasonality?.[week] ?? 0) - (a.seasonality?.[week] ?? 0));
  }
  // "taxonomic" is the server's own default order — no client-side re-sort needed for it.
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
  onArchived,
  cardMinWidth = 160,
  regionName,
  countryRegionId,
  countryRegionName,
  hideRarityLabels,
}: {
  items: CollectionItem[];
  regionId?: string;
  groupBy: GroupBy;
  sortBy: SortBy;
  /** Minimum card width in px, driven by the page's Size slider — the grid packs as many
   *  cards per row as fit via auto-fill/minmax rather than a fixed Tailwind breakpoint count. */
  cardMinWidth?: number;
  /** Display name of regionId, and the enclosing country's id/name when regionId is a
   *  province — threaded straight through to SpeciesCard's own province-vs-country hide
   *  picker (see its own comment). */
  regionName?: string;
  countryRegionId?: string;
  countryRegionName?: string;
  /** Collections' "Hide rarity labels" display toggle, threaded straight through to every
   *  SpeciesCard. */
  hideRarityLabels?: boolean;
  collectedFirst: boolean;
  /** Independent of collectedFirst — either can be on without the other. Pin order when both
   *  are on is always Collected above Seen, since a photographed species is a stronger signal
   *  than a merely-seen one, not because the two toggles are coupled. */
  seenFirst: boolean;
  /** Independent of the other two — pins your wishlist (still-uncollected) species instead of
   *  requiring the per-card star badge to spot them, same reasoning SpeciesCard's own removal
   *  of that badge had: a dedicated toggle finds every target at once instead of scanning for
   *  one icon across a whole grid. Sorts last when stacked with the other two (collected/seen
   *  are real progress; a target is a to-do, not an achievement to lead with). */
  targetFirst: boolean;
  /** Called after an archive/unarchive action succeeds (single or bulk) so the parent can
   *  refetch — archived species are excluded server-side, so the only correct way to reflect
   *  a change here is to reload, not to guess at how to patch local state. */
  onArchived?: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const { multiDriveInUse } = useStorageVolumes();
  // Other Taxa group labels ("Insects" vs "Insecta" vs "Insects - Insecta") follow the same
  // species_naming_styles preference used for folder/EXIF naming — a group label has the same
  // Latin-vs-common question a species name does. Fetched once here rather than threaded down
  // as a prop, same self-contained pattern SpeciesPicker uses for its own settings-driven bit.
  const [namingStyles, setNamingStyles] = useState<string[]>([]);
  useEffect(() => {
    api.get<{ speciesNamingStyles: string[] }>("/settings").then((res) => setNamingStyles(res.speciesNamingStyles)).catch(() => {});
  }, []);

  // A fresh filter/sort/region change should start back at the cap, not keep whatever was
  // revealed for a totally different, possibly much larger, previous list. This used to be a
  // useEffect, which only runs AFTER the commit/paint — so the very first render after e.g.
  // switching groupBy still used the stale, possibly thousands-large visibleCount from whatever
  // infinite-scroll had grown it to, round-robined across the newly regrouped buckets below.
  // On the ungrouped "All species" view (60k+ rows), that one transient render could mount
  // thousands of cards at once, each forcing a synchronous layout reflow in useFitText — a
  // multi-minute freeze. Resetting during render (the React-documented pattern for exactly this
  // "derived state" case) means the reset lands before anything below ever sees the stale count.
  const resetKeyRef = useRef({ items, groupBy, sortBy, collectedFirst, seenFirst, targetFirst });
  const resetKeyChanged =
    resetKeyRef.current.items !== items ||
    resetKeyRef.current.groupBy !== groupBy ||
    resetKeyRef.current.sortBy !== sortBy ||
    resetKeyRef.current.collectedFirst !== collectedFirst ||
    resetKeyRef.current.seenFirst !== seenFirst ||
    resetKeyRef.current.targetFirst !== targetFirst;
  if (resetKeyChanged) {
    resetKeyRef.current = { items, groupBy, sortBy, collectedFirst, seenFirst, targetFirst };
    if (visibleCount !== INITIAL_VISIBLE) setVisibleCount(INITIAL_VISIBLE);
  }

  // Rank used for the ungrouped "float to top" sort below — only ranks a state ahead of
  // "everything else" when its own toggle is actually on, so collectedFirst/seenFirst/
  // targetFirst stay fully independent (any subset can be on) while still cooperating
  // correctly when several are on at once (collected above seen above target above the rest).
  function floatRank(item: CollectionItem): number {
    if (collectedFirst && item.state === "collected") return 0;
    if (seenFirst && item.state === "seen") return collectedFirst ? 1 : 0;
    if (targetFirst && item.isTarget) return (collectedFirst ? 1 : 0) + (seenFirst ? 1 : 0);
    return 3;
  }

  const groups = useMemo(() => {
    const sorted = sortItems(items, sortBy);

    if (groupBy === "none") {
      // "Collected first" / "Seen first" / "Targets first" float their own state to the top of
      // the single list — independent toggles, any subset can be on at once.
      const list =
        collectedFirst || seenFirst || targetFirst
          ? [...sorted].sort((a, b) => floatRank(a) - floatRank(b))
          : sorted;
      return [{ key: "", label: "", items: list }];
    }

    const byTier = groupBy === "tier" || groupBy === "localTier";
    const byKey = new Map<string, CollectionItem[]>();
    for (const item of sorted) {
      // "Rarity here" falls back to the global tier when localTier is null (see
      // CollectionItem.localTier's own comment) — same graceful-degrade as the sort option.
      const key = groupBy === "tier"
        ? item.tier ?? "common"
        : groupBy === "localTier"
          ? item.localTier ?? item.tier ?? "common"
          : speciesGroupLabel(item.taxonClass, item.family, item.isOtherTaxa, item.inatIconicTaxon, namingStyles);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(item);
    }

    const keys = [...byKey.keys()];
    if (byTier) keys.sort((a, b) => (TIER_RANK[a] ?? 5) - (TIER_RANK[b] ?? 5));
    else keys.sort((a, b) => a.localeCompare(b));

    const named = keys.map((key) => ({
      key,
      label: byTier ? TIER_LABEL[key] ?? key : key,
      items: byKey.get(key)!,
    }));

    // "Collected first" / "Seen first" / "Targets first" while grouped: independent pinned
    // groups up top, on top of — not instead of — the normal family/tier breakdown below,
    // which still lists every species in its usual group. Order is always Collected above
    // Seen above Targets when more than one is on, same reasoning as floatRank above.
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

  // How many of EACH group's items are actually rendered as cards right now — the cap applies
  // to the page as a whole (not per group), while a group's header/bulk-archive action still
  // sees its true, uncapped item list. Distributed round-robin (one item per group per pass)
  // rather than drained sequentially in group order — sequential draining starved any group
  // sitting later in order once earlier groups alone exceeded the budget (concretely: sorting/
  // grouping by rarity tier put "Common" last, and since it's usually the single largest tier
  // by far, Legendary+Epic+Rare+Uncommon combined routinely exceeded the whole budget on their
  // own, leaving Common permanently empty no matter how much the user scrolled — the group
  // never got a turn). Round-robin guarantees every group gets a fair initial share.
  const visibleCountByKey = useMemo(() => {
    const map = new Map<string, number>();
    // Smallest group fully satisfied first, THEN move to the next-smallest — a tier like
    // Legendary is often the smallest by far (that's the whole point of rarity), and an even
    // round-robin split (1-per-pass-per-group) gave it only its flat 1/Nth share of the shared
    // budget same as every other group, so it showed up visibly truncated (e.g. "Legendary
    // (50)" rendering only 10) even though the whole group would easily have fit. Since a group
    // this small consumes only a sliver of the total budget once actually satisfied, giving it
    // that sliver up front costs the bigger groups almost nothing, and no group ever needs a
    // second scroll-triggered reveal just to finish rendering something that already fit.
    // Whatever's left over after every group that CAN fit within the budget gets fully filled
    // is still split evenly across the remaining (necessarily larger) groups, same reasoning
    // the old round-robin used, just applied only to the leftover instead of the whole budget.
    const bySize = [...groups].sort((a, b) => a.items.length - b.items.length);
    let remaining = visibleCount;
    const stillGrowing: typeof groups = [];
    for (const g of bySize) {
      if (remaining >= g.items.length) {
        map.set(g.key, g.items.length);
        remaining -= g.items.length;
      } else {
        map.set(g.key, 0);
        stillGrowing.push(g);
      }
    }
    let madeProgress = true;
    while (remaining > 0 && madeProgress) {
      madeProgress = false;
      for (const g of stillGrowing) {
        if (remaining <= 0) break;
        const current = map.get(g.key)!;
        if (current < g.items.length) {
          map.set(g.key, current + 1);
          remaining--;
          madeProgress = true;
        }
      }
    }
    return map;
  }, [groups, visibleCount]);
  const totalItemCount = useMemo(() => groups.reduce((sum, g) => sum + g.items.length, 0), [groups]);
  const hasMore = visibleCount < totalItemCount;

  useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) setVisibleCount((c) => c + VISIBLE_STEP);
      },
      { rootMargin: "600px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore]);

  function toggleCollapsed(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Ungrouped is just one continuous list — the multi-column packing below exists to sit
  // several SMALL groups side by side, which doesn't apply here, so it keeps the plain wide
  // grid (up to 6 columns) instead of being squeezed into 2-3 packing columns.
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
              onArchived={onArchived}
              showVolumeBadge={multiDriveInUse}
              hideRarityLabels={hideRarityLabels}
            />
          ))}
        </div>
        {hasMore && <div ref={sentinelRef} className="h-10" />}
      </>
    );
  }

  // `groups` above only ever contains a pinned entry when its own toggle was actually on, so
  // this doesn't need to re-check collectedFirst/seenFirst itself.
  const pinnedKeys = new Set([COLLECTED_GROUP_KEY, SEEN_GROUP_KEY, TARGET_GROUP_KEY]);
  const pinnedGroups = groups.filter((g) => pinnedKeys.has(g.key));
  const rest = groups.filter((g) => !pinnedKeys.has(g.key));
  const collapsedGroups = rest.filter((g) => collapsed.has(g.key));
  // A group whose visible-item budget ran out (see visibleCountByKey — a shared budget consumed
  // in group order, so most groups get 0 once there are more groups than fit in visibleCount)
  // still incurs full section layout cost — header, grid, and CSS `columns` placement — for
  // literally nothing visible. With dozens of family groups this was the actual source of the
  // "family grouping" lag spike: WebKit's multi-column balancing algorithm scales with the
  // number of break-inside-avoid blocks in the container, not just visible card count, so
  // rendering ~80 empty sections alongside a handful of real ones was real, measurable cost for
  // zero visual benefit — the IntersectionObserver sentinel reveals more of them on scroll
  // anyway, at which point they start rendering for real.
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
          collapsed={false}
          onToggle={() => toggleCollapsed(group.key)}
          onArchived={onArchived}
          wide
          showVolumeBadge={multiDriveInUse}
          cardMinWidth={cardMinWidth}
          regionName={regionName}
          countryRegionId={countryRegionId}
          countryRegionName={countryRegionName}
          hideRarityLabels={hideRarityLabels}
        />
      ))}

      {/* Collapsed groups move here as compact chips instead of sitting in the vertical
         flow as empty-but-still-present sections, so collapsing several doesn't mean
         scrolling past all of them to reach what's still expanded. */}
      {(collapsedGroups.length > 0 || collapsedPinnedGroups.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface p-2">
          <span className="text-xs uppercase tracking-wide text-muted">Collapsed:</span>
          {collapsedPinnedGroups.map((g) => (
            <button
              key={g.key}
              onClick={() => toggleCollapsed(g.key)}
              className="rounded-full border border-line px-2.5 py-1 text-xs text-muted hover:bg-surface-muted"
            >
              {g.label} ({g.items.length})
            </button>
          ))}
          {collapsedGroups.map((g) => (
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

      {/* Multi-column flow: a family with only 2-3 species doesn't force a full-width,
         mostly-empty row; several small groups can sit side by side in adjacent columns
         instead. break-inside-avoid keeps one group's card grid from being split across
         two columns. */}
      <div className="columns-1 gap-6 sm:columns-2 xl:columns-3">
        {expandedGroups.map((group) => (
          <div key={group.key} className="break-inside-avoid">
            <GroupSection
              group={group}
              visibleCount={visibleCountByKey.get(group.key) ?? group.items.length}
              regionId={regionId}
              collapsed={false}
              onToggle={() => toggleCollapsed(group.key)}
              onArchived={onArchived}
              archivableGroup={groupBy === "group"}
              showVolumeBadge={multiDriveInUse}
              cardMinWidth={cardMinWidth}
              regionName={regionName}
              countryRegionId={countryRegionId}
              countryRegionName={countryRegionName}
              hideRarityLabels={hideRarityLabels}
            />
          </div>
        ))}
      </div>
      {hasMore && <div ref={sentinelRef} className="h-10" />}
    </div>
  );
}

function GroupSection({
  group,
  visibleCount,
  regionId,
  collapsed,
  onToggle,
  onArchived,
  archivableGroup,
  wide,
  showVolumeBadge,
  cardMinWidth = 160,
  regionName,
  countryRegionId,
  countryRegionName,
  hideRarityLabels,
}: {
  group: { key: string; label: string; items: CollectionItem[] };
  /** How many of this group's items to actually render as cards — the header count and the
   *  bulk archive action still use the group's true, uncapped item list (see
   *  GroupedSpeciesGrid's visibleCountByKey comment). */
  visibleCount: number;
  regionId: string | undefined;
  collapsed: boolean;
  onToggle: () => void;
  onArchived?: () => void;
  /** True only when grouped by family/folk-taxonomy (`groupBy === "group"`) — archiving "all
   *  Legendary species" or "all Collected species" by tier would be a confusing, likely
   *  unintended bulk action, so the button only ever appears on a genuine taxonomic group. */
  archivableGroup?: boolean;
  /** The pinned "Collected"/"Seen" sections get the full-width grid, same as ungrouped — a
   *  highlight strip, not one of the packed small-group tiles. */
  wide?: boolean;
  showVolumeBadge?: boolean;
  /** Minimum card width in px, driven by the page's Size slider. */
  cardMinWidth?: number;
  regionName?: string;
  countryRegionId?: string;
  countryRegionName?: string;
  hideRarityLabels?: boolean;
}) {
  const [archiving, setArchiving] = useState(false);
  const archivable = archivableGroup && group.key !== COLLECTED_GROUP_KEY;

  async function archiveGroup() {
    if (!confirm(`Archive all ${group.items.length} species in "${group.label}"? You can unarchive them later from the Archived page.`)) {
      return;
    }
    setArchiving(true);
    try {
      await api.post("/archive/bulk", { speciesIds: group.items.map((i) => i.speciesId) });
      onArchived?.();
    } catch {
      alert("Couldn't archive this group. Try again.");
    } finally {
      setArchiving(false);
    }
  }

  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center gap-2">
        <button onClick={onToggle} className="flex flex-1 items-center gap-2 text-left text-sm font-medium text-ink">
          <span className="text-muted">{collapsed ? "▸" : "▾"}</span>
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
            onArchived={onArchived}
            showVolumeBadge={showVolumeBadge}
            hideRarityLabels={hideRarityLabels}
          />
        ))}
      </div>
    </section>
  );
}
