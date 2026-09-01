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
const INITIAL_VISIBLE = 300;
const VISIBLE_STEP = 300;

export type GroupBy = "none" | "group" | "tier" | "localTier";
export type SortBy = "taxonomic" | "name" | "rarity" | "localRarity";

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
  onArchived,
}: {
  items: CollectionItem[];
  regionId?: string;
  groupBy: GroupBy;
  sortBy: SortBy;
  collectedFirst: boolean;
  /** Independent of collectedFirst — either can be on without the other. Pin order when both
   *  are on is always Collected above Seen, since a photographed species is a stronger signal
   *  than a merely-seen one, not because the two toggles are coupled. */
  seenFirst: boolean;
  /** Called after an archive/unarchive action succeeds (single or bulk) so the parent can
   *  refetch — archived species are excluded server-side, so the only correct way to reflect
   *  a change here is to reload, not to guess at how to patch local state. */
  onArchived?: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const { multiDriveInUse } = useStorageVolumes();

  // A fresh filter/sort/region change should start back at the cap, not keep whatever was
  // revealed for a totally different, possibly much larger, previous list.
  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE);
  }, [items, groupBy, sortBy, collectedFirst, seenFirst]);

  // Rank used for the ungrouped "float to top" sort below — only ranks a state ahead of
  // "everything else" when its own toggle is actually on, so collectedFirst/seenFirst stay
  // fully independent (either can be on without the other) while still cooperating correctly
  // when both are on at once (collected above seen, seen above the rest).
  function floatRank(state: string): number {
    if (state === "collected") return collectedFirst ? 0 : 2;
    if (state === "seen") return seenFirst ? (collectedFirst ? 1 : 0) : 2;
    return 2;
  }

  const groups = useMemo(() => {
    const sorted = sortItems(items, sortBy);

    if (groupBy === "none") {
      // "Collected first" / "Seen first" float their own state to the top of the single list
      // — independent toggles, so either can be on alone, or both (collected above seen).
      const list = collectedFirst || seenFirst ? [...sorted].sort((a, b) => floatRank(a.state) - floatRank(b.state)) : sorted;
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
          : speciesGroupLabel(item.taxonClass, item.family);
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

    // "Collected first" / "Seen first" while grouped: independent pinned groups up top
    // showing everything already found and/or seen, on top of — not instead of — the normal
    // family/tier breakdown below, which still lists every species in its usual group. Order
    // is always Collected above Seen when both are on, same reasoning as floatRank above.
    const pinned: typeof named = [];
    if (collectedFirst) {
      const collectedItems = sorted.filter((i) => i.state === "collected");
      if (collectedItems.length > 0) pinned.push({ key: COLLECTED_GROUP_KEY, label: "Collected", items: collectedItems });
    }
    if (seenFirst) {
      const seenItems = sorted.filter((i) => i.state === "seen");
      if (seenItems.length > 0) pinned.push({ key: SEEN_GROUP_KEY, label: "Seen", items: seenItems });
    }
    return [...pinned, ...named];
  }, [items, groupBy, sortBy, collectedFirst, seenFirst]);

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
    for (const g of groups) map.set(g.key, 0);
    let remaining = visibleCount;
    let madeProgress = true;
    while (remaining > 0 && madeProgress) {
      madeProgress = false;
      for (const g of groups) {
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
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {visible.map((item) => (
            <SpeciesCard key={item.speciesId} item={item} regionId={regionId} onArchived={onArchived} showVolumeBadge={multiDriveInUse} />
          ))}
        </div>
        {hasMore && <div ref={sentinelRef} className="h-10" />}
      </>
    );
  }

  // `groups` above only ever contains a pinned entry when its own toggle was actually on, so
  // this doesn't need to re-check collectedFirst/seenFirst itself.
  const pinnedKeys = new Set([COLLECTED_GROUP_KEY, SEEN_GROUP_KEY]);
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
      alert("Couldn't archive this group — try again.");
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
            title="Archive every species in this group — they'll stop counting toward your to-collect total, and you can unarchive them later"
            className="shrink-0 text-xs text-muted hover:text-ink hover:underline disabled:opacity-50"
          >
            {archiving ? "Archiving…" : "Archive group"}
          </button>
        )}
      </div>
      <div
        className={
          wide
            ? "grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6"
            : "grid grid-cols-2 gap-4 sm:grid-cols-3"
        }
      >
        {group.items.slice(0, visibleCount).map((item) => (
          <SpeciesCard key={item.speciesId} item={item} regionId={regionId} onArchived={onArchived} showVolumeBadge={showVolumeBadge} />
        ))}
      </div>
    </section>
  );
}
