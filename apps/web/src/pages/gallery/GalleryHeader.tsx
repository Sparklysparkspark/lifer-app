import { ALL_TAXON_CLASSES, taxonDisplayLabel } from "@lifer/shared";
import SearchInput from "../../components/SearchInput";
import InlineSpinner from "../../components/InlineSpinner";
import Pill from "../../components/Pill";
import Select from "../../components/Select";
import RegionBrowser from "../../components/RegionBrowser";
import FilterPopover, { FilterGroupLabel, FilterFieldLabel } from "../../components/FilterPopover";
import SelectModeToggle from "../../components/SelectModeToggle";
import {
  DateRangeField,
  FilterCheckbox,
  MediaFilterField,
  PhotoSortSelect,
  RawFilterField,
  ThumbSizeSlider,
} from "../../components/PhotoGridControls";
import { UNCATEGORIZED_REGION_ID, toggleInSet } from "./galleryHelpers";
import type { GalleryFacets } from "./useGalleryFacets";
import type { GalleryFilters } from "./useGalleryFilters";
import type { GalleryDisplayPrefs } from "./useGalleryDisplayPrefs";

// The Gallery header's controls: search, sort, the Filters panel (filters and display options),
// thumbnail size and select mode.
export function GalleryToolbar({
  filters,
  facets,
  display,
  tagOptions,
  searching,
  hasPhotos,
  selectMode,
  onEnterSelectMode,
  onExitSelectMode,
}: {
  filters: GalleryFilters;
  facets: GalleryFacets;
  display: GalleryDisplayPrefs;
  tagOptions: string[];
  searching: boolean;
  hasPhotos: boolean;
  selectMode: boolean;
  onEnterSelectMode: () => void;
  onExitSelectMode: () => void;
}) {
  const { query } = filters;
  const { selectedTaxa, dateFrom, dateTo, regionId } = query;
  const taxonPill = (tc: string) => (
    <Pill
      key={tc}
      size="sm"
      active={selectedTaxa.has(tc)}
      onClick={() => filters.setSelectedTaxa((prev) => toggleInSet(prev, tc))}
    >
      {taxonDisplayLabel(tc, facets.namingStyles)}
    </Pill>
  );

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
      <SearchInput
        value={filters.searchInput}
        onChange={filters.setSearchInput}
        placeholder="Search your photos… (e.g. “owl flying”, “ducks in Canada 2024”)"
        className="w-full sm:w-96"
        aria-label="Search your photos by what's in them"
      />
      {searching && <InlineSpinner size="sm" label="Searching…" />}

      <PhotoSortSelect
        value={query.sortBy}
        onChange={filters.setSortBy}
        disabled={!!query.searchQuery}
        title={query.searchQuery ? "Search results are already ranked by relevance" : undefined}
      />

      <FilterPopover activeCount={filters.activeFilterCount}>
        <div className="space-y-2.5">
          <FilterGroupLabel>Filter</FilterGroupLabel>
          <div className="flex flex-wrap items-center gap-3">
            <FilterCheckbox checked={query.onlyTopRated} onChange={filters.setOnlyTopRated}>
              Top rated
            </FilterCheckbox>
            <FilterCheckbox checked={query.onlyFeatured} onChange={filters.setOnlyFeatured}>
              Featured
            </FilterCheckbox>
            {/* Photos a culling app rejected, imported hidden (docs: Culling with other apps). */}
            {(facets.hiddenCount > 0 || query.onlyHidden) && (
              <FilterCheckbox checked={query.onlyHidden} onChange={filters.setOnlyHidden}>
                Hidden
              </FilterCheckbox>
            )}
          </div>

          {facets.hasVideoInLibrary && <MediaFilterField value={query.mediaFilter} onChange={filters.setMediaFilter} />}

          <RawFilterField value={query.rawFilter} onChange={filters.setRawFilter} />

          <DateRangeField
            dateFrom={dateFrom}
            dateTo={dateTo}
            onDateFromChange={filters.setDateFrom}
            onDateToChange={filters.setDateTo}
            open={filters.dateRangeOpen}
            onOpen={() => filters.setDateRangeOpen(true)}
            onClear={() => {
              filters.setDateFrom("");
              filters.setDateTo("");
              filters.setDateRangeOpen(false);
            }}
          />

          <div>
            <FilterFieldLabel>Region</FilterFieldLabel>
            <label className="mb-1.5 flex items-center gap-1.5 text-xs text-ink">
              <input
                type="checkbox"
                checked={regionId === UNCATEGORIZED_REGION_ID}
                onChange={(e) => filters.setRegionId(e.target.checked ? UNCATEGORIZED_REGION_ID : null)}
                className="accent-ink"
              />
              No region set yet
            </label>
            {regionId !== UNCATEGORIZED_REGION_ID && (
              <RegionBrowser
                regionId={regionId}
                onChange={filters.setRegionId}
                allowAnyRegion
                restrictToIds={facets.regionsWithPhotos}
              />
            )}
          </div>

          {tagOptions.length > 0 && (
            <div>
              <FilterFieldLabel>Tag</FilterFieldLabel>
              <Select aria-label="Tag" value={query.tag ?? ""} onChange={(e) => filters.setTag(e.target.value || null)}>
                <option value="">Any tag</option>
                {tagOptions.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </div>
          )}

          <div>
            <FilterFieldLabel>Taxon</FilterFieldLabel>
            <div className="flex max-h-32 flex-wrap gap-1 overflow-y-auto">
              {ALL_TAXON_CLASSES.filter((tc) => !facets.availableTaxa || facets.availableTaxa.has(tc)).map(taxonPill)}
              {facets.otherTaxaClasses.map(taxonPill)}
            </div>
            {selectedTaxa.size > 0 && (
              <button
                type="button"
                onClick={() => filters.setSelectedTaxa(new Set())}
                className="mt-1 text-[11px] text-muted hover:underline"
              >
                Clear taxon filter
              </button>
            )}
          </div>
        </div>

        <div className="space-y-1.5 border-t border-line pt-2.5">
          <FilterGroupLabel>Display</FilterGroupLabel>
          <FilterCheckbox checked={display.showLabels} onChange={display.setShowLabels}>
            Labels
          </FilterCheckbox>
          <FilterCheckbox checked={display.showCameraInfo} onChange={display.setShowCameraInfo}>
            Camera info
          </FilterCheckbox>
          <FilterCheckbox checked={display.showRatings} onChange={display.setShowRatings}>
            Ratings
          </FilterCheckbox>
          <FilterCheckbox checked={display.groupByRegion} onChange={display.setGroupByRegion}>
            Group by region
          </FilterCheckbox>
        </div>
      </FilterPopover>

      <ThumbSizeSlider value={display.thumbSizePx} onChange={display.updateThumbSize} />
      {hasPhotos && <SelectModeToggle active={selectMode} onEnter={onEnterSelectMode} onExit={onExitSelectMode} />}
    </div>
  );
}

// Under the heading: the photo count, and the trip/album scope chips from the search palette.
export function GallerySummary({
  countText,
  filters,
}: {
  countText: string | null;
  filters: Pick<GalleryFilters, "scopeTrip" | "scopeAlbum" | "clearScope">;
}) {
  const { scopeTrip, scopeAlbum } = filters;
  return (
    <>
      {countText !== null && <p className="text-xs text-muted">{countText}</p>}
      {(scopeTrip || scopeAlbum) && (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {scopeTrip && (
            <ScopeChip label={`In trip ${scopeTrip.name ?? ""}`.trim()} onRemove={() => filters.clearScope("trip")} />
          )}
          {scopeAlbum && (
            <ScopeChip
              label={`In album ${scopeAlbum.name ?? ""}`.trim()}
              onRemove={() => filters.clearScope("album")}
            />
          )}
        </div>
      )}
    </>
  );
}

// A removable "In trip X" / "In album X" filter, from the palette's search-within hand-off.
function ScopeChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-muted px-2 py-0.5 text-xs text-ink">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter: ${label}`}
        className="text-sm leading-none text-muted hover:text-ink"
      >
        ×
      </button>
    </span>
  );
}
