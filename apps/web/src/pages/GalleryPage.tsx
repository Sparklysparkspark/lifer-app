import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import Lightbox, { type LightboxSlide } from "../components/Lightbox";
import { photoFilePaths } from "../lib/photoFilePaths";
import { Spinner } from "../components/LoadingScreen";
import PageHeader from "../components/PageHeader";
import AddToAlbumModal from "../components/AddToAlbumModal";
import CaptureEditModal from "../components/CaptureEditModal";
import CoordinatesModal from "../components/CoordinatesModal";
import type { SpeciesResult } from "../components/SpeciesPicker";
import type { Appearance } from "@lifer/shared";
import { useLatest } from "../hooks/useLatest";
import Button from "../components/Button";
import FormMessage from "../components/FormMessage";
import InlineSpinner from "../components/InlineSpinner";
import { useSelectMode } from "../hooks/useSelectMode";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { useScrollMemory } from "../hooks/useScrollMemory";
import { useReadyMarker } from "../lib/readyMarker";
import { useGoBack } from "../hooks/useGoBack";
import { useSearchParamsKeepingState, useUrlParam } from "../hooks/useSearchParamsKeepingState";
import { isTauri } from "../lib/tauri";
import { formatDate } from "../lib/format";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import type { GalleryItem } from "./gallery/types";
import {
  effectiveGalleryGroupBy,
  galleryCountText,
  galleryParams,
  removeSearchPart,
  soleRegionId,
  selectionHasRaw,
  selectionLocated,
  UNCATEGORIZED_REGION_ID,
} from "./gallery/galleryHelpers";
import { useGalleryDisplayPrefs } from "./gallery/useGalleryDisplayPrefs";
import { useGalleryFacets } from "./gallery/useGalleryFacets";
import { useGalleryFilters } from "./gallery/useGalleryFilters";
import { useGalleryListing } from "./gallery/useGalleryListing";
import { useGalleryEdits } from "./gallery/useGalleryEdits";
import { collapseBursts, useGalleryBursts } from "./gallery/useGalleryBursts";
import SceneStrip from "./gallery/SceneStrip";
import { GallerySummary, GalleryToolbar } from "./gallery/GalleryHeader";
import SaveSmartAlbumModal from "./gallery/SaveSmartAlbumModal";
import { ManagePinsModal, PinFilterModal, PinnedFilters } from "./gallery/PinnedFilters";
import { usePinnedFilters } from "./gallery/usePinnedFilters";
import GalleryGrid, { GalleryEmptyState } from "./gallery/GalleryGrid";
import { GalleryPhotoMenu, HiddenTileMenu } from "./gallery/GalleryPhotoMenu";
import { GallerySelectBar, HiddenSelectBar } from "./gallery/GallerySelection";
import { useToast } from "../hooks/useToast";
import { errorMessage } from "../lib/errorMessage";
import { cullInfo } from "../lib/cullInfo";
import { useSpeciesName } from "../lib/speciesName";
import { useApiResource } from "../lib/resource";
import { ignore } from "../lib/ignore";
import Tip from "../components/Tip";
import VersionNotice, { useVersionNotice } from "../components/VersionNotice";
import { VersionTileMenu } from "../components/PhotoVersions";
import { openPhotoVersions, versionName } from "../lib/photoVersions";
import type { ComparePhoto } from "../components/CompareView";
import type { Placing } from "../components/PhotoMap";

const galleryItemId = (item: GalleryItem) => item.captureId;

// Loaded when photos are first compared.
const CompareView = lazy(() => import("../components/CompareView"));

// MapLibre is large, so it loads only when the map is shown.
const PhotoMap = lazy(() => import("../components/PhotoMap"));

