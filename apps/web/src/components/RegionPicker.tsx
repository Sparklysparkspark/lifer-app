import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import SearchInput from "./SearchInput";
import Pill from "./Pill";

// Presentational region pills, optionally grouped under expandable headers, with an optional
// jump-to search. Callers own the data and what selecting means (multi-toggle or navigate).
export interface RegionPickerItem {
  id: string;
  name: string;
  /** Search results only: a heading shown before the first result of each group. */
  group?: string;
}

export interface RegionPickerGroup {
  id: string;
  label: string;
  items: RegionPickerItem[];
}

interface RegionPickerProps {
  // Either `groups` (expandable headers, e.g. continents) or a flat `items` list, not both.
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
    /** Under the results (a note, a credit); shown even when there are none. */
    footer?: ReactNode;
  };
}

// Same shape as Pill.

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
  const { t } = useTranslation();
  const isSelected = (id: string) => (mode === "multi" ? (selectedIds?.has(id) ?? false) : selectedId === id);
  const select = (id: string) => (mode === "multi" ? onToggleItem?.(id) : onSelectItem?.(id));

  return (
    <div className="space-y-4">
      {search && (
        <div className="relative">
          <SearchInput
            value={search.term}
            onChange={search.onTermChange}
            placeholder={search.placeholder ?? t("ui.searchPlaceholder")}
          />
          {(search.results.length > 0 || search.footer) && (
            <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-panel border border-line bg-surface shadow-md">
              {search.results.map((r, i) => (
                <li key={r.id}>
                  {r.group && r.group !== search.results[i - 1]?.group && (
                    <p className="border-t border-line px-3 pb-1 pt-2 text-footnote font-semibold text-muted first:border-t-0">
                      {r.group}
                    </p>
                  )}
                  {/* raw-control: a row of the search results. */}
                  <button
                    type="button"
                    onClick={() => search.onSelectResult(r)}
                    className="block w-full px-3 py-2 text-left text-callout text-ink hover:bg-surface-muted focus-visible:outline-offset-[-2px]"
                  >
                    {r.name}
                  </button>
                </li>
              ))}
              {search.footer && <li className="px-3 py-2 text-footnote text-muted">{search.footer}</li>}
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
              <Pill key={group.id} size="sm" active={isOpen} onClick={() => onToggleGroup?.(group.id)}>
                {group.label}
              </Pill>
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
                  <span className="text-footnote font-semibold uppercase tracking-wide text-muted">{group.label}</span>
                )}
                {[...group.items]
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((item) => (
                    <Pill
                      key={item.id}
                      size="sm"

                      active={isSelected(item.id)}
                      onClick={() => select(item.id)}
                    >
                      {item.name}
                    </Pill>
                  ))}
              </div>
            ))
        : items &&
          items.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {items.map((item) => (
                <Pill
                  key={item.id}
                  size="sm"

                  active={isSelected(item.id)}
                  onClick={() => select(item.id)}
                >
                  {item.name}
                </Pill>
              ))}
            </div>
          )}
    </div>
  );
}
