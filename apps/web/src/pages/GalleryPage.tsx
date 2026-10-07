import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import Lightbox, { type LightboxSlide } from "../components/Lightbox";
import { photoFilePaths } from "../lib/photoFilePaths";
import { Spinner } from "../components/LoadingScreen";
import PageHeader from "../components/PageHeader";
import AddToAlbumModal from "../components/AddToAlbumModal";
import Button from "../components/Button";
import FormMessage from "../components/FormMessage";
import InlineSpinner from "../components/InlineSpinner";
import { useSelectMode } from "../hooks/useSelectMode";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { isTauri } from "../lib/tauri";
import { useDeploymentMode, useIsTauri } from "../hooks/useDeploymentMode";
import { formatDate } from "../lib/format";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import type { ContextAnchor, GalleryItem } from "./gallery/types";
import { galleryCountText, selectionHasRaw, selectionNoun } from "./gallery/galleryHelpers";
import { useGalleryDisplayPrefs } from "./gallery/useGalleryDisplayPrefs";
import { useGalleryFacets } from "./gallery/useGalleryFacets";
import { useGalleryFilters } from "./gallery/useGalleryFilters";
import { useGalleryListing } from "./gallery/useGalleryListing";
import { useGalleryEdits } from "./gallery/useGalleryEdits";
import { GallerySummary, GalleryToolbar } from "./gallery/GalleryHeader";
import GalleryGrid, { GalleryEmptyState } from "./gallery/GalleryGrid";
import { GalleryTileMenu, HiddenTileMenu } from "./gallery/GalleryTile";
import { GalleryDeleteDialogs, GallerySelectBar, HiddenSelectBar } from "./gallery/GallerySelection";
import { useToast } from "../hooks/useToast";
import { errorMessage } from "../lib/errorMessage";
import { cullInfo } from "../lib/cullInfo";
import { useSpeciesName } from "../lib/speciesName";

