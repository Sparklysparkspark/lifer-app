import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import Lightbox, { type LightboxSlide } from "../components/Lightbox";
import { Spinner } from "../components/LoadingScreen";
import PageHeader from "../components/PageHeader";
import MasonryGrid from "../components/MasonryGrid";
import PhotoTile from "../components/PhotoTile";
import AddToAlbumButton from "../components/AddToAlbumButton";
import AddToAlbumModal from "../components/AddToAlbumModal";
import SpeciesPicker from "../components/SpeciesPicker";
import StarRating from "../components/StarRating";
import { usePhotoGridSize } from "../hooks/usePhotoGridSize";
import { useShowLabels } from "../hooks/useShowLabels";
import { shotDataLine, estimateShotDataWrapExtraPx } from "../lib/shotData";
import { ALL_TAXON_CLASSES, TAXON_CLASS_LABEL } from "@lifer/shared";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import Pill from "../components/Pill";
import SearchInput from "../components/SearchInput";
import { downloadFile } from "../lib/downloadFile";

interface GalleryItem {
  photoId: string;
  width: number | null;
  height: number | null;
  captureId: string;
  speciesId: string;
  scientificName: string;
  commonName: string | null;
  taxonClass: string;
  takenAt: string | null;
  cameraModel: string | null;
  lens: string | null;
  focalLengthMm: number | null;
  aperture: number | null;
  shutter: string | null;
  iso: number | null;
  qualityRating: number | null;
  lat: number | null;
  lon: number | null;
  isFeatured: boolean;
  hasRawOriginal: boolean;
  originalRef: string | null;
  originalManaged: boolean | null;
  originalKind: string | null;
}

