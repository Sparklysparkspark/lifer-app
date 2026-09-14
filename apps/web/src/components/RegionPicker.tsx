import SearchInput from "./SearchInput";

// Shared presentational shell for "pick a region from a pill list, optionally grouped under
// expandable headers, with a search box that jumps straight to a match" — the one visual/
// interaction pattern that was duplicated between OfflinePacksPage's own continent+country pills
// (multi-select, grouped by continent) and RegionBrowser's breadcrumb-drill pill row
// (single-select, flat list of the current node's children). Deliberately owns rendering only,
// not data-fetching or selection state — each caller still derives its own groups/items and
// handles what "select" means for it (multi-toggle vs single-select-and-navigate), since those
// concerns (map focus, taxon availability, download jobs on the packs page; breadcrumb
// navigation on the browser) are specific to each caller, not part of the picking UI itself.
export interface RegionPickerItem {
  id: string;
  name: string;
}

export interface RegionPickerGroup {
  id: string;
  label: string;
  items: RegionPickerItem[];
}

interface RegionPickerProps {
  // Provide either `groups` (rendered as expandable pill headers, e.g. continents) or a flat
  // `items` list (no headers, e.g. RegionBrowser's single-level "drill in" row) — not both.
  groups?: RegionPickerGroup[];
  items?: RegionPickerItem[];
  openGroupIds?: Set<string>;
  onToggleGroup?: (groupId: string) => void;
  mode: "single" | "multi";
  selectedIds?: Set<string>; // multi mode
  selectedId?: string | null; // single mode
  onToggleItem?: (id: string) => void; // multi mode
  onSelectItem?: (id: string) => void; // single mode
  search?: {
    term: string;
    onTermChange: (term: string) => void;
    results: RegionPickerItem[];
    onSelectResult: (item: RegionPickerItem) => void;
    placeholder?: string;
  };
}

// Rounded-rectangle, matching the app's standard Pill toggle (see Pill.tsx's own comment on
// why rounded-md, not rounded-full) rather than the older pill shape this used to duplicate.
function pillClass(selected: boolean): string {
  return `rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
    selected ? "border-accent bg-accent text-accent-fg" : "border-line bg-surface-muted text-muted hover:bg-surface-muted"
  }`;
}

export default function RegionPicker({
  groups,
  items,
  openGroupIds,
  onToggleGroup,
  mode,
  selectedIds,
  selectedId,
  onToggleItem,
  onSelectItem,
  search,
}: RegionPickerProps) {
  const isSelected = (id: string) => (mode === "multi" ? (selectedIds?.has(id) ?? false) : selectedId === id);
  const select = (id: string) => (mode === "multi" ? onToggleItem?.(id) : onSelectItem?.(id));

  return (
    <div className="space-y-4">
      {search && (
        <div className="relative">
          <SearchInput value={search.term} onChange={search.onTermChange} placeholder={search.placeholder ?? "Search…"} />
          {search.results.length > 0 && (
            <ul className="absolute z-10 mt-1 w-full rounded-md border border-line bg-surface shadow-md">
              {search.results.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => search.onSelectResult(r)}
                    className="block w-full px-3 py-2 text-left text-sm text-ink hover:bg-surface-muted"
                  >
                    {r.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {groups && (
        <div className="flex flex-wrap gap-2">
          {groups.map((group) => {
            if (group.items.length === 0) return null;
            const isOpen = openGroupIds?.has(group.id) ?? false;
            return (
              <button key={group.id} type="button" onClick={() => onToggleGroup?.(group.id)} className={pillClass(isOpen)}>
                {group.label}
              </button>
            );
          })}
        </div>
      )}

      {groups
        ? groups
            .filter((g) => openGroupIds?.has(g.id))
            .map((group) => (
              <div key={group.id} className="flex flex-wrap items-center gap-2">
                {groups.filter((g) => openGroupIds?.has(g.id)).length > 1 && (
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted">{group.label}</span>
                )}
                {[...group.items]
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((item) => (
                    <button key={item.id} type="button" onClick={() => select(item.id)} className={pillClass(isSelected(item.id))}>
                      {item.name}
                    </button>
                  ))}
              </div>
            ))
        : items && items.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {items.map((item) => (
                <button key={item.id} type="button" onClick={() => select(item.id)} className={pillClass(isSelected(item.id))}>
                  {item.name}
                </button>
              ))}
            </div>
          )}
    </div>
  );
}
