import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import RawUpload from "../components/RawUpload";
import PhotoImportRows from "../components/PhotoImportRows";
import { LoadingScreen } from "../components/LoadingScreen";
import PageHeader from "../components/PageHeader";
import { useSettings } from "../hooks/useSettings";
import GroupedSpeciesGrid from "../components/GroupedSpeciesGrid";
import SearchInput from "../components/SearchInput";
import Lightbox, { type LightboxSlide } from "../components/Lightbox";
import EmptyState from "../components/EmptyState";
import CardCropEditor from "../components/CardCropEditor";
import { ALL_TAXON_CLASSES, NAME_MAX_LENGTH } from "@lifer/shared";
import EditableTextField from "../components/EditableTextField";
import { FolderBrowser } from "../components/FolderPicker";
import { usePhotoGridSize } from "../hooks/usePhotoGridSize";
import { usePhotoCaptionPrefs } from "../hooks/usePhotoCaptionPrefs";
import { useConfirm } from "../hooks/useConfirm";
import Menu, { MenuItem, MenuPanel, MenuSeparator } from "../components/Menu";
import Checkbox from "../components/Checkbox";
import Panel from "../components/Panel";
import { usePersistedState } from "../hooks/usePersistedState";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import { useSelectMode } from "../hooks/useSelectMode";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { PhotoViewMenu } from "../components/PhotoGridControls";
import PhotoFiltersMenu from "../components/PhotoFiltersMenu";
import { GRID_PHOTO_FILTER_SECTIONS, PHOTO_SORTS } from "../lib/photoGridSections";
import SelectModeToggle from "../components/SelectModeToggle";
import Button from "../components/Button";
import ConfirmDialog from "../components/ConfirmDialog";
import Modal from "../components/Modal";
import { formatDate } from "../lib/format";
import { DEFAULT_RAW_FILES } from "../lib/photoListFilters";
import { useSpeciesName } from "../lib/speciesName";
import { useScrollMemory } from "../hooks/useScrollMemory";
import { useSearchParamsKeepingState, useUrlParam } from "../hooks/useSearchParamsKeepingState";
import { useGalleryFilters } from "./gallery/useGalleryFilters";
import { useGalleryFacets } from "./gallery/useGalleryFacets";
import { useScopedFilterIds } from "./gallery/useScopedFilterIds";
import { useApiResource } from "../lib/resource";
import { useTripData } from "./trip/useTripData";
import { useTripScanImport } from "./trip/useTripScanImport";
import { useTripEdits } from "./trip/useTripEdits";
import {
  groupTripPhotos,
  tripTaxonFilters,
  visibleTripPhotos,
  TRIP_PHOTO_GROUPS,
  type TripPhotoGroupBy,
} from "./trip/tripFilters";
import CollectionToolbar from "./collection/CollectionToolbar";
import { useCollectionUrlState } from "./collection/useCollectionUrlState";
import { useCollectionDisplayPrefs } from "./collection/useCollectionDisplayPrefs";
import { filterCollectionItems, searchHaystack, searchRanks } from "./collection/filterItems";
import TripHeaderDetails from "./trip/TripHeaderDetails";
import TripJobStatus from "./trip/TripJobStatus";
import TripScanReview from "./trip/TripScanReview";
import TripPhotoGrid from "./trip/TripPhotoGrid";
import TripDatesBar from "./trip/TripDatesBar";
import Tip from "../components/Tip";
import TripSuggestions from "./trip/TripSuggestions";
import TripChecklists from "./trip/TripChecklists";
import TripFilesDialog, { type TripFilesMode } from "./trip/TripFilesDialog";
import { TRIP_FILES_MOVED } from "../components/TripFileMoveTray";
import { MOVED_PHOTOS_CHANGED, MOVED_PHOTOS_LOOK_STARTED } from "../hooks/useMovedPhotos";
import { api, apiPath } from "../api/client";
import { useToast } from "../hooks/useToast";
import { errorMessage } from "../lib/errorMessage";
import { ignore } from "../lib/ignore";
import type { TripPhoto } from "./trip/types";

const tripPhotoId = (p: TripPhoto) => p.captureId;

