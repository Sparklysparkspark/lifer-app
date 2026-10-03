import type { TransitionStartFunction } from "react";
import Pill from "../../components/Pill";
import FilterPopover, { FilterFieldLabel } from "../../components/FilterPopover";
import Select from "../../components/Select";
import SearchInput from "../../components/SearchInput";
import { taxonFilterLabel } from "./taxonLabels";
import type { CollectionUrlState } from "./useCollectionUrlState";
import type { CollectionDisplayPrefs } from "./useCollectionDisplayPrefs";

function Checkbox({
  checked,
  onChange,
  label,
  title,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-center gap-1.5 text-xs ${disabled ? "text-muted" : "text-ink"}`} title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="accent-accent" />
      {label}
    </label>
  );
}

export default function CollectionToolbar({
  url,
  prefs,
  startTransition,
  availableTaxonFilters,
  namingStyles,
  availableYears,
  hasGhost,
  hasLost,
  shownCount,
  totalLoaded,
  seaZones,
  seaZonesRelevant,
  regionName,
  onToggleSeaZone,
  onSetAllSeaZones,
  onSetIncludeLand,
}: {
  url: CollectionUrlState;
  prefs: CollectionDisplayPrefs;
  startTransition: TransitionStartFunction;
  availableTaxonFilters: string[];
  namingStyles: string[];
  availableYears: number[];
  hasGhost: boolean;
  hasLost: boolean;
  shownCount: number | null;
  totalLoaded: number | null;
  seaZones: Array<{ id: string; name: string }>;
  seaZonesRelevant: boolean;
  regionName: string | undefined;
  onToggleSeaZone: (zoneId: string, checked: boolean) => void;
  onSetAllSeaZones: (checked: boolean) => void;
  onSetIncludeLand: (checked: boolean) => void;
}) {
  const { regionId, taxonFilters, seaZoneIds, updateParam } = url;
  // Only departures from the default count (collectedFirst is on by default).
  const activeFilterCount =
    (url.collectedFirst ? 0 : 1) +
    (url.seenFirst ? 1 : 0) +
    (url.targetFirst ? 1 : 0) +
    (url.stateFilter !== "all" ? 1 : 0) +
    (url.ghostOnly ? 1 : 0) +
    (url.lostOnly ? 1 : 0) +
    (url.likelyThisMonthOnly ? 1 : 0) +
    (url.yearFilter ? 1 : 0) +
    taxonFilters.size;

  return (
    // data-header-extension: TitleBarDragRegion treats this strip as the bottom of the header.
    <div data-header-extension="" className="relative flex flex-wrap items-center gap-3 border-b border-line bg-surface py-2 pl-6 pr-12 text-xs">
      <SearchInput value={url.search} onChange={url.setSearch} placeholder="Search this area…" className="w-48" aria-label="Search this area" />
      {/* Regrouping a large list is slow, so it runs in a transition that keeps the old grid up. */}
      <Select
        label="Group"
        value={url.groupBy}
        onChange={(e) => {
          const value = e.target.value === "none" ? null : e.target.value;
          startTransition(() => updateParam("group", value));
        }}
      >
        <option value="none">No grouping</option>
        <option value="broad">Broad group</option>
        <option value="group">Family group</option>
        <option value="tier">Rarity tier</option>
        {regionId && <option value="localTier">Rarity here</option>}
      </Select>
      <Select
        label="Sort"
        value={url.sortBy}
        onChange={(e) => {
          const value = e.target.value === "taxonomic" ? null : e.target.value;
          startTransition(() => updateParam("sort", value));
        }}
      >
        <option value="taxonomic">Taxonomic</option>
        <option value="name">Name</option>
        <option value="rarity">Rarity</option>
        {/* Local rarity and seasonality only come back on a region's checklist. */}
        {regionId && <option value="localRarity">Rarity here</option>}
        {regionId && <option value="seasonality">Most likely this month</option>}
      </Select>
      <label className="flex items-center gap-1.5 text-xs text-muted">
        Size
        <input
          type="range"
          min={120}
          max={320}
          step={10}
          value={prefs.cardMinWidth}
          onChange={(e) => prefs.setCardMinWidth(Number(e.target.value))}
          className="w-24 accent-ink"
          aria-label="Species card size"
        />
      </label>
      {/* The region's own counts never change with filters, so show what a filter took out. */}
      {totalLoaded != null && shownCount != null && shownCount !== totalLoaded && (
        <span className="text-xs text-muted">
          Showing {shownCount.toLocaleString()} of {totalLoaded.toLocaleString()}
        </span>
      )}
      <FilterPopover activeCount={activeFilterCount}>
        <div className="space-y-1">
          <FilterFieldLabel>Taxon</FilterFieldLabel>
          <div className="flex max-h-56 flex-wrap gap-1 overflow-y-auto">
            {availableTaxonFilters.map((t) => (
              <Pill
                key={t}
                size="sm"
                active={taxonFilters.has(t)}
                onClick={() => {
                  const next = new Set(taxonFilters);
                  if (next.has(t)) next.delete(t);
                  else next.add(t);
                  updateParam("taxon", next.size > 0 ? [...next].join(",") : null);
                }}
              >
                {taxonFilterLabel(t, namingStyles)}
              </Pill>
            ))}
          </div>
          {taxonFilters.size > 0 && (
            <button onClick={() => updateParam("taxon", null)} className="pt-1 text-[11px] text-muted hover:underline">
              Clear taxon filter
            </button>
          )}
        </div>
        <div className="space-y-1.5 border-t border-line pt-2">
          <Checkbox checked={url.collectedFirst} onChange={(c) => updateParam("collectedFirst", c ? null : "0")} label="Collected first" />
          <Checkbox checked={url.seenFirst} onChange={(c) => updateParam("seenFirst", c ? "1" : null)} label="Seen first" />
          <Checkbox checked={url.targetFirst} onChange={(c) => updateParam("targetFirst", c ? "1" : null)} label="Targets first" />
          <Checkbox checked={prefs.hideLabels} onChange={prefs.setHideLabels} label="Hide labels" />
          <Checkbox checked={prefs.hideNames} onChange={prefs.setHideNames} label="Hide names" />
          <Checkbox
            checked={prefs.hideScientificName || prefs.hideNames}
            disabled={prefs.hideNames}
            onChange={prefs.setHideScientificName}
            label="Hide scientific names"
          />
        </div>
        <div className="border-t border-line pt-2">
          <FilterFieldLabel>Show</FilterFieldLabel>
          <Select value={url.stateFilter} onChange={(e) => updateParam("show", e.target.value === "all" ? null : e.target.value)} className="w-full">
            <option value="all">All</option>
            <option value="collected">Collected</option>
            <option value="seen">Seen only</option>
            <option value="target">Targets</option>
            <option value="unseen">Not yet collected</option>
          </Select>
        </div>
        {(regionId || availableYears.length > 0) && (
          <div className="space-y-1.5 border-t border-line pt-2">
            {regionId && (
              <Checkbox
                checked={url.likelyThisMonthOnly}
                onChange={(c) => updateParam("likelyThisMonth", c ? "1" : null)}
                label="Likely this month"
                title="Ranks this region's own seasonal frequency data for the current month"
              />
            )}
            {availableYears.length > 0 && (
              <div className="space-y-1">
                <FilterFieldLabel>Found in year</FilterFieldLabel>
                <Select value={url.yearFilter} onChange={(e) => updateParam("year", e.target.value || null)} className="w-full">
                  <option value="">Any year</option>
                  {availableYears.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </div>
        )}
        {/* Only offered once the list actually has a Ghost or Lost species. */}
        {(hasGhost || hasLost) && (
          <div className="space-y-1.5 border-t border-line pt-2">
            {hasGhost && (
              <Checkbox
                checked={url.ghostOnly}
                onChange={(c) => updateParam("ghostOnly", c ? "1" : null)}
                label="Ghost only"
                title="Rarely documented anywhere, but still out there to find"
              />
            )}
            {hasLost && (
              <Checkbox
                checked={url.lostOnly}
                onChange={(c) => updateParam("lostOnly", c ? "1" : null)}
                label="Lost only"
                title="Not recorded anywhere in over 25 years"
              />
            )}
          </div>
        )}
      </FilterPopover>
      {seaZonesRelevant && seaZones.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-muted">
          <span>Include nearby water:</span>
          {seaZones.length > 1 && (
            <label className="flex items-center gap-1 font-medium text-ink">
              <input type="checkbox" checked={seaZoneIds.length === seaZones.length} onChange={(e) => onSetAllSeaZones(e.target.checked)} />
              Select all
            </label>
          )}
          {seaZones.map((z) => (
            <label key={z.id} className="flex items-center gap-1">
              <input type="checkbox" checked={seaZoneIds.includes(z.id)} onChange={(e) => onToggleSeaZone(z.id, e.target.checked)} />
              {z.name}
            </label>
          ))}
          {/* With a zone checked, lets it show only that zone's fish instead of adding to the land list. */}
          {seaZoneIds.length > 0 && (
            <label className="flex items-center gap-1 border-l border-line pl-2">
              <input type="checkbox" checked={url.includeLand} onChange={(e) => onSetIncludeLand(e.target.checked)} />
              Include {regionName ?? "region"}'s own species
            </label>
          )}
        </div>
      )}
    </div>
  );
}