// Every photo across all species, as one browsable, filterable, searchable masonry grid.
export default function GalleryPage() {
  const { t } = useTranslation();
  const speciesName = useSpeciesName();
  const goBack = useGoBack();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  // A burst frame the grid doesn't list was picked in the viewer: it pages through that scene.
  const [sceneItems, setSceneItems] = useState<GalleryItem[] | null>(null);
  // The photos open side by side, in the order they were selected.
  const [compareIds, setCompareIds] = useState<string[] | null>(null);
  const display = useGalleryDisplayPrefs();
  const [searchParams, setSearchParams] = useSearchParamsKeepingState();
  // ?select=1&albumId=X turns the page into an "add photos to this album" picker.
  // ?fix=region, from Stats' "missing a region", opens straight into selecting photos to place.
  const fixingRegion = searchParams.get("fix") === "region";
  const startInSelectMode = searchParams.get("select") === "1" || fixingRegion;
  const targetAlbumId = searchParams.get("albumId");
  // Without the name (still loading, or it failed) the picker shows a generic title.
  const targetAlbumName =
    useApiResource<{ name: string }>(targetAlbumId ? `/albums/${targetAlbumId}` : null).data?.name ?? null;
  const facets = useGalleryFacets();
  const filters = useGalleryFilters(searchParams, setSearchParams);
  const { query } = filters;
  const similarTo = query.similarTo ?? null;
  // The View menu's Map, in ?view=map so reload and back keep it. The album picker is always a grid.
  const [view, setView] = useUrlParam("view");
  const layout = view === "map" && !targetAlbumId ? "map" : "grid";
  // Photos being placed on the map; leaving the map drops them.
  const [placing, setPlacing] = useState<Placing | null>(null);
  if (placing && layout !== "map") setPlacing(null);
  const [savingSmartAlbum, setSavingSmartAlbum] = useState(false);
  const [pinDialog, setPinDialog] = useState<"pin" | "manage" | null>(null);
  const pinned = usePinnedFilters();
  // Every tag in use: the Tag filter's choices and the tag editors' suggestions.
  const [tagOptions, setTagOptions] = useState<string[]>([]);
  useEffect(() => {
    api
      .get("/captures/tags")
      .then((res) => setTagOptions(res.tags))
      .catch(ignore("Couldn't load tags"));
  }, []);
  const groupBy = effectiveGalleryGroupBy(display.groupBy, !!soleRegionId(query.regionIds));
  // Every print, edit and export as its own card (View menu); a search and the Hidden filter list photos.
  const allVersions = display.allVersions && !query.searchQuery && !query.onlyHidden;
  const listing = useGalleryListing({ query, groupBy, lightboxIndex: sceneItems ? null : lightboxIndex, allVersions });
  const versionNotice = useVersionNotice();
  const {
    items,
    loadError,
    nextCursor,
    total,
    loadMoreError,
    searching,
    searchReading,
    searchParts,
    selectingAll,
    sentinelRef,
    loadMoreRef,
    load,
    selectAll,
    selectAllMeta,
  } = listing;
  // Back from a photo's species page returns to the same spot in the grid.
  // A search's quick pass can be a page shorter than the full answer, which would clamp the restore.
  useScrollMemory(!!items && items.length > 0 && !searching);
  useReadyMarker(!!items);
  const bursts = useGalleryBursts(allVersions ? null : items);
  // View > Group bursts: one tile per burst. The grid's indexes are mapped back to `items`.
  const gridItems = useMemo(
    () => (items && display.groupBursts && !allVersions ? collapseBursts(items, bursts) : items),
    [items, display.groupBursts, allVersions, bursts],
  );
  const itemIndex = useCallback(
    (i: number) => (gridItems === items || !gridItems || !items ? i : items.indexOf(gridItems[i])),
    [gridItems, items],
  );
  const photoMenu = useDropdownMenu<string>();
  const setOpenMenuKey = photoMenu.setOpenKey;
  // The missing-date and missing-region views from Stats: fixing the last one goes back there.
  const fixingRegionView =
    fixingRegion && query.regionIds.length === 1 && query.regionIds[0] === UNCATEGORIZED_REGION_ID;
  const toFixCount = query.missingDate || fixingRegionView ? (items?.length ?? null) : null;
  const hadPhotosToFix = useRef(false);
  useEffect(() => {
    if (toFixCount == null) return;
    if (toFixCount > 0) hadPhotosToFix.current = true;
    else if (hadPhotosToFix.current) goBack("/stats");
  }, [toFixCount, goBack]);
  // Select all can take photos not loaded yet, so the selection clears when the query changes
  // rather than being pruned to what's loaded.
  const queryKey = galleryParams(query).toString();
  const select = useSelectMode(items, galleryItemId, startInSelectMode, { resetKey: queryKey });
  const { selectMode, setSelectMode, selectedIds, setSelectedIds, dragPreviewIds, dragProps } = select;
  const { toggle } = select;
  const { onDragSelectStart, onDragSelectEnter } = dragProps;
  const openFromGrid = useCallback((i: number) => setLightboxIndex(itemIndex(i)), [itemIndex]);
  const toggleFromGrid = useCallback(
    (id: string, i: number, shift: boolean) => toggle(id, itemIndex(i), shift),
    [toggle, itemIndex],
  );
  const dragStartFromGrid = useCallback((i: number) => onDragSelectStart(itemIndex(i)), [onDragSelectStart, itemIndex]);
  const dragEnterFromGrid = useCallback((i: number) => onDragSelectEnter(itemIndex(i)), [onDragSelectEnter, itemIndex]);
  const edits = useGalleryEdits({
    items,
    setItems: listing.setItems,
    setTotal: listing.setTotal,
    load: listing.load,
    loadRef: listing.loadRef,
    select,
    targetAlbumId,
    goBack,
    closeMenu: () => setOpenMenuKey(null),
    tagOptions,
    setTagOptions,
    refreshHiddenCount: facets.refreshHiddenCount,
    fetchOriginals: listing.fetchOriginals,
  });
  const toast = useToast();
  // The "Hidden" filter lists hidden photos (hidden from a menu, or rejected in a culling app). They're
  // read-only there: the only thing to do is unhide them.
  const hiddenView = query.onlyHidden;
  const [unhiding, setUnhiding] = useState(false);
  async function unhide(captureIds: string[]) {
    setUnhiding(true);
    try {
      const res = await api.post("/captures/unhide", { captureIds });
      const ids = new Set(captureIds);
      listing.setItems((prev) => prev?.filter((it) => !ids.has(it.captureId)) ?? prev);
      listing.setTotal((t) => (t === null ? t : Math.max(0, t - ids.size)));
      setOpenMenuKey(null);
      edits.exitSelectMode();
      facets.refreshHiddenCount();
      toast.success(t("gallery.hidden.unhidToast", { count: res.unhidden }));
    } catch (err) {
      toast.error(errorMessage(err, t("gallery.hidden.unhideFailed")));
    } finally {
      setUnhiding(false);
    }
  }

  function selectAllPhotos() {
    return selectAll((captureIds) => {
      setSelectMode(true);
      setSelectedIds(captureIds);
    });
  }

  function placeSelectionOnMap() {
    setPlacing({
      captureIds: [...selectedIds],
      located: selectionLocated(items ?? [], selectedIds, selectAllMeta?.located),
    });
    edits.exitSelectMode();
    setView("map");
  }

  const deleteSelectedRef = useLatest(() => void edits.deleteSelected());

  // Off while the lightbox is open; it owns the keyboard then.
  useKeyboardShortcuts(
    {
      close: () => {
        if (selectMode) edits.exitSelectMode();
      },
      selectAll: (e) => {
        e.preventDefault();
        void selectAllPhotos();
      },
      trash: () => void edits.deleteSelected(),
    },
    // Showing every version: selection would mix photos and their versions, so it's off.
    { enabled: lightboxIndex === null && !compareIds && !allVersions },
  );

  // Desktop: the native Edit menu's "Delete" item fires this event, same as the Delete key.
  useEffect(() => {
    if (!isTauri() || lightboxIndex !== null) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen("menu:delete-selected", () => deleteSelectedRef.current()))
      .then((fn) => {
        // listen() resolves async: if cleanup already ran, drop the listener right away.
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(ignore("Couldn't listen for the Delete menu item"));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [lightboxIndex, deleteSelectedRef]);

  const { rateCapture, tagCapture } = edits;
  // Changes every render; the ref keeps the slides memoized.
  const reassignRef = useLatest(edits.reassignSpecies);
  // Saved by CoordinatesModal; the loaded photos follow without a reload.
  const setItems = listing.setItems;
  const applyCoordinates = useCallback(
    (captureIds: string[], point: { lat: number; lon: number } | null, region: { id: string; name: string } | null) => {
      const ids = new Set(captureIds);
      setItems(
        (prev) =>
          prev?.map((it) =>
            ids.has(it.captureId)
              ? {
                  ...it,
                  lat: point?.lat ?? null,
                  lon: point?.lon ?? null,
                  ...(region ? { regionId: region.id, regionName: region.name } : {}),
                }
              : it,
          ) ?? prev,
      );
    },
    [setItems],
  );
  const applyAppearance = useCallback(
    (captureIds: string[], changes: Partial<Appearance>) => {
      const ids = new Set(captureIds);
      setItems((prev) => prev?.map((it) => (ids.has(it.captureId) ? { ...it, ...changes } : it)) ?? prev);
    },
    [setItems],
  );
  // Morphs on the loaded photos, offered while typing one.
  const morphOptions = useMemo(() => (items ?? []).flatMap((i) => (i.morph ? [i.morph] : [])), [items]);
  const slides = useMemo<LightboxSlide[]>(
    () =>
      (sceneItems ?? items ?? []).map((item) => {
        // A version listed on its own is read-only here: its photo's rating, tags and place apply.
        // A scene's photo the grid doesn't list can only be rated.
        const outside = !!sceneItems && !items?.some((it) => it.captureId === item.captureId);
        const readOnly = hiddenView || !!item.version || outside;
        const i = item;
        const rate = (rating: number | null) => {
          void rateCapture(i.captureId, rating);
          if (outside)
            setSceneItems(
              (prev) =>
                prev?.map((it) => (it.captureId === i.captureId ? { ...it, qualityRating: rating } : it)) ?? prev,
            );
        };
        return {
          url: `/api/photos/${i.photoId}/display`,
          thumbUrl: `/api/photos/${i.photoId}/thumb`,
          width: i.width,
          height: i.height,
          videoUrl: i.kind === "video" ? `/api/photos/${i.photoId}/video` : null,
          audioUrl: i.kind === "audio" ? `/api/photos/${i.photoId}/audio` : null,
          frameUrl: i.kind === "video" ? `/photos/${i.photoId}/frame` : null,
          caption: `${speciesName(i)}${i.takenAt ? " · " + formatDate(i.takenAt, "medium") : ""}`,
          speciesId: i.speciesId,
          // Already in its group, the link would lead back here.
          similarHref: readOnly || similarTo ? null : `/gallery?similarTo=${i.captureId}`,
          rating: i.qualityRating,
          onRate: hiddenView || item.version ? undefined : rate,
          tags: i.tags,
          onTagsChange: readOnly ? undefined : (tags: string[]) => tagCapture(i.captureId, tags),
          appearance: i,
          onAppearanceChange: readOnly ? undefined : (changes) => applyAppearance([i.captureId], changes),
          coordinates: {
            lat: i.lat == null ? null : Number(i.lat),
            lon: i.lon == null ? null : Number(i.lon),
            hasRegion: !!i.regionId,
            onChange: readOnly ? undefined : (point, region) => applyCoordinates([i.captureId], point, region),
          },
          captureId: i.captureId,
          onVersionsChange: hiddenView ? undefined : edits.reload,
          onFrameSaved: edits.reload,
          onReassign: readOnly ? undefined : (species: SpeciesResult) => void reassignRef.current(i.captureId, species),
          info: {
            cameraModel: i.cameraModel,
            lens: i.lens,
            focalLengthMm: i.focalLengthMm,
            aperture: i.aperture,
            shutter: i.shutter,
            iso: i.iso,
            takenAt: i.takenAt,
            durationSeconds: i.durationSeconds,
            files: photoFilePaths(i.originalRef, i.rawRef),
            cull: cullInfo(i.cullVerdict, i.cullLabel),
          },
        };
      }),
    [
      items,
      sceneItems,
      rateCapture,
      tagCapture,
      reassignRef,
      hiddenView,
      speciesName,
      applyCoordinates,
      applyAppearance,
      similarTo,
      edits.reload,
    ],
  );
  const comparePhotos = useMemo<ComparePhoto[]>(
    () =>
      (compareIds ?? []).flatMap((id) => {
        const i = items?.find((it) => it.captureId === id);
        if (!i) return [];
        const detail = [
          i.cameraModel,
          i.focalLengthMm ? `${Math.round(Number(i.focalLengthMm))}mm` : null,
          i.aperture ? `f/${i.aperture}` : null,
          i.shutter,
          i.iso ? `ISO ${i.iso}` : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return [
          {
            captureId: i.captureId,
            photoId: i.photoId,
            name: speciesName(i),
            takenAt: i.takenAt,
            detail,
            rating: i.qualityRating,
            isFeatured: i.isFeatured,
          },
        ];
      }),
    [compareIds, items, speciesName],
  );

  const placingItem = edits.placingCaptureId ? items?.find((it) => it.captureId === edits.placingCaptureId) : undefined;
  const editingId = edits.editing?.captureId;
  const editingItem = editingId ? items?.find((it) => it.captureId === editingId) : undefined;
  // The photo left the list (deleted, or filtered out by a reload): its dialog closes for good
  // rather than coming back if the photo does.
  if (editingId && items && !editingItem) edits.setEditing(null);
  // Select all lists the videos and RAWs among photos not loaded yet.
  const selectedHaveRaw = useMemo(
    () => selectionHasRaw(items ?? [], selectedIds, selectAllMeta?.raw),
    [items, selectedIds, selectAllMeta],
  );

  // A version's link back to its photo: opened here when it's loaded, else its Versions panel.
  const showPhoto = (groupId: string) => {
    const at = items?.findIndex((it) => it.captureId === groupId) ?? -1;
    if (at >= 0) setLightboxIndex(at);
    else openPhotoVersions(groupId, edits.reload);
  };
  const renderMenu = (item: GalleryItem) =>
    item.version ? (
      <VersionTileMenu
        groupCaptureId={item.version.of}
        captureId={item.captureId}
        name={versionName(t, item.version)}
        onShowPhoto={() => showPhoto(item.version!.of)}
        onChange={edits.reload}
        onClose={() => setOpenMenuKey(null)}
      />
    ) : hiddenView ? (
      <HiddenTileMenu onUnhide={() => void unhide([item.captureId])} />
    ) : (
      <GalleryPhotoMenu item={item} edits={edits} closeMenu={() => setOpenMenuKey(null)} />
    );

  return (
    <div className="flex-1 bg-canvas">
      {targetAlbumId ? (
        // A picker, not a browsed page: no back link or "Gallery" title.
        <header data-tauri-drag-region className="border-b border-line bg-surface px-page py-4">
          <h1 className="text-title-2 font-semibold text-ink">
            {targetAlbumName !== null
              ? t("gallery.albumPicker.title", { album: targetAlbumName })
              : t("gallery.albumPicker.titleUnnamed")}
          </h1>
        </header>
      ) : (
        <PageHeader
          topLevel
          title={t("gallery.title")}
          actions={
            items && (
              <GalleryToolbar
                filters={filters}
                facets={facets}
                display={display}
                groupBy={groupBy}
                tagOptions={edits.tagOptions}
                searching={searching}
                hasPhotos={items.length > 0 && layout === "grid" && !allVersions}
                selectMode={selectMode}
                onEnterSelectMode={() => setSelectMode(true)}
                onExitSelectMode={edits.exitSelectMode}
                onSaveSmartAlbum={() => setSavingSmartAlbum(true)}
                onPinFilters={() => setPinDialog("pin")}
                layout={layout}
                onLayoutChange={(next) => {
                  if (next === "map") edits.exitSelectMode();
                  setView(next === "grid" ? "" : next);
                }}
              />
            )
          }
        >
          <GallerySummary
            countText={
              items &&
              (allVersions && total !== null
                ? t("versions.showingAll", { count: total })
                : galleryCountText({
                    missingDate: query.missingDate,
                    loadedCount: items.length,
                    nextCursor: nextCursor,
                    total: total,
                    searchQuery: query.searchQuery,
                    // The tokens below say how a long search was read.
                    searchReading: searchParts.length >= 2 ? null : searchReading,
                    media: query.mediaFilter,
                  }))
            }
            filters={filters}
            similarAlone={!!similarTo && total === 1}
            searchParts={searchParts}
            onRemoveSearchPart={(part) => filters.setSearchInput(removeSearchPart(filters.searchInput, part))}
          />
          {!similarTo && <PinnedFilters pinned={pinned} filters={filters} onManage={() => setPinDialog("manage")} />}
        </PageHeader>
      )}
      {pinDialog === "pin" && <PinFilterModal pinned={pinned} filters={filters} onClose={() => setPinDialog(null)} />}
      {pinDialog === "manage" && <ManagePinsModal pinned={pinned} onClose={() => setPinDialog(null)} />}
      {savingSmartAlbum && <SaveSmartAlbumModal query={query} onClose={() => setSavingSmartAlbum(false)} />}

      {/* design-token: sits just under the app title bar (AppSidebar header, 52px) while the grid scrolls. */}
      <div className="sticky top-[52px] z-20">
        {selectMode && hiddenView && (
          <HiddenSelectBar
            total={total ?? undefined}
            onSelectAll={() => void selectAllPhotos()}
            onDeselectAll={select.clear}
            selectedIds={selectedIds}
            selectingAll={selectingAll}
            unhiding={unhiding}
            onUnhide={() => void unhide([...selectedIds])}
          />
        )}
        {selectMode && !hiddenView && (
          <GallerySelectBar
            total={total ?? undefined}
            onSelectAll={() => void selectAllPhotos()}
            onDeselectAll={select.clear}
            selectedHaveRaw={selectedHaveRaw}
            selectedIds={selectedIds}
            selectingAll={selectingAll}
            targetAlbumId={targetAlbumId}
            edits={edits}
            regionFirst={fixingRegionView}
            onCoordinatesSaved={applyCoordinates}
            onAppearanceSaved={applyAppearance}
            morphOptions={morphOptions}
            onCompare={() => setCompareIds([...selectedIds])}
            compareFirst={!!similarTo}
            onPlaceOnMap={placeSelectionOnMap}
            selectionLacksRegion={
              !!items && items.filter((it) => selectedIds.has(it.captureId) && !it.regionId).length === selectedIds.size
            }
            suggestedRegionIds={[
              selectedIds.size === 1 ? items?.find((it) => selectedIds.has(it.captureId))?.regionId : null,
              ...query.regionIds.filter((id) => id !== UNCATEGORIZED_REGION_ID),
            ]}
          />
        )}
      </div>
      {(edits.reassignError || edits.bulkTagError) && (
        <div className="space-y-2 border-b border-line bg-surface px-page py-2">
          <FormMessage error={edits.reassignError} />
          <FormMessage error={edits.bulkTagError} />
        </div>
      )}

      <main className="space-y-section p-page">
        <VersionNotice notice={versionNotice} />
        <Tip id="gallery-select" when={!!items && items.length > 0 && !selectMode && layout === "grid"} />
        {/* Once, whether or not anything is grouped yet; the notice above says what just happened first. */}
        <Tip id="photo-versions" when={!!items && items.length > 0 && !versionNotice.visible && layout === "grid"} />
        <Tip id="first-map" when={!!items && items.length > 0 && layout === "map"} />
        {fixingRegionView && selectMode && !!items && items.length > 0 && (
          // Select all is in the selection bar above.
          <p className="text-callout text-muted">{t("gallery.fixRegion.note")}</p>
        )}
        {loadError && (
          <div className="flex items-center gap-3">
            <FormMessage error={loadError} className="flex-1" />
            <Button variant="secondary" size="sm" onClick={() => load()}>
              {t("common.retry")}
            </Button>
          </div>
        )}
        {!items ? (
          !loadError && <Spinner />
        ) : items.length === 0 ? (
          <GalleryEmptyState
            missingDate={query.missingDate}
            libraryEmpty={facets.libraryEmpty}
            searchQuery={query.searchQuery}
            activeFilterCount={filters.activeFilterCount}
            onClearFilters={filters.clearFilters}
            onClearSearch={() => filters.setSearchInput("")}
          />
        ) : layout === "map" ? (
          <>
            {/* Search ranks by picture content, which a count per place can't follow. */}
            {query.searchQuery && <p className="text-callout text-muted">{t("gallery.map.searchIgnored")}</p>}
            <Suspense fallback={<Spinner />}>
              <PhotoMap
                queryString={galleryParams({ ...query, searchQuery: "" }).toString()}
                onOpenRegion={(regionId) => {
                  filters.setRegionIds([regionId]);
                  setView("");
                }}
                onOpenArea={(bbox) => filters.setBbox(bbox, { view: null })}
                onOpenPlace={(name) => {
                  filters.setPlaces([name]);
                  setView("");
                }}
                onShowUnlocated={() => {
                  filters.setMissingCoordinates(true);
                  setView("");
                }}
                placing={placing}
                onPlacingChange={setPlacing}
                onChanged={edits.reload}
              />
            </Suspense>
          </>
        ) : (
          <GalleryGrid
            items={gridItems ?? items}
            bursts={display.groupBursts ? bursts : undefined}
            display={display}
            groupBy={groupBy}
            namingStyles={facets.namingStyles}
            missingDate={query.missingDate}
            selectMode={selectMode}
            selectedIds={selectedIds}
            dragPreviewIds={dragPreviewIds}
            menu={photoMenu}
            renderMenu={renderMenu}
            savingDateCaptureId={edits.savingDateCaptureId}
            onOpen={openFromGrid}
            onToggleSelect={toggleFromGrid}
            onDragStart={dragStartFromGrid}
            onDragEnter={dragEnterFromGrid}
            onRate={hiddenView ? () => {} : rateCapture}
            onSetTakenAt={hiddenView ? () => {} : edits.setTakenAt}
            onShowPhoto={showPhoto}
          />
        )}
        {items && nextCursor && layout === "grid" && (
          <div ref={sentinelRef} className="flex h-16 items-center justify-center gap-3 text-footnote text-muted">
            {loadMoreError ? (
              <>
                <span>{t("gallery.loadMoreFailed")}</span>
                <Button variant="secondary" size="sm" onClick={() => loadMoreRef.current()}>
                  {t("common.retry")}
                </Button>
              </>
            ) : (
              <InlineSpinner size="sm" label={t("gallery.loadingMore")} />
            )}
          </div>
        )}
      </main>

      {lightboxIndex !== null && (
        <Lightbox
          slides={slides}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => {
            setLightboxIndex(null);
            setSceneItems(null);
          }}
          tagOptions={edits.tagOptions}
          morphOptions={morphOptions}
          footer={(slide, follow) =>
            slide.captureId && !slide.videoUrl && !slide.audioUrl ? (
              <SceneStrip
                captureId={slide.captureId}
                onPick={(frame, scene) => {
                  follow(frame.captureId);
                  const list = sceneItems ?? items ?? [];
                  const at = list.findIndex((it) => it.captureId === frame.captureId);
                  if (at < 0) setSceneItems(scene);
                  setLightboxIndex(at >= 0 ? at : scene.findIndex((it) => it.captureId === frame.captureId));
                }}
              />
            ) : null
          }
        />
      )}

      {compareIds && comparePhotos.length > 0 && (
        <Suspense fallback={null}>
          <CompareView
            photos={comparePhotos}
            onClose={() => setCompareIds(null)}
            onRate={(captureId, rating) => void rateCapture(captureId, rating)}
            onFeature={(photo) => {
              const item = items?.find((it) => it.captureId === photo.captureId);
              if (!item || item.isFeatured) return;
              void edits.toggleFeatured(item);
              toast.success(t("compare.featuredToast"));
            }}
          />
        </Suspense>
      )}

      {editingItem && edits.editing && (
        <CaptureEditModal
          edit={edits.editing.edit}
          capture={editingItem}
          tagOptions={edits.tagOptions}
          onTagsChange={(tags) => void edits.tagCapture(editingItem.captureId, tags)}
          onReassign={(species) => void edits.reassignSpecies(editingItem.captureId, species)}
          onTagSpecies={(speciesId) => void edits.tagSpecies(editingItem.captureId, speciesId)}
          onClose={() => edits.setEditing(null)}
        />
      )}

      {placingItem && (
        <CoordinatesModal
          captureIds={[placingItem.captureId]}
          lat={placingItem.lat == null ? null : Number(placingItem.lat)}
          lon={placingItem.lon == null ? null : Number(placingItem.lon)}
          suggestRegion={!placingItem.regionId}
          place={{ label: placingItem.locationLabel, regionId: placingItem.regionId }}
          onSaved={(point, region) => {
            applyCoordinates([placingItem.captureId], point, region);
            // The place name and region come back with their names from the server.
            edits.reload();
          }}
          onUndone={edits.reload}
          onClose={() => edits.setPlacingCaptureId(null)}
        />
      )}

      {edits.addingToAlbumCaptureId && (
        <AddToAlbumModal
          captureIds={[edits.addingToAlbumCaptureId]}
          onClose={() => edits.setAddingToAlbumCaptureId(null)}
        />
      )}
    </div>
  );
}