// The trip's own saved browsing presets, apart from the Gallery's.
const TRIP_PRESET_KEYS = {
  rawFiles: "tripRawFiles",
  editedRaw: "tripEditedRaw",
  media: "tripMediaFilter",
  sort: "tripSortBy",
};
// Trip photos don't say which are videos, so the trip has no media filter; it picks its own species.
const TRIP_FILTER_SECTIONS = [...GRID_PHOTO_FILTER_SECTIONS.filter((s) => s !== "media"), "species" as const];
// The Photos view's species picker, in the URL.
const SPECIES_PARAM = "species";
const ALSO_CLEAR = [SPECIES_PARAM];

const EMPTY_TRIP_ICON = (
  <svg
    viewBox="0 0 24 24"
    className="h-6 w-6 text-muted"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 15.5V5.5A2 2 0 0 1 5 3.5h10" />
    <rect x="6" y="6" width="14" height="14" rx="2" />
  </svg>
);

// Species once the trip has photos, with a photo grid toggle. The species-assignment review opens
// once a scan of the folder finds something new; a newly created trip scans on first open.
export default function TripDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const speciesName = useSpeciesName();
  // Set by "Start a trip": the folder is new and empty, so offer uploads instead of a scan.
  const [searchParams, setSearchParams] = useSearchParamsKeepingState();
  const buildMode = searchParams.get("mode") === "build";
  // View, search and the species view's filters live in the URL so returning from a species
  // opened here lands on the same list. The species view is the Collection's, toolbar and all.
  const [viewParam, setViewParam] = useUrlParam("view");
  const url = useCollectionUrlState();
  const { search, setSearch } = url;
  const prefs = useCollectionDisplayPrefs();
  const [gridWidth, setGridWidth] = useState<number | null>(null);
  const [isGroupingPending, startGroupingTransition] = useTransition();
  const [thumbSizePx, updateThumbSize] = usePhotoGridSize();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const captions = usePhotoCaptionPrefs();
  const { settings } = useSettings();
  const suggestEnabled = settings?.speciesSuggestEnabled ?? false;
  const namingStyles = useMemo(() => settings?.speciesNamingStyles ?? [], [settings?.speciesNamingStyles]);
  // ?taxon= is the species view's Animals choice (several, comma separated), not the photo filter's.
  const photoFilterParams = useMemo(() => {
    const params = new URLSearchParams(searchParams);
    params.delete("taxon");
    return params;
  }, [searchParams]);
  // The Gallery's filters. Trip photos all load at once, so sorting and most filters run here; the
  // rest ask the Gallery's own query for the matching photos. The search box is the trip's own.
  const filters = useGalleryFilters(photoFilterParams, setSearchParams, undefined, {
    keys: TRIP_PRESET_KEYS,
    search: false,
    alsoClear: ALSO_CLEAR,
  });
  const [speciesParam, setSpeciesParam] = useUrlParam(SPECIES_PARAM);
  const pickedSpecies = useMemo(() => new Set(speciesParam.split(",").filter(Boolean)), [speciesParam]);
  const [savedPhotoGroupBy, setPhotoGroupBy] = usePersistedState<TripPhotoGroupBy>("tripPhotoGroupBy", "none");
  const photoGroupBy = TRIP_PHOTO_GROUPS.includes(savedPhotoGroupBy) ? savedPhotoGroupBy : "none";
  const { query } = filters;
  const { sortBy, rawFiles, editedRaw, ratingMin, ratingMax, unrated, missingDate, dateFrom, dateTo } = query;
  const facets = useGalleryFacets();
  const tagOptions = useApiResource<{ tags: string[] }>("/captures/tags").data?.tags ?? [];
  const serverMatches = useScopedFilterIds(id ? { tripId: id } : null, { ...query, mediaFilter: "both" });
  const batchDeleteRef = useRef<HTMLButtonElement>(null);
  const menu = useDropdownMenu<string>();
  const moreMenu = useDropdownMenu();
  const confirm = useConfirm();
  const { trip, summary, photos, speciesItems, loadError, load } = useTripData(id);
  const jobs = useTripScanImport({ id, load, suggestEnabled });
  const toast = useToast();
  const [filesDialog, setFilesDialog] = useState<TripFilesMode | null>(null);
  // Opening a trip quietly looks for its photos if any have gone missing (the server checks).
  useEffect(() => {
    if (id) api.post("/moved-photos/look", { tripId: id }).catch(ignore("Couldn't look for moved photos"));
  }, [id]);
  async function lookForMoved() {
    try {
      await api.post("/moved-photos/look", { tripId: id, manual: true });
      window.dispatchEvent(new Event(MOVED_PHOTOS_LOOK_STARTED));
    } catch (err) {
      toast.error(errorMessage(err, t("movedPhotos.failed")));
    }
  }
  // Relinked or undone photos and trip folders (MovedPhotosTray): reload the trip.
  useEffect(() => {
    const reload = () => void load();
    window.addEventListener(MOVED_PHOTOS_CHANGED, reload);
    return () => window.removeEventListener(MOVED_PHOTOS_CHANGED, reload);
  }, [load]);
  // A move of this trip's files ended (TripFileMoveTray): its folder and paths changed.
  useEffect(() => {
    const reload = (e: Event) => {
      if ((e as CustomEvent<string>).detail === id) void load();
    };
    window.addEventListener(TRIP_FILES_MOVED, reload);
    return () => window.removeEventListener(TRIP_FILES_MOVED, reload);
  }, [id, load]);
  // Takes the selected photos out of the trip; their files move out of its folder.
  async function removeSelected() {
    if (!id) return;
    try {
      await api.post(apiPath("/trips/{id}/captures/remove", { id }), { captureIds: [...edits.selectedCaptureIds] });
      edits.exitSelectMode();
      void load();
    } catch (err) {
      toast.error(errorMessage(err, t("trips.detail.removeFailed")));
    }
  }
  useScrollMemory(!!trip && !!photos);
  const view: "gallery" | "species" =
    viewParam === "gallery" || viewParam === "species" ? viewParam : photos?.length ? "species" : "gallery";
  const setView = (next: "gallery" | "species") => setViewParam(next);
  // Each view has its own toolbar, so the page holds the View menu open across a switch.
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const show = { value: view, onChange: setView, menuOpen: viewMenuOpen, onMenuOpenChange: setViewMenuOpen };

  // Set by "Add trip from folder": the first scan starts by itself, once.
  const location = useLocation();
  const navigate = useNavigate();
  async function deleteTrip() {
    if (!id) return;
    const ok = await confirm({
      title: t("trips.delete.title"),
      message: t("trips.delete.body"),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(apiPath("/trips/{id}", { id }));
      toast.success(t("trips.delete.done"));
      navigate("/albums?view=trips", { replace: true });
    } catch (err) {
      toast.error(errorMessage(err, t("trips.delete.failed")));
    }
  }
  const scanOnOpen = (location.state as { scan?: boolean } | null)?.scan === true;
  const scanStartedRef = useRef(false);
  const { startScan: startTripScan } = jobs;
  useEffect(() => {
    if (!scanOnOpen || scanStartedRef.current) return;
    scanStartedRef.current = true;
    // Clears the flag so Back or a reload doesn't scan again.
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
    void startTripScan();
  }, [scanOnOpen, location.pathname, location.search, navigate, startTripScan]);

  const sortedPhotos = useMemo(
    () =>
      visibleTripPhotos(
        (photos ?? []).filter((p) => !serverMatches || serverMatches.has(p.captureId)),
        search,
        { rawFiles, editedRaw, ratingMin, ratingMax, unrated, missingDate, dateFrom, dateTo },
        sortBy,
        pickedSpecies,
      ),
    [
      pickedSpecies,
      photos,
      serverMatches,
      search,
      sortBy,
      rawFiles,
      editedRaw,
      ratingMin,
      ratingMax,
      unrated,
      missingDate,
      dateFrom,
      dateTo,
    ],
  );
  const { photos: visiblePhotos, groups: photoGroups } = useMemo(
    () => groupTripPhotos(sortedPhotos, photoGroupBy, speciesName, namingStyles),
    [sortedPhotos, photoGroupBy, speciesName, namingStyles],
  );
  // The species picker's choices: every species in the trip, with its photo count.
  const speciesChoices = useMemo(() => {
    const byId = new Map<string, { id: string; label: string; count: number }>();
    for (const p of photos ?? []) {
      const choice = byId.get(p.speciesId);
      if (choice) choice.count++;
      else byId.set(p.speciesId, { id: p.speciesId, label: speciesName(p), count: 1 });
    }
    return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [photos, speciesName]);
  const haystacks = useMemo(
    () => new Map((speciesItems ?? []).map((i) => [i.speciesId, searchHaystack(i)])),
    [speciesItems],
  );
  const { itemFilters, taxonFilters } = url;
  const visibleSpecies = useMemo(
    () => filterCollectionItems(speciesItems ?? [], { ...itemFilters, taxa: taxonFilters }, haystacks),
    [speciesItems, itemFilters, taxonFilters, haystacks],
  );
  const speciesRanks = useMemo(
    () => searchRanks(visibleSpecies, itemFilters.search, haystacks),
    [visibleSpecies, itemFilters.search, haystacks],
  );
  const taxonChoices = useMemo(() => tripTaxonFilters(speciesItems ?? []), [speciesItems]);
  // The photo filters' Animals offer only the groups this trip has. Hidden photos never show in a
  // trip, so neither does their filter.
  const photoFacets = useMemo(() => {
    const taxa = new Set(taxonChoices);
    return {
      ...facets,
      hiddenCount: 0,
      availableTaxa: taxa,
      otherTaxaClasses: taxonChoices.filter((tc) => !(ALL_TAXON_CLASSES as string[]).includes(tc)),
    };
  }, [facets, taxonChoices]);
  // A card's own changes (target, seen, archive) show at once.
  const reloadSpecies = useCallback(() => void load(), [load]);
  // Indices are positions in the grid, so Shift ranges and drag select follow what's shown.
  const select = useSelectMode(visiblePhotos, tripPhotoId);
  const edits = useTripEdits({ id, load, photos, select, closeMenu: () => menu.setOpenKey(null) });
  // As in the Gallery; off while the lightbox owns the keyboard.
  useKeyboardShortcuts(
    {
      close: () => {
        if (select.selectMode) select.exit();
      },
      selectAll: (e) => {
        if (view !== "gallery" || visiblePhotos.length === 0) return;
        e.preventDefault();
        select.setSelectMode(true);
        select.setSelectedIds(new Set(visiblePhotos.map(tripPhotoId)));
      },
      trash: () => {
        if (select.selectMode && select.selectedIds.size > 0) edits.setConfirmingBatchDelete(true);
      },
    },
    { enabled: lightboxIndex === null },
  );

  const { rateCapture } = edits;
  const slides = useMemo<LightboxSlide[]>(
    () =>
      visiblePhotos.map((p) => ({
        url: `/api/photos/${p.photoId}/display`,
        caption: `${speciesName(p)}${p.takenAt ? ` · ${formatDate(p.takenAt)}` : ""}`,
        speciesId: p.speciesId,
        rating: p.qualityRating,
        onRate: (rating: number | null) => void rateCapture(p.captureId, rating),
        info: {
          cameraModel: p.cameraModel,
          lens: p.lens,
          focalLengthMm: p.focalLengthMm,
          aperture: p.aperture,
          shutter: p.shutter,
          iso: p.iso,
          takenAt: p.takenAt,
        },
      })),
    [visiblePhotos, speciesName, rateCapture],
  );

  if (loadError) {
    return (
      <EmptyState
        title={t("trips.detail.loadFailed")}
        action={{ label: t("common.retry"), onClick: () => void load() }}
      />
    );
  }
  if (!trip || !photos || !speciesItems) return <LoadingScreen />;

  const { pendingImports, scanning, startScan } = jobs;
  // Every photo the scan found, including ones a culling app rejected that the review leaves out.
  const scannedCount = jobs.scannedCount;
  const noPhotos = photos.length === 0 && pendingImports.length === 0;
  const photoFilterCount = filters.activeFilterCount + (pickedSpecies.size > 0 ? 1 : 0);
  const rawOnlyHidesAll = !search && rawFiles === "hide" && photoFilterCount === 1;
  const scanLabel = scanning
    ? t("trips.detail.scanning")
    : photos.length === 0
      ? t("trips.detail.scanFolder")
      : t("trips.detail.addMorePhotos");

  return (
    <div className="flex-1 bg-canvas">
      <PageHeader
        sticky
        title={
          <EditableTextField
            value={trip.name}
            onSave={edits.saveName}
            maxLength={NAME_MAX_LENGTH}
            className="text-title-2 font-semibold text-ink"
          />
        }
        backFallbackTo="/albums?view=trips"
        backLabel={t("nav.albums")}
        actions={
          <>
            {/* The species view is the Collection's toolbar; the search is one URL param in both views. */}
            {view === "species" && speciesItems.length > 0 ? (
              <CollectionToolbar
                bare
                url={url}
                prefs={prefs}
                startTransition={startGroupingTransition}
                availableTaxonFilters={taxonChoices}
                namingStyles={namingStyles}
                hasGhost={speciesItems.some((i) => i.isGhost)}
                hasLost={speciesItems.some((i) => i.isLost)}
                hasNeedsBetter={speciesItems.some((i) => i.needsBetterPhoto)}
                shownCount={visibleSpecies.length}
                totalLoaded={speciesItems.length}
                gridWidth={gridWidth}
                show={show}
              />
            ) : (
              <>
                <SearchInput
                  value={search}
                  onChange={setSearch}
                  placeholder={t("trips.detail.searchPlaceholder")}
                  aria-label={t("trips.detail.searchPlaceholder")}
                  className="w-full sm:w-56"
                />
                <PhotoViewMenu
                  sections={view === "gallery" ? ["show", "group", "sort", "size", "captions"] : ["show"]}
                  activeCount={
                    view === "gallery" ? (sortBy !== "newest" ? 1 : 0) + (photoGroupBy !== "none" ? 1 : 0) : 0
                  }
                  show={show}
                  group={{ value: photoGroupBy, options: TRIP_PHOTO_GROUPS, onChange: setPhotoGroupBy }}
                  sort={{ value: sortBy, options: PHOTO_SORTS, onChange: filters.setSortBy }}
                  size={{ value: thumbSizePx, onChange: updateThumbSize }}
                  captions={captions}
                />
              </>
            )}
            {/* Select acts on photos; the species view's filters are in its own toolbar. */}
            {view === "gallery" && photos.length > 0 && (
              <>
                <PhotoFiltersMenu
                  filters={filters}
                  facets={photoFacets}
                  tagOptions={tagOptions}
                  sections={TRIP_FILTER_SECTIONS}
                  species={{
                    options: speciesChoices,
                    selected: pickedSpecies,
                    onChange: (next) => setSpeciesParam([...next].join(",")),
                  }}
                />
                <SelectModeToggle
                  active={edits.selectMode}
                  onEnter={() => edits.setSelectMode(true)}
                  onExit={edits.exitSelectMode}
                />
              </>
            )}
            <Menu
              trigger="toolbar"
              open={moreMenu.openKey === true}
              onToggle={() => moreMenu.setOpenKey(moreMenu.openKey ? null : true)}
              menuRef={moreMenu.ref}
              className="relative"
            >
              <MenuPanel className="min-w-44 whitespace-nowrap">
                {/* While a scan runs the item names it, so it's clear why it can't start another. */}
                <MenuItem onSelect={() => void startScan()} disabled={scanning}>
                  {scanLabel}
                </MenuItem>
                <MenuItem onSelect={() => setFilesDialog("move")} disabled={scanning || jobs.importing}>
                  {t("trips.detail.moveFiles")}
                </MenuItem>
                <MenuItem onSelect={() => setFilesDialog("relink")}>{t("trips.detail.relinkFiles")}</MenuItem>
                <MenuItem onSelect={() => void lookForMoved()}>{t("movedPhotos.tripMenu")}</MenuItem>
                <MenuItem onSelect={() => setFilesDialog("wildlife")}>{t("trips.detail.setWildlifeFolder")}</MenuItem>
                <MenuSeparator />
                <MenuItem danger onSelect={() => void deleteTrip()}>
                  {t("trips.detail.delete")}
                </MenuItem>
              </MenuPanel>
            </Menu>
          </>
        }
      >
        <TripHeaderDetails
          trip={trip}
          photoCount={photos.length + jobs.importedSoFar}
          summary={summary}
          onRelocate={jobs.relocateFolder}
          onSaveDescription={edits.saveDescription}
        />
        <TripDatesBar trip={trip} onChanged={() => void load()} />
      </PageHeader>
      <Tip id="trip-dates" when={!trip.startDate} className="mx-page mt-3" />

      {filesDialog && id && (
        <TripFilesDialog
          tripId={id}
          mode={filesDialog}
          onClose={() => setFilesDialog(null)}
          onRelinked={() => void load()}
        />
      )}

      {jobs.relocating && (
        <div className="border-b border-line bg-surface px-page py-3">
          <FolderBrowser
            onChoose={(folder) => jobs.applyRelocate(jobs.relocating!, folder)}
            onCancel={() => jobs.setRelocating(null)}
          />
        </div>
      )}

      {edits.selectMode && (
        <div className="flex items-center justify-between border-b border-line bg-surface-muted px-page py-2 text-footnote">
          <span className="text-muted">
            {t("trips.detail.selectedCount", { count: edits.selectedCaptureIds.size })}
          </span>
          <span className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void removeSelected()}
              disabled={edits.selectedCaptureIds.size === 0}
            >
              {t("trips.detail.removeSelected")}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => edits.setConfirmingBatchDelete(true)}
              disabled={edits.selectedCaptureIds.size === 0}
            >
              {t("trips.detail.deleteSelected")}
            </Button>
          </span>
        </div>
      )}

      <main className="space-y-section p-page">
        <TripJobStatus tripId={id} jobs={jobs} />
        <TripSuggestions key={`${trip.startDate}:${trip.endDate}`} trip={trip} onChanged={() => void load()} />
        <TripChecklists tripId={trip.id} />

        {scannedCount > 0 && (
          <TripScanReview
            tripId={id}
            destinationFolder={trip.destinationFolder}
            suggestEnabled={suggestEnabled}
            jobs={jobs}
          />
        )}

        {view === "species" ? (
          speciesItems.length === 0 ? (
            <EmptyState compact title={t("trips.detail.noSpecies")} />
          ) : visibleSpecies.length === 0 ? (
            <EmptyState
              compact
              title={
                search
                  ? t("trips.detail.noSpeciesMatch", { search })
                  : t("collection.noFilterMatch.title", { count: speciesItems.length })
              }
              action={{ label: t("gallery.empty.clearFilters"), onClick: () => url.clearFilters({ taxon: null }) }}
            />
          ) : (
            <div
              // The one switch the cards' CSS reads (theme.css), as on the Collection.
              data-uncollected-colour={prefs.uncollectedColour || undefined}
              className={isGroupingPending ? "opacity-60 transition-opacity" : "transition-opacity"}
            >
              <GroupedSpeciesGrid
                items={visibleSpecies}
                groupBy={url.groupBy}
                sortBy={url.sortBy}
                searchRanks={speciesRanks}
                collectedFirst={url.collectedFirst}
                seenFirst={url.seenFirst}
                targetFirst={url.targetFirst}
                cardMinWidth={prefs.cardMinWidth}
                hideLabels={prefs.hideLabels}
                hideNames={prefs.hideNames}
                onWidthChange={setGridWidth}
                onChanged={reloadSpecies}
                backLabel={trip.name}
                tripId={trip.id}
              />
            </div>
          )
        ) : noPhotos && buildMode ? (
          <Panel className="max-w-2xl space-y-3">
            <p className="text-callout text-ink">{t("trips.detail.build.dropPhotos")}</p>
            <PhotoImportRows tripId={id} suggestedRegionId={trip.regionId} onImported={() => void load()} />
            <div className="border-t border-line pt-3">
              {/* matchOnly ignores speciesId: the matched trip photo decides each RAW's species. */}
              <RawUpload speciesId="" volumeId="" matchOnly onFiled={() => void load()} />
            </div>
            <p className="text-footnote text-muted">{t("trips.detail.build.scanInstead")}</p>
          </Panel>
        ) : noPhotos ? (
          <EmptyState
            icon={EMPTY_TRIP_ICON}
            title={t("trips.detail.empty.title")}
            description={
              scannedCount === 0 ? t("trips.detail.empty.scanFolder") : t("trips.detail.empty.assignThenImport")
            }
            action={scannedCount === 0 ? { label: scanLabel, onClick: startScan } : undefined}
          />
        ) : visiblePhotos.length === 0 && pendingImports.length === 0 ? (
          <EmptyState
            compact
            title={search ? t("trips.detail.noPhotosMatch", { search }) : t("gallery.empty.noFilterMatch")}
            // A saved "hide RAW files" alone empties a RAW-only trip, so it's named and undone in one step.
            description={
              rawOnlyHidesAll
                ? t("trips.detail.rawOnlyHidden")
                : photoFilterCount > 0
                  ? t("gallery.empty.filtersBody")
                  : undefined
            }
            action={
              rawOnlyHidesAll
                ? { label: t("gallery.empty.showAll"), onClick: () => filters.setRawFiles(DEFAULT_RAW_FILES) }
                : photoFilterCount > 0
                  ? { label: t("gallery.empty.clearFilters"), onClick: filters.clearFilters }
                  : undefined
            }
          />
        ) : (
          <TripPhotoGrid
            trip={trip}
            photos={visiblePhotos}
            groups={photoGroups}
            pendingImports={pendingImports}
            thumbSizePx={thumbSizePx}
            captions={captions}
            edits={edits}
            select={select}
            menu={menu}
            onReload={() => void load()}
            onOpen={setLightboxIndex}
          />
        )}
      </main>

      {lightboxIndex !== null && (
        <Lightbox
          slides={slides}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
          backLabel={trip.name}
        />
      )}

      {edits.croppingCoverPhotoUrl && (
        <CardCropEditor
          photoUrl={edits.croppingCoverPhotoUrl}
          initialX={trip.coverCropX}
          initialY={trip.coverCropY}
          initialSize={trip.coverCropSize}
          onClose={() => edits.setCroppingCoverPhotoUrl(null)}
          onSave={edits.saveCoverCrop}
          onReset={edits.resetCoverCrop}
        />
      )}

      <ConfirmDialog
        open={!!edits.confirmingDeleteCaptureId}
        title={t("trips.detail.deletePhoto.title")}
        message={t("trips.detail.trashMessage", { noun: "photo" })}
        confirmLabel={t("common.delete")}
        danger
        busy={edits.deleting}
        onConfirm={() =>
          edits.confirmingDeleteCaptureId && void edits.confirmDeletePhoto(edits.confirmingDeleteCaptureId)
        }
        onCancel={() => edits.setConfirmingDeleteCaptureId(null)}
      />

      <Modal
        open={edits.confirmingBatchDelete}
        onClose={() => {
          if (edits.deleting) return;
          edits.closeBatchDelete();
        }}
        title={t("trips.detail.deleteSelectedTitle", { count: edits.selectedCaptureIds.size })}
        size="sm"
        initialFocusRef={batchDeleteRef}
        footer={
          <>
            <Button variant="secondary" disabled={edits.deleting} onClick={edits.closeBatchDelete}>
              {t("common.cancel")}
            </Button>
            <Button
              ref={batchDeleteRef}
              variant="danger"
              onClick={edits.confirmDeleteSelected}
              loading={edits.deleting}
            >
              {t("common.delete")}
            </Button>
          </>
        }
      >
        <p className="text-callout text-muted">{t("trips.detail.trashMessage", { noun: "photo" })}</p>
        {edits.selectedHaveRaw && (
          <Checkbox checked={edits.deleteRawToo} onChange={edits.setDeleteRawToo} className="mt-3">
            {t("trips.detail.deleteRawToo")}
          </Checkbox>
        )}
      </Modal>
    </div>
  );
}
