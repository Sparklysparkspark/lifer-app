import { useMemo, useState } from "react";
import type { CollectionItem } from "@lifer/shared";
import SpeciesCard from "./SpeciesCard";
import { speciesGroupLabel } from "../lib/speciesGroups";

export type GroupBy = "none" | "group" | "tier";
export type SortBy = "taxonomic" | "name" | "rarity";

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

// groupBy and sortBy are independent: group by folk-taxonomy or rarity tier, then sort
// within (or across, if ungrouped) by whichever of taxonomic/name/rarity order. Array.sort
// is stable in every engine this app runs on, so applying a secondary sort preserves the
// primary one within each bucket.
function sortItems(items: CollectionItem[], sortBy: SortBy): CollectionItem[] {
  const sorted = [...items];
  if (sortBy === "rarity") {
    sorted.sort((a, b) => (TIER_RANK[a.tier ?? "common"] ?? 5) - (TIER_RANK[b.tier ?? "common"] ?? 5));
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
}: {
  items: CollectionItem[];
  regionId?: string;
  groupBy: GroupBy;
  sortBy: SortBy;
  collectedFirst: boolean;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const sorted = sortItems(items, sortBy);

    if (groupBy === "none") {
      // Ungrouped: "collected first" just means collected items float to the top of the
      // single list, same as before.
      const list = collectedFirst
        ? [...sorted].sort((a, b) => (a.state === "collected" ? 0 : 1) - (b.state === "collected" ? 0 : 1))
        : sorted;
      return [{ key: "", label: "", items: list }];
    }

    const byKey = new Map<string, CollectionItem[]>();
    for (const item of sorted) {
      const key = groupBy === "tier" ? item.tier ?? "common" : speciesGroupLabel(item.taxonClass, item.family);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(item);
    }

    const keys = [...byKey.keys()];
    if (groupBy === "tier") keys.sort((a, b) => (TIER_RANK[a] ?? 5) - (TIER_RANK[b] ?? 5));
    else keys.sort((a, b) => a.localeCompare(b));

    const named = keys.map((key) => ({
      key,
      label: groupBy === "tier" ? TIER_LABEL[key] ?? key : key,
      items: byKey.get(key)!,
    }));

    // "Collected first" while grouped: a pinned "Collected" group up top showing everything
    // already found, on top of — not instead of — the normal family/tier breakdown below,
    // which still lists every species in its usual group.
    if (!collectedFirst) return named;
    const collectedItems = sorted.filter((i) => i.state === "collected");
    if (collectedItems.length === 0) return named;
    return [{ key: COLLECTED_GROUP_KEY, label: "Collected", items: collectedItems }, ...named];
  }, [items, groupBy, sortBy, collectedFirst]);

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
    return (
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {groups[0].items.map((item) => (
          <SpeciesCard key={item.speciesId} item={item} regionId={regionId} />
        ))}
      </div>
    );
  }

  const pinnedCollected = collectedFirst ? groups.find((g) => g.key === COLLECTED_GROUP_KEY) : null;
  const rest = groups.filter((g) => g.key !== COLLECTED_GROUP_KEY);
  const collapsedGroups = rest.filter((g) => collapsed.has(g.key));
  const expandedGroups = rest.filter((g) => !collapsed.has(g.key));
  const collectedCollapsed = pinnedCollected ? collapsed.has(COLLECTED_GROUP_KEY) : false;

  return (
    <div className="space-y-4">
      {pinnedCollected &&
        (collectedCollapsed ? null : (
          <GroupSection
            group={pinnedCollected}
            regionId={regionId}
            collapsed={false}
            onToggle={() => toggleCollapsed(COLLECTED_GROUP_KEY)}
            wide
          />
        ))}

      {/* Collapsed groups move here as compact chips instead of sitting in the vertical
         flow as empty-but-still-present sections, so collapsing several doesn't mean
         scrolling past all of them to reach what's still expanded. */}
      {(collapsedGroups.length > 0 || collectedCollapsed) && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-stone-200 bg-white p-2">
          <span className="text-xs uppercase tracking-wide text-stone-400">Collapsed:</span>
          {collectedCollapsed && pinnedCollected && (
            <button
              onClick={() => toggleCollapsed(COLLECTED_GROUP_KEY)}
              className="rounded-full border border-stone-300 px-2.5 py-1 text-xs text-stone-600 hover:bg-stone-100"
            >
              {pinnedCollected.label} ({pinnedCollected.items.length})
            </button>
          )}
          {collapsedGroups.map((g) => (
            <button
              key={g.key}
              onClick={() => toggleCollapsed(g.key)}
              className="rounded-full border border-stone-300 px-2.5 py-1 text-xs text-stone-600 hover:bg-stone-100"
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
            <GroupSection group={group} regionId={regionId} collapsed={false} onToggle={() => toggleCollapsed(group.key)} />
          </div>
        ))}
      </div>
    </div>
  );
}

function GroupSection({
  group,
  regionId,
  collapsed,
  onToggle,
  wide,
}: {
  group: { key: string; label: string; items: CollectionItem[] };
  regionId: string | undefined;
  collapsed: boolean;
  onToggle: () => void;
  /** The pinned "Collected" section gets the full-width grid, same as ungrouped — it's a
   *  highlight strip, not one of the packed small-group tiles. */
  wide?: boolean;
}) {
  return (
    <section className="mb-6">
      <button onClick={onToggle} className="mb-2 flex w-full items-center gap-2 text-left text-sm font-medium text-stone-700">
        <span className="text-stone-400">{collapsed ? "▸" : "▾"}</span>
        {group.label}
        <span className="text-xs font-normal text-stone-400">({group.items.length})</span>
      </button>
      <div
        className={
          wide
            ? "grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6"
            : "grid grid-cols-2 gap-4 sm:grid-cols-3"
        }
      >
        {group.items.map((item) => (
          <SpeciesCard key={item.speciesId} item={item} regionId={regionId} />
        ))}
      </div>
    </section>
  );
}
