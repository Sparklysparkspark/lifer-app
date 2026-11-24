import { useTranslation } from "react-i18next";
import SearchInput from "../../components/SearchInput";
import InlineSpinner from "../../components/InlineSpinner";
import SelectModeToggle from "../../components/SelectModeToggle";
import Button from "../../components/Button";
import Menu, { MenuItem, MenuLink, MenuPanel } from "../../components/Menu";
import SimilarGroupActions from "./SimilarGroupActions";
import { useDropdownMenu } from "../../hooks/useDropdownMenu";
import { useVersionCounts } from "../../lib/photoVersions";
import { PhotoViewMenu, type PhotoLayout } from "../../components/PhotoGridControls";
import PhotoFiltersMenu, { ScopeChip } from "../../components/PhotoFiltersMenu";
import { GRID_PHOTO_FILTER_SECTIONS, PHOTO_SORTS } from "../../lib/photoGridSections";
import { searchPartLabel, soleRegionId, type GalleryGroupBy, type SearchPart } from "./galleryHelpers";
import type { GalleryFacets } from "./useGalleryFacets";
import type { GalleryFilters } from "./useGalleryFilters";
import type { GalleryDisplayPrefs } from "./useGalleryDisplayPrefs";

// The Gallery header's controls: search, the View menu (grouping, sort, size, captions), the
// Filters menu, the More menu's tools and select mode. A similar group stands alone, so it has no
// search or filters.
export function GalleryToolbar({
  filters,
  facets,
  display,
  groupBy,
  tagOptions,
  searching,
  hasPhotos,
  selectMode,
  onEnterSelectMode,
  onExitSelectMode,
  onSaveSmartAlbum,
  onPinFilters,
  layout = "grid",
  onLayoutChange,
}: {
  filters: GalleryFilters;
  facets: GalleryFacets;
  display: GalleryDisplayPrefs;
  /** display.groupBy as shown: "Rarity here" only with a region filter. */
  groupBy: GalleryGroupBy;
  tagOptions: string[];
  searching: boolean;
  hasPhotos: boolean;
  selectMode: boolean;
  onEnterSelectMode: () => void;
  onExitSelectMode: () => void;
  /** Saves the current search and filters as a smart album. */
  onSaveSmartAlbum?: () => void;
  /** Pins the current filters as a one-click chip. */
  onPinFilters?: () => void;
  /** The grid, or the map of where the photos were taken. */
  layout?: PhotoLayout;
  onLayoutChange?: (layout: PhotoLayout) => void;
}) {
  const { t } = useTranslation();
  const { query } = filters;
  const more = useDropdownMenu<true>();
  const similar = !!query.similarTo;
  const regionFilterActive = !!soleRegionId(query.regionIds);
  // Saving needs something to save: a search or a filter off its default.
  const canSaveSmartAlbum =
    filters.activeFilterCount > 0 || !!query.searchQuery || query.shotActions.size > 0 || query.shotFramings.size > 0;

  // Nothing to view, filter or act on until photos are imported.
  const libraryEmpty = facets.libraryEmpty && !query.searchQuery;
  // Offered once any photo has versions; a search lists photos only.
  const hasVersions = useVersionCounts().size > 0 || display.allVersions;
  const versionsSection = hasVersions && !query.searchQuery && !query.onlyHidden ? (["versions"] as const) : [];
  // Every version as its own card lists photos apart, which bursts would fold back together.
  const burstsSection = display.allVersions && versionsSection.length ? [] : (["bursts"] as const);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-footnote">
      {!similar && (
        <SearchInput
          value={filters.searchInput}
          onChange={filters.setSearchInput}
          placeholder={t("gallery.toolbar.searchPlaceholder")}
          className="w-full sm:w-96"
          aria-label={t("gallery.toolbar.searchLabel")}
        />
      )}
      {searching && <InlineSpinner size="sm" label={t("gallery.toolbar.searching")} />}

      {/* How the photos are laid out, apart from which are shown (Filters), as in the Collection. */}
      {!libraryEmpty && (
        <PhotoViewMenu
          // On the map, only the choice to go back to the grid applies.
          sections={
            !onLayoutChange || similar
              ? ["group", "sort", "size", "captions"]
              : layout === "map"
                ? ["layout"]
                : ["layout", "group", "sort", "size", "captions", ...versionsSection, ...burstsSection]
          }
          layout={onLayoutChange && { value: layout, onChange: onLayoutChange }}
          activeCount={
            (groupBy !== "none" ? 1 : 0) +
            (query.sortBy !== "newest" ? 1 : 0) +
            (versionsSection.length && display.allVersions ? 1 : 0) +
            (burstsSection.length && display.groupBursts ? 1 : 0)
          }
          group={{
            value: groupBy,
            options: [
              "none",
              "region",
              "broad",
              "group",
              "tier",
              ...(regionFilterActive ? (["localTier"] as const) : []),
            ],
            onChange: display.setGroupBy,
          }}
          // A search is ranked by relevance, so it has no sort.
          sort={{
            value: query.sortBy,
            options: PHOTO_SORTS,
            onChange: filters.setSortBy,
            disabled: !!query.searchQuery,
            title: query.searchQuery ? t("gallery.toolbar.sortDisabled") : undefined,
          }}
          size={{ value: display.thumbSizePx, onChange: display.updateThumbSize }}
          captions={display}
          allVersions={{ checked: display.allVersions, onChange: display.setAllVersions }}
          groupBursts={{ checked: display.groupBursts, onChange: display.setGroupBursts }}
        />
      )}
      {!similar && !libraryEmpty && (
        <PhotoFiltersMenu
          filters={filters}
          facets={facets}
          tagOptions={tagOptions}
          sections={GRID_PHOTO_FILTER_SECTIONS}
        />
      )}
      {!similar && !libraryEmpty && filters.activeFilterCount > 0 && (
        <Button variant="secondary" size="sm" onClick={filters.clearFilters}>
          {t("gallery.toolbar.clearAll")}
        </Button>
      )}

      {hasPhotos && <SelectModeToggle active={selectMode} onEnter={onEnterSelectMode} onExit={onExitSelectMode} />}

      {!libraryEmpty && !similar && (
        <Menu
          trigger="toolbar"
          open={more.openKey === true}
          onToggle={() => more.setOpenKey(more.openKey ? null : true)}
          menuRef={more.ref}
          className="relative"
        >
          <MenuPanel className="min-w-44 whitespace-nowrap">
            <MenuLink to="/gallery/similar">{t("gallery.toolbar.findSimilar")}</MenuLink>
            {onSaveSmartAlbum && canSaveSmartAlbum && (
              <MenuItem onSelect={onSaveSmartAlbum}>{t("albums.smart.saveFromGallery")}</MenuItem>
            )}
            {onPinFilters && canSaveSmartAlbum && (
              <MenuItem onSelect={onPinFilters}>{t("gallery.pins.pinThese")}</MenuItem>
            )}
          </MenuPanel>
        </Menu>
      )}
    </div>
  );
}