// Every photo across all species, as one browsable, filterable, searchable masonry grid.
export default function GalleryPage() {
  const { t } = useTranslation();
  const speciesName = useSpeciesName();
  const navigate = useNavigate();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const display = useGalleryDisplayPrefs();
  const [searchParams, setSearchParams] = useSearchParams();
  // ?select=1&albumId=X turns the page into an "add photos to this album" picker.
  const startInSelectMode = searchParams.get("select") === "1";
  const targetAlbumId = searchParams.get("albumId");
  const [targetAlbumName, setTargetAlbumName] = useState<string | null>(null);
  useEffect(() => {
    if (!targetAlbumId) return;
    api
      .get<{ name: string }>(`/albums/${targetAlbumId}`)
      .then((res) => setTargetAlbumName(res.name))
      .catch(() => {});
  }, [targetAlbumId]);
  const facets = useGalleryFacets();
  const filters = useGalleryFilters(searchParams, setSearchParams);
  const { query } = filters;
  // Every tag in use: the Tag filter's choices and the tag editors' suggestions.
  const [tagOptions, setTagOptions] = useState<string[]>([]);
  useEffect(() => {
    api
      .get<{ tags: string[] }>("/captures/tags")
      .then((res) => setTagOptions(res.tags))
      .catch(() => {});
  }, []);
  const listing = useGalleryListing({ query, groupByRegion: display.groupByRegion, lightboxIndex });
  const {
    items,
    loadError,
    nextCursor,
    total,
    loadMoreError,
    searching,
    searchReading,
    selectingAll,
    sentinelRef,
    loadMoreRef,
    load,
    selectAll,
    selectAllMeta,
  } = listing;
  const { openKey: openMenuKey, setOpenKey: setOpenMenuKey, ref: openMenuRef } = useDropdownMenu<string>();
  // Right-click menu position; the open tile is still tracked by openMenuKey.
  const [contextMenuAnchor, setContextMenuAnchor] = useState<ContextAnchor | null>(null);
  const select = useSelectMode(items, (item) => item.captureId, startInSelectMode);
  const { selectMode, setSelectMode, selectedIds, setSelectedIds, dragPreviewIds, dragProps } = select;
  const edits = useGalleryEdits({
    setItems: listing.setItems,
    setTotal: listing.setTotal,
    load: listing.load,
    loadRef: listing.loadRef,
    select,
    targetAlbumId,
    navigate,
    closeMenu: () => setOpenMenuKey(null),
    tagOptions,
    setTagOptions,
  });
  const toast = useToast();
  // The "Hidden" filter lists photos imported hidden (a culling app rejected them). They're
  // read-only there: the only thing to do is unhide them.
  const hiddenView = query.onlyHidden;
  const [unhiding, setUnhiding] = useState(false);
  async function unhide(captureIds: string[]) {
    setUnhiding(true);
    try {
      const res = await api.post<{ unhidden: number }>("/captures/unhide", { captureIds });
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
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const batchDeleteButtonRef = useRef<HTMLButtonElement>(null);
  // Reveal runs on the API's machine, so only the desktop app's own local API can do it.
  const inTauriShell = useIsTauri();
  const deploymentMode = useDeploymentMode();
  const canRevealInFinder = inTauriShell && deploymentMode === "desktop";

  function selectAllPhotos() {
    return selectAll((captureIds) => {
      setSelectMode(true);
      setSelectedIds(captureIds);
    });
  }

  const requestBatchDeleteRef = useRef(edits.requestBatchDelete);
  useEffect(() => {
    requestBatchDeleteRef.current = edits.requestBatchDelete;
  });

  // Off while the lightbox is open; it owns the keyboard then.
  useKeyboardShortcuts(
    {
      escape: () => {
        if (selectMode) edits.exitSelectMode();
      },
      "mod+a": (e) => {
        e.preventDefault();
        void selectAllPhotos();
      },
      delete: edits.requestBatchDelete,
      s: () => setSelectMode((v) => !v),
    },
    { enabled: lightboxIndex === null },
  );

  // Desktop: the native Edit menu's "Delete" item fires this event, same as the Delete key.
  useEffect(() => {
    if (!isTauri() || lightboxIndex !== null) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen("menu:delete-selected", () => requestBatchDeleteRef.current()))
      .then((fn) => {
        // listen() resolves async: if cleanup already ran, drop the listener right away.
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [lightboxIndex]);

  const { rateCapture, tagCapture } = edits;
  const slides = useMemo<LightboxSlide[]>(
    () =>
      (items ?? []).map((i) => ({
        url: `/api/photos/${i.photoId}/display`,
        videoUrl: i.kind === "video" ? `/api/photos/${i.photoId}/video` : null,
        caption: `${speciesName(i)}${i.takenAt ? " · " + formatDate(i.takenAt, "medium") : ""}`,
        speciesId: i.speciesId,
        rating: i.qualityRating,
        onRate: hiddenView ? undefined : (rating: number | null) => rateCapture(i.captureId, rating),
        tags: i.tags,
        onTagsChange: hiddenView ? undefined : (tags: string[]) => tagCapture(i.captureId, tags),
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
      })),
    [items, rateCapture, tagCapture, hiddenView, speciesName],
  );

  const toggleMenu = useCallback(
    (photoId: string) => {
      setContextMenuAnchor(null);
      setOpenMenuKey((key) => (key === photoId ? null : photoId));
    },
    [setOpenMenuKey],
  );
  const openContextMenu = useCallback(
    (photoId: string, point: { x: number; y: number }) => {
      setOpenMenuKey(photoId);
      setContextMenuAnchor({ photoId, ...point });
    },
    [setOpenMenuKey],
  );

  // Select all lists the videos and RAWs among photos not loaded yet.
  const selectedHaveRaw = useMemo(
    () => selectionHasRaw(items ?? [], selectedIds, selectAllMeta?.raw),
    [items, selectedIds, selectAllMeta],
  );
  const batchNoun = useMemo(
    () => selectionNoun(items ?? [], selectedIds, selectAllMeta?.video ?? []),
    [items, selectedIds, selectAllMeta],
  );

  const renderMenu = (item: GalleryItem) =>
    hiddenView ? (
      <HiddenTileMenu onUnhide={() => void unhide([item.captureId])} />
    ) : (
      <GalleryTileMenu
        item={item}
        edits={edits}
        canRevealInFinder={canRevealInFinder}
        closeMenu={() => setOpenMenuKey(null)}
      />
    );

  return (
    <div className="flex-1 bg-canvas">
      {targetAlbumId ? (
        // A picker, not a browsed page: no back link or "Gallery" title.
        <header data-tauri-drag-region className="border-b border-line bg-surface px-6 py-4">
          <h1 className="text-lg font-semibold text-ink">
            {targetAlbumName !== null
              ? t("gallery.albumPicker.title", { album: targetAlbumName })
              : t("gallery.albumPicker.titleUnnamed")}
          </h1>
        </header>
      ) : (
        <PageHeader
          title={t("gallery.title")}
          actions={
            items && (
              <GalleryToolbar
                filters={filters}
                facets={facets}
                display={display}
                tagOptions={edits.tagOptions}
                searching={searching}
                hasPhotos={items.length > 0}
                selectMode={selectMode}
                onEnterSelectMode={() => setSelectMode(true)}
                onExitSelectMode={edits.exitSelectMode}
              />
            )
          }
        >
          <GallerySummary
            countText={
              items &&
              galleryCountText({
                missingDate: query.missingDate,
                loadedCount: items.length,
                nextCursor: nextCursor,
                total: total,
                searchQuery: query.searchQuery,
                searchReading: searchReading,
              })
            }
            filters={filters}
          />
        </PageHeader>
      )}

      {selectMode && hiddenView && (
        <HiddenSelectBar
          selectedIds={selectedIds}
          selectingAll={selectingAll}
          unhiding={unhiding}
          onUnhide={() => void unhide([...selectedIds])}
        />
      )}
      {selectMode && !hiddenView && (
        <GallerySelectBar
          selectedIds={selectedIds}
          selectingAll={selectingAll}
          targetAlbumId={targetAlbumId}
          edits={edits}
        />
      )}
      {(edits.reassignError || edits.bulkTagError) && (
        <div className="space-y-2 border-b border-line bg-surface px-6 py-2">
          <FormMessage error={edits.reassignError} />
          <FormMessage error={edits.bulkTagError} />
        </div>
      )}

      <main className="p-6">
        {loadError && (
          <div className="mb-4 flex items-center gap-3">
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
          />
        ) : (
          <GalleryGrid
            items={items}
            display={display}
            missingDate={query.missingDate}
            selectMode={selectMode}
            selectedIds={selectedIds}
            dragPreviewIds={dragPreviewIds}
            openMenuKey={openMenuKey}
            menuRef={openMenuRef}
            contextMenuAnchor={contextMenuAnchor}
            renderMenu={renderMenu}
            savingDateCaptureId={edits.savingDateCaptureId}
            onOpen={setLightboxIndex}
            onToggleSelect={select.toggle}
            onDragStart={dragProps.onDragSelectStart}
            onDragEnter={dragProps.onDragSelectEnter}
            onToggleMenu={toggleMenu}
            onOpenContextMenu={openContextMenu}
            onRate={hiddenView ? () => {} : rateCapture}
            onSetTakenAt={hiddenView ? () => {} : edits.setTakenAt}
          />
        )}
        {items && nextCursor && (
          <div ref={sentinelRef} className="flex h-16 items-center justify-center gap-3 text-xs text-muted">
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
          onClose={() => setLightboxIndex(null)}
          tagOptions={edits.tagOptions}
        />
      )}

      {edits.addingToAlbumCaptureId && (
        <AddToAlbumModal
          captureIds={[edits.addingToAlbumCaptureId]}
          onClose={() => edits.setAddingToAlbumCaptureId(null)}
        />
      )}

      <GalleryDeleteDialogs
        edits={edits}
        singleKind={items?.find((it) => it.captureId === edits.single.captureId)?.kind}
        selectedCount={selectedIds.size}
        batchNoun={batchNoun}
        selectedHaveRaw={selectedHaveRaw}
        deleteButtonRef={deleteButtonRef}
        batchDeleteButtonRef={batchDeleteButtonRef}
      />
    </div>
  );
}