// Every photo taken, across all species, as one browsable gallery — separate from the
// per-species detail view. Uses the same MasonryGrid (natural aspect ratio, no forced
// square, uneven column endings are fine), the same size slider (the same localStorage key
// as SpeciesDetailPage's own-photo grid — see usePhotoGridSize), and the same thumb->display
// progressive upgrade instead of settling for a permanently low-res thumbnail. There's no
// info toggle inside the lightbox here; instead a "Camera info" toggle on the grid itself
// shows the same shotDataLine caption under each thumbnail that SpeciesDetailPage uses.
export default function GalleryPage() {
  const [items, setItems] = useState<GalleryItem[] | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [thumbSizePx, updateThumbSize] = usePhotoGridSize();
  // At small grid sizes, a fixed 8px gap/6px corner radius eats a much bigger proportion of a
  // tiny thumbnail than a large one — scaling both down with size keeps that proportion roughly
  // constant instead of the chrome visually dominating small thumbnails. Clamped so a huge
  // thumbnail doesn't get an absurdly large gap/radius either.
  const gridGapPx = Math.round(Math.min(8, Math.max(3, thumbSizePx / 30)));
  const gridCornerRadiusPx = Math.round(Math.min(8, Math.max(2, thumbSizePx / 40)));
  const [showCameraInfo, setShowCameraInfo] = useState(false);
  const [showLabels, setShowLabels] = useShowLabels();
  const [showRatings, setShowRatings] = useState(false);
  // Rough per-line height each optional row adds below the photo — MasonryGrid's row-span
  // estimate only ever budgets for the image itself, so without this, turning one of these on
  // pushes every tile taller than its reserved row-span and it overlaps the row below (each
  // number is that row's own text size * a normal line-height, plus its own margin/gap).
  // Camera info is handled separately, below, via extraHeightPxFor — unlike labels/ratings,
  // whether it wraps to a second line varies per photo (a long camera+lens string), so a flat
  // number here would either overlap the photos that wrap or waste space on the ones that don't.
  const CAMERA_INFO_LINE_HEIGHT_PX = 13;
  const extraHeightPx = (showLabels ? 19 : 0) + (showRatings ? 18 : 0) + (showCameraInfo ? CAMERA_INFO_LINE_HEIGHT_PX : 0);
  // Independent toggles per the ask: a photo can be BOTH 5-star and featured, and each filter
  // combines with the other (AND), same as the existing Labels/Camera-info checkboxes above.
  const [onlyTopRated, setOnlyTopRated] = useState(false);
  const [onlyFeatured, setOnlyFeatured] = useState(false);
  // Drill-down from the Stats page's Archive health "Missing date" row (?missingDate=1) — a
  // fixed, URL-driven filter rather than a toggle in the filters panel, since arriving here IS
  // the action (there's no reason to browse into this view any other way). Read once on mount:
  // fixing a date removes that item from `items` locally (see setDate below), so re-deriving
  // this from the URL on every render would just re-show items already fixed this session.
  const [searchParams] = useSearchParams();
  const [missingDate] = useState(() => searchParams.get("missingDate") === "1");
  // Reached from "Add photos" on an album (or right after creating one) with ?select=1 — same
  // Gallery, same real filters, just already in select mode with its own "Add to album" control
  // ready to go, instead of maintaining a separate simplified picker page that would drift out
  // of parity with this one over time.
  const startInSelectMode = searchParams.get("select") === "1";
  const [selectedTaxa, setSelectedTaxa] = useState<Set<string>>(new Set());
  const [includeRaw, setIncludeRaw] = useState(true);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersRef = useRef<HTMLDivElement>(null);
  const activeFilterCount =
    (onlyTopRated ? 1 : 0) + (onlyFeatured ? 1 : 0) + (includeRaw ? 0 : 1) + (selectedTaxa.size > 0 ? 1 : 0);
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState(""); // debounced copy of searchInput actually sent to the server
  const [searching, setSearching] = useState(false);
  const searchAbortRef = useRef<AbortController | null>(null);
  // Hover-revealed "⋯" menu (same pattern as SpeciesDetailPage's own photo-grid menu) —
  // replaces an always-visible star badge, since "is this featured" is already answerable via
  // the Featured filter above rather than needing permanent on-card real estate.
  const { openKey: openMenuKey, setOpenKey: setOpenMenuKey, ref: openMenuRef } = useDropdownMenu<string>();
  const [confirmingDeleteKey, setConfirmingDeleteKey] = useState<string | null>(null);
  const [addingToAlbumCaptureId, setAddingToAlbumCaptureId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Multi-select delete — same pattern as SpeciesDetailPage's own select mode: a "Select"
  // toggle, a toolbar showing the count + Delete selected, and one shared confirmation dialog
  // for both the single-photo and batch paths (confirmingDeleteKey covers both: batch delete
  // sets selectedCaptureIds to the full selection and reuses the same modal).
  const [selectMode, setSelectMode] = useState(startInSelectMode);
  const [selectedCaptureIds, setSelectedCaptureIds] = useState<Set<string>>(new Set());
  const [confirmingBatchDelete, setConfirmingBatchDelete] = useState(false);
  const [deleteRawToo, setDeleteRawToo] = useState(false);
  // "Correct the ID" — same reassign-in-place pattern as SpeciesDetailPage: no batch endpoint,
  // just a Promise.allSettled loop over PATCH /captures/:id/reassign per selected photo.
  const [reassigningCaptureId, setReassigningCaptureId] = useState<string | null>(null);
  const [batchReassigning, setBatchReassigning] = useState(false);
  const [reassignError, setReassignError] = useState<string | null>(null);

  function load() {
    // Cancel whatever search request is still in flight before starting a new one — otherwise a
    // slow older response can resolve AFTER a newer one and overwrite it with stale results.
    searchAbortRef.current?.abort();

    if (searchQuery) {
      const params = new URLSearchParams({ q: searchQuery });
      if (onlyTopRated) params.set("onlyTopRated", "1");
      if (onlyFeatured) params.set("onlyFeatured", "1");
      if (selectedTaxa.size > 0) params.set("taxa", [...selectedTaxa].join(","));
      if (!includeRaw) params.set("includeRaw", "0");
      const controller = new AbortController();
      searchAbortRef.current = controller;
      setSearching(true);
      api
        .get<{ items: GalleryItem[] }>(`/gallery/search?${params}`, { signal: controller.signal })
        .then((res) => setItems(res.items))
        .catch((err) => {
          if (err instanceof Error && err.name === "AbortError") return;
          throw err;
        })
        .finally(() => setSearching(false));
      return;
    }

    const params = new URLSearchParams();
    if (onlyTopRated) params.set("onlyTopRated", "1");
    if (onlyFeatured) params.set("onlyFeatured", "1");
    if (missingDate) params.set("missingDate", "1");
    if (selectedTaxa.size > 0) params.set("taxa", [...selectedTaxa].join(","));
    if (!includeRaw) params.set("includeRaw", "0");
    api.get<{ items: GalleryItem[] }>(`/gallery?${params}`).then((res) => setItems(res.items));
  }

  useEffect(load, [onlyTopRated, onlyFeatured, missingDate, searchQuery, selectedTaxa, includeRaw]);

  const [savingDateCaptureId, setSavingDateCaptureId] = useState<string | null>(null);
  async function setTakenAt(captureId: string, takenAt: string) {
    setSavingDateCaptureId(captureId);
    try {
      await api.patch(`/captures/${captureId}/taken-at`, { takenAt: new Date(takenAt).toISOString() });
      // This view IS the "still missing a date" list — once fixed, the item no longer belongs
      // in it, so drop it locally instead of re-fetching the whole (now one-shorter) list.
      setItems((prev) => prev?.filter((it) => it.captureId !== captureId) ?? prev);
    } finally {
      setSavingDateCaptureId(null);
    }
  }

  useEffect(() => {
    if (!filtersOpen) return;
    const closeIfOutside = (e: MouseEvent) => {
      if (filtersRef.current && !filtersRef.current.contains(e.target as Node)) setFiltersOpen(false);
    };
    document.addEventListener("click", closeIfOutside);
    return () => document.removeEventListener("click", closeIfOutside);
  }, [filtersOpen]);

  // Debounce: only actually fire a search 200ms after the user stops typing, so every keystroke
  // doesn't cost its own CLIP text-encoder inference pass + DB scan.
  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(searchInput.trim()), 200);
    return () => clearTimeout(timer);
  }, [searchInput]);

  async function rateCapture(captureId: string, rating: number | null) {
    await api.patch(`/captures/${captureId}/rating`, { rating });
    load();
  }

  async function toggleFeatured(item: GalleryItem) {
    await api.patch(`/species/${item.speciesId}/cover`, { photoId: item.isFeatured ? null : item.photoId });
    load();
  }

  // Same action/endpoint SpeciesDetailPage's own photo menu already uses — duplicated here for
  // now rather than shared, since these two pages don't yet have a common photo-card component
  // to hang it off of (a real follow-up: extract one, since this is exactly the kind of
  // "recreated in two places" the componentization ask is about).
  async function revealInFinder(path: string) {
    setOpenMenuKey(null);
    await api.post("/originals/reveal", { path }).catch(() => alert("Couldn't reveal that file. It may be unavailable."));
  }

  async function confirmDelete(captureId: string) {
    setDeleting(true);
    try {
      await api.delete(`/captures/${captureId}`);
      setConfirmingDeleteKey(null);
      load();
    } finally {
      setDeleting(false);
    }
  }

  function toggleSelected(captureId: string) {
    setSelectedCaptureIds((prev) => {
      const next = new Set(prev);
      if (next.has(captureId)) next.delete(captureId);
      else next.add(captureId);
      return next;
    });
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelectedCaptureIds(new Set());
  }

  const selectedHaveRaw = (items ?? []).some((it) => selectedCaptureIds.has(it.captureId) && it.hasRawOriginal);

  async function confirmDeleteSelected() {
    setDeleting(true);
    try {
      await api.post("/captures/batch-delete", { captureIds: [...selectedCaptureIds], deleteRaw: deleteRawToo });
      setConfirmingBatchDelete(false);
      setDeleteRawToo(false);
      exitSelectMode();
      load();
    } finally {
      setDeleting(false);
    }
  }

  async function reassignSpecies(captureId: string, newSpeciesId: string) {
    setReassigningCaptureId(null);
    setOpenMenuKey(null);
    setReassignError(null);
    try {
      await api.patch(`/captures/${captureId}/reassign`, { speciesId: newSpeciesId });
      load();
    } catch (err) {
      setReassignError(err instanceof ApiError ? err.message : "Couldn't reassign this photo");
    }
  }

  async function reassignSelected(newSpeciesId: string) {
    setBatchReassigning(true);
    setReassignError(null);
    try {
      const results = await Promise.allSettled(
        [...selectedCaptureIds].map((captureId) => api.patch(`/captures/${captureId}/reassign`, { speciesId: newSpeciesId })),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) setReassignError(`${failed} of ${results.length} photos couldn't be reassigned`);
      exitSelectMode();
      load();
    } finally {
      setBatchReassigning(false);
    }
  }

  const slides = useMemo<LightboxSlide[]>(
    () =>
      (items ?? []).map((i) => ({
        url: `/api/photos/${i.photoId}/display`,
        caption: `${i.commonName ?? i.scientificName}${i.takenAt ? " · " + new Date(i.takenAt).toLocaleDateString() : ""}`,
        info: {
          cameraModel: i.cameraModel,
          lens: i.lens,
          focalLengthMm: i.focalLengthMm,
          aperture: i.aperture,
          shutter: i.shutter,
          iso: i.iso,
          takenAt: i.takenAt,
        },
      })),
    [items],
  );

  return (
    <div className="min-h-screen bg-canvas">
      <PageHeader
        title="Gallery"
        actions={
          items && (
            <div className="flex items-center gap-4">
            <SearchInput
              value={searchInput}
              onChange={setSearchInput}
              placeholder="Search your photos… (e.g. “fox playing”)"
              className="w-96"
              aria-label="Search your photos by what's in them"
            />
            {searching && <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line border-t-accent" aria-label="Searching…" />}

            <div className="relative" ref={filtersRef}>
              <Pill active={activeFilterCount > 0} onClick={() => setFiltersOpen((v) => !v)}>
                Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
              </Pill>
              {filtersOpen && (
                <div className="absolute right-0 top-full z-20 mt-1 w-64 space-y-3 rounded-md border border-line bg-surface p-3 shadow-lg">
                  <div className="space-y-1.5">
                    <label className="flex items-center gap-1.5 text-xs text-ink">
                      <input type="checkbox" checked={onlyTopRated} onChange={(e) => setOnlyTopRated(e.target.checked)} className="accent-ink" />
                      Top Rated
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-ink">
                      <input type="checkbox" checked={onlyFeatured} onChange={(e) => setOnlyFeatured(e.target.checked)} className="accent-ink" />
                      Featured
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-ink">
                      <input type="checkbox" checked={includeRaw} onChange={(e) => setIncludeRaw(e.target.checked)} className="accent-ink" />
                      Include RAW-derived photos
                    </label>
                  </div>

                  <div className="border-t border-line pt-2">
                    <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">Taxon</p>
                    <div className="grid max-h-40 grid-cols-2 gap-x-2 gap-y-1 overflow-y-auto">
                      {ALL_TAXON_CLASSES.map((tc) => (
                        <label key={tc} className="flex items-center gap-1.5 text-xs text-ink">
                          <input
                            type="checkbox"
                            checked={selectedTaxa.has(tc)}
                            onChange={() =>
                              setSelectedTaxa((prev) => {
                                const next = new Set(prev);
                                if (next.has(tc)) next.delete(tc);
                                else next.add(tc);
                                return next;
                              })
                            }
                            className="accent-ink"
                          />
                          {TAXON_CLASS_LABEL[tc]}
                        </label>
                      ))}
                    </div>
                    {selectedTaxa.size > 0 && (
                      <button type="button" onClick={() => setSelectedTaxa(new Set())} className="mt-1 text-[11px] text-muted hover:underline">
                        Clear taxon filter
                      </button>
                    )}
                  </div>

                  <div className="border-t border-line pt-2 space-y-1.5">
                    <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">Display</p>
                    <label className="flex items-center gap-1.5 text-xs text-ink">
                      <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} className="accent-ink" />
                      Labels
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-ink">
                      <input type="checkbox" checked={showCameraInfo} onChange={(e) => setShowCameraInfo(e.target.checked)} className="accent-ink" />
                      Camera info
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-ink">
                      <input type="checkbox" checked={showRatings} onChange={(e) => setShowRatings(e.target.checked)} className="accent-ink" />
                      Ratings
                    </label>
                  </div>
                </div>
              )}
            </div>

            <label className="flex items-center gap-1.5 text-xs text-muted">
              Size
              <input
                type="range"
                min={120}
                max={800}
                step={20}
                value={thumbSizePx}
                onChange={(e) => updateThumbSize(Number(e.target.value))}
                className="w-24 accent-ink"
                aria-label="Photo grid thumbnail size"
              />
            </label>
            {items.length > 0 &&
              (selectMode ? (
                <button onClick={exitSelectMode} className="text-xs text-muted hover:underline">
                  Cancel
                </button>
              ) : (
                <button onClick={() => setSelectMode(true)} className="text-xs text-muted hover:underline">
                  Select
                </button>
              ))}
          </div>
        )
        }
      >
        {items && (
          <p className="text-xs text-muted">
            {missingDate
              ? `${items.length} photo${items.length === 1 ? "" : "s"} missing a date. Pick one below to fix it`
              : `${items.length} photos${searchQuery ? ` matching "${searchQuery}"` : ""}`}
          </p>
        )}
      </PageHeader>

      {selectMode && (
        <div className="flex items-center justify-between gap-3 border-b border-line bg-surface-muted px-6 py-2 text-xs">
          <span className="shrink-0 text-muted">{selectedCaptureIds.size} selected</span>
          {selectedCaptureIds.size > 0 && (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="shrink-0 text-muted">Correct ID to:</span>
              <div className="w-56">
                <SpeciesPicker placeholder="Type a species…" onSelect={(s) => reassignSelected(s.id)} />
              </div>
              {batchReassigning && <span className="shrink-0 text-muted">Reassigning…</span>}
            </div>
          )}
          <AddToAlbumButton captureIds={[...selectedCaptureIds]} />
          <button
            onClick={() => setConfirmingBatchDelete(true)}
            disabled={selectedCaptureIds.size === 0}
            className="shrink-0 rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-40"
          >
            Delete selected
          </button>
        </div>
      )}
      {reassignError && <p className="border-b border-line bg-surface px-6 py-2 text-xs text-red-600">{reassignError}</p>}

      <main className="p-6">
        {!items ? (
          <Spinner />
        ) : items.length === 0 ? (
          <p className="text-muted">
            {missingDate
              ? "Every photo has a date. Nothing to fix here."
              : searchQuery
                ? `No photos match "${searchQuery}".`
                : onlyTopRated || onlyFeatured
                  ? "No photos match the selected filters."
                  : "No photos yet. Upload one from a species page to get started."}
          </p>
        ) : (
          <MasonryGrid
            items={items.map((item, i) => ({ item, i }))}
            columnWidth={thumbSizePx}
            gap={gridGapPx}
            extraHeightPx={extraHeightPx}
            extraHeightPxFor={
              showCameraInfo
                ? ({ item }, columnWidthPx) =>
                    estimateShotDataWrapExtraPx(
                      shotDataLine({
                        camera_model: item.cameraModel,
                        lens: item.lens,
                        focal_length_mm: item.focalLengthMm,
                        aperture: item.aperture,
                        shutter: item.shutter,
                        iso: item.iso,
                      }),
                      columnWidthPx,
                      CAMERA_INFO_LINE_HEIGHT_PX,
                    )
                : undefined
            }
            keyFor={({ item }) => item.photoId}
            aspectRatioFor={({ item }) => (item.width && item.height ? item.width / item.height : null)}
            renderItem={({ item, i }, aspectRatio) => (
              <PhotoTile
                key={item.photoId}
                photoId={item.photoId}
                alt={item.commonName ?? item.scientificName}
                onOpen={() => setLightboxIndex(i)}
                selectMode={selectMode}
                selected={selectedCaptureIds.has(item.captureId)}
                onToggleSelect={() => toggleSelected(item.captureId)}
                aspectRatio={aspectRatio}
                cornerRadiusPx={gridCornerRadiusPx}
                menuOpen={openMenuKey === item.photoId}
                onToggleMenu={() => setOpenMenuKey(openMenuKey === item.photoId ? null : item.photoId)}
                menuRef={openMenuRef}
                menuContent={
                  <div
                    className={`absolute right-0 top-full z-10 mt-1 rounded-md border border-line bg-surface py-1 shadow-lg ${
                      reassigningCaptureId === item.captureId ? "w-56" : "w-44"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFeatured(item);
                        setOpenMenuKey(null);
                      }}
                      className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted"
                    >
                      {item.isFeatured ? "Remove from featured" : "Set as featured"}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setAddingToAlbumCaptureId(item.captureId);
                        setOpenMenuKey(null);
                      }}
                      className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted"
                    >
                      Add to album…
                    </button>
                    {reassigningCaptureId === item.captureId ? (
                      <div className="px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
                        <SpeciesPicker
                          autoFocus
                          placeholder="Correct ID to…"
                          onSelect={(s) => reassignSpecies(item.captureId, s.id)}
                        />
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setReassigningCaptureId(item.captureId);
                        }}
                        className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted"
                      >
                        Correct the ID…
                      </button>
                    )}
                    {item.originalRef && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenMenuKey(null);
                          downloadFile(`/api/photos/${item.photoId}/original?download=1`, "original.jpg");
                        }}
                        className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted"
                      >
                        Download original
                      </button>
                    )}
                    {item.hasRawOriginal && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenMenuKey(null);
                          downloadFile(`/api/photos/${item.photoId}/original-raw?download=1`, "original.raw");
                        }}
                        className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted"
                      >
                        Download RAW
                      </button>
                    )}
                    {item.originalRef && !item.originalManaged && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          revealInFinder(item.originalRef!);
                        }}
                        className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted"
                      >
                        Reveal in Finder
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmingDeleteKey(item.captureId);
                        setOpenMenuKey(null);
                      }}
                      className="block w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-surface-muted"
                    >
                      Delete Photo
                    </button>
                  </div>
                }
                label={
                  <>
                    {showLabels && (
                      <p className="mt-1 truncate text-[11px] text-muted">{item.commonName ?? item.scientificName}</p>
                    )}
                    {showRatings && (
                      <StarRating rating={item.qualityRating} onRate={(rating) => rateCapture(item.captureId, rating)} />
                    )}
                    {showCameraInfo &&
                      shotDataLine({
                        camera_model: item.cameraModel,
                        lens: item.lens,
                        focal_length_mm: item.focalLengthMm,
                        aperture: item.aperture,
                        shutter: item.shutter,
                        iso: item.iso,
                      }) && (
                        <p className="text-[9px] text-muted">
                          {shotDataLine({
                            camera_model: item.cameraModel,
                            lens: item.lens,
                            focal_length_mm: item.focalLengthMm,
                            aperture: item.aperture,
                            shutter: item.shutter,
                            iso: item.iso,
                          })}
                        </p>
                      )}
                    {missingDate && (
                      <input
                        type="date"
                        disabled={savingDateCaptureId === item.captureId}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => e.target.value && setTakenAt(item.captureId, e.target.value)}
                        className="mt-1 w-full rounded border border-line bg-surface px-1.5 py-0.5 text-[11px] text-ink disabled:opacity-50"
                      />
                    )}
                  </>
                }
              />
            )}
          />
        )}
      </main>

      {lightboxIndex !== null && (
        <Lightbox slides={slides} index={lightboxIndex} onIndexChange={setLightboxIndex} onClose={() => setLightboxIndex(null)} />
      )}

      {addingToAlbumCaptureId && (
        <AddToAlbumModal captureIds={[addingToAlbumCaptureId]} onClose={() => setAddingToAlbumCaptureId(null)} />
      )}

      {confirmingDeleteKey && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setConfirmingDeleteKey(null)}
        >
          <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-4 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-medium text-ink">Delete this photo?</h3>
            <p className="mt-2 text-xs text-muted">
              Deleted photos go to Trash for 7 days first, where you can still restore them. After 7 days they're gone
              for good and can't be recovered.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirmingDeleteKey(null)}
                className="rounded-md px-3 py-1.5 text-xs text-muted hover:bg-surface-muted"
              >
                Cancel
              </button>
              <button
                onClick={() => confirmDelete(confirmingDeleteKey)}
                disabled={deleting}
                className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-40"
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmingBatchDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setConfirmingBatchDelete(false)}
        >
          <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-4 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-medium text-ink">
              Delete {selectedCaptureIds.size} photo{selectedCaptureIds.size === 1 ? "" : "s"}?
            </h3>
            <p className="mt-2 text-xs text-muted">
              Deleted photos go to Trash for 7 days first, where you can still restore them. After 7 days they're gone
              for good and can't be recovered.
            </p>
            {selectedHaveRaw && (
              <label className="mt-3 flex items-center gap-2 text-xs text-ink">
                <input type="checkbox" checked={deleteRawToo} onChange={(e) => setDeleteRawToo(e.target.checked)} className="h-3.5 w-3.5" />
                Also delete the matching RAW file when this is permanently removed
              </label>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => {
                  setConfirmingBatchDelete(false);
                  setDeleteRawToo(false);
                }}
                className="rounded-md px-3 py-1.5 text-xs text-muted hover:bg-surface-muted"
              >
                Cancel
              </button>
              <button
                onClick={confirmDeleteSelected}
                disabled={deleting}
                className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-40"
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