// Under the heading: the photo count and the trip/album scope chips from the search palette.
// Stats' filters show in the Filters panel instead.
export function GallerySummary({
  countText,
  filters,
  similarAlone = false,
  searchParts = [],
  onRemoveSearchPart,
}: {
  countText: string | null;
  /** A long search's parts, shown as tokens from two parts up. */
  searchParts?: SearchPart[];
  onRemoveSearchPart?: (part: SearchPart) => void;
  filters: Pick<GalleryFilters, "scopeTrip" | "scopeAlbum" | "clearScope"> &
    Partial<Pick<GalleryFilters, "query" | "setBbox">>;
  /** A similar group with only the photo itself in it. */
  similarAlone?: boolean;
}) {
  const { t } = useTranslation();
  const { scopeTrip, scopeAlbum } = filters;
  const bbox = filters.query?.bbox;
  const similarTo = filters.query?.similarTo;
  return (
    <>
      {countText !== null && <p className="text-footnote text-muted">{countText}</p>}
      {searchParts.length >= 2 && onRemoveSearchPart && (
        <div className="mt-1 flex flex-wrap gap-1.5" role="group" aria-label={t("gallery.searchPart.parts")}>
          {searchParts.map((part, i) => (
            <ScopeChip
              key={`${i}:${part.text}`}
              label={searchPartLabel(part)}
              onRemove={() => onRemoveSearchPart(part)}
            />
          ))}
        </div>
      )}
      {similarTo && similarAlone && <p className="text-footnote text-muted">{t("gallery.similarNone")}</p>}
      {similarTo && <SimilarGroupActions captureId={similarTo} alone={similarAlone} />}
      {(scopeTrip || scopeAlbum || bbox || similarTo) && (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {similarTo && <ScopeChip label={t("gallery.scope.similar")} onRemove={() => filters.clearScope("similar")} />}
          {scopeTrip && (
            <ScopeChip
              label={t("gallery.scope.trip", { name: scopeTrip.name ?? "" }).trim()}
              onRemove={() => filters.clearScope("trip")}
            />
          )}
          {scopeAlbum && (
            <ScopeChip
              label={t("gallery.scope.album", { name: scopeAlbum.name ?? "" }).trim()}
              onRemove={() => filters.clearScope("album")}
            />
          )}
          {bbox && filters.setBbox && (
            <ScopeChip label={t("gallery.scope.mapArea")} onRemove={() => filters.setBbox!(null)} />
          )}
        </div>
      )}
    </>
  );
}
