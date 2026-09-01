import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import Lightbox, { type LightboxSlide } from "../components/Lightbox";
import { Spinner } from "../components/LoadingScreen";
import BackToCollectionLink from "../components/BackToCollectionLink";
import MasonryGrid from "../components/MasonryGrid";
import ProgressiveImg from "../components/ProgressiveImg";
import SpeciesPicker from "../components/SpeciesPicker";
import StarRating from "../components/StarRating";
import { usePhotoGridSize } from "../hooks/usePhotoGridSize";
import { shotDataLine } from "../lib/shotData";

interface GalleryItem {
  photoId: string;
  width: number | null;
  height: number | null;
  captureId: string;
  speciesId: string;
  scientificName: string;
  commonName: string | null;
  takenAt: string | null;
  cameraModel: string | null;
  lens: string | null;
  focalLengthMm: number | null;
  aperture: number | null;
  shutter: string | null;
  iso: number | null;
  qualityRating: number | null;
  isFeatured: boolean;
  hasRawOriginal: boolean;
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
  const [showCameraInfo, setShowCameraInfo] = useState(false);
  const [showLabels, setShowLabels] = useState(true);
  const [showRatings, setShowRatings] = useState(false);
  // Independent toggles per the ask: a photo can be BOTH 5-star and featured, and each filter
  // combines with the other (AND), same as the existing Labels/Camera-info checkboxes above.
  const [onlyTopRated, setOnlyTopRated] = useState(false);
  const [onlyFeatured, setOnlyFeatured] = useState(false);
  // Hover-revealed "⋯" menu (same pattern as SpeciesDetailPage's own photo-grid menu) —
  // replaces an always-visible star badge, since "is this featured" is already answerable via
  // the Featured filter above rather than needing permanent on-card real estate.
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);
  const [confirmingDeleteKey, setConfirmingDeleteKey] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const openMenuRef = useRef<HTMLDivElement>(null);
  // Multi-select delete — same pattern as SpeciesDetailPage's own select mode: a "Select"
  // toggle, a toolbar showing the count + Delete selected, and one shared confirmation dialog
  // for both the single-photo and batch paths (confirmingDeleteKey covers both: batch delete
  // sets selectedCaptureIds to the full selection and reuses the same modal).
  const [selectMode, setSelectMode] = useState(false);
  const [selectedCaptureIds, setSelectedCaptureIds] = useState<Set<string>>(new Set());
  const [confirmingBatchDelete, setConfirmingBatchDelete] = useState(false);
  const [deleteRawToo, setDeleteRawToo] = useState(false);
  // "Correct the ID" — same reassign-in-place pattern as SpeciesDetailPage: no batch endpoint,
  // just a Promise.allSettled loop over PATCH /captures/:id/reassign per selected photo.
  const [reassigningCaptureId, setReassigningCaptureId] = useState<string | null>(null);
  const [batchReassigning, setBatchReassigning] = useState(false);
  const [reassignError, setReassignError] = useState<string | null>(null);
  useEffect(() => {
    if (!openMenuKey) return;
    const closeIfOutside = (e: MouseEvent) => {
      if (openMenuRef.current && !openMenuRef.current.contains(e.target as Node)) setOpenMenuKey(null);
    };
    document.addEventListener("click", closeIfOutside);
    return () => document.removeEventListener("click", closeIfOutside);
  }, [openMenuKey]);

  function load() {
    const params = new URLSearchParams();
    if (onlyTopRated) params.set("onlyTopRated", "1");
    if (onlyFeatured) params.set("onlyFeatured", "1");
    api.get<{ items: GalleryItem[] }>(`/gallery?${params}`).then((res) => setItems(res.items));
  }

  useEffect(load, [onlyTopRated, onlyFeatured]);

  async function rateCapture(captureId: string, rating: number | null) {
    await api.patch(`/captures/${captureId}/rating`, { rating });
    load();
  }

  async function toggleFeatured(item: GalleryItem) {
    await api.patch(`/species/${item.speciesId}/cover`, { photoId: item.isFeatured ? null : item.photoId });
    load();
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
      })),
    [items],
  );

  return (
    <div className="min-h-screen bg-canvas">
      {/* Top-left, above the title, same as every other page's header. */}
      <header className="page-header flex items-center justify-between border-b border-line bg-surface px-6 py-4">
        <div>
          <BackToCollectionLink className="text-sm text-muted hover:underline" />
          <h1 className="mt-1 text-lg font-semibold text-ink">Gallery</h1>
          {items && <p className="text-xs text-muted">{items.length} photos</p>}
        </div>
        {items && (
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input type="checkbox" checked={onlyTopRated} onChange={(e) => setOnlyTopRated(e.target.checked)} className="accent-ink" />
              Top Rated
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input type="checkbox" checked={onlyFeatured} onChange={(e) => setOnlyFeatured(e.target.checked)} className="accent-ink" />
              Featured
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} className="accent-ink" />
              Labels
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input
                type="checkbox"
                checked={showCameraInfo}
                onChange={(e) => setShowCameraInfo(e.target.checked)}
                className="accent-ink"
              />
              Camera info
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input type="checkbox" checked={showRatings} onChange={(e) => setShowRatings(e.target.checked)} className="accent-ink" />
              Ratings
            </label>
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
        )}
      </header>

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
            {onlyTopRated || onlyFeatured
              ? "No photos match the selected filters."
              : "No photos yet — upload one from a species page to get started."}
          </p>
        ) : (
          <MasonryGrid
            items={items.map((item, i) => ({ item, i }))}
            columnWidth={thumbSizePx}
            keyFor={({ item }) => item.photoId}
            aspectRatioFor={({ item }) => (item.width && item.height ? item.width / item.height : null)}
            renderItem={({ item, i }) => (
              <div key={item.photoId} className="group relative w-full min-w-0">
                <button
                  onClick={() => (selectMode ? toggleSelected(item.captureId) : setLightboxIndex(i))}
                  className="block w-full text-left"
                >
                  <ProgressiveImg
                    thumbSrc={`/api/photos/${item.photoId}/thumb`}
                    fullSrc={`/api/photos/${item.photoId}/display`}
                    alt={item.commonName ?? item.scientificName}
                    className={`block w-full cursor-pointer rounded-md ${
                      selectMode && selectedCaptureIds.has(item.captureId) ? "ring-2 ring-accent ring-offset-2" : ""
                    }`}
                  />
                </button>
                {selectMode && (
                  <input
                    type="checkbox"
                    checked={selectedCaptureIds.has(item.captureId)}
                    onChange={() => toggleSelected(item.captureId)}
                    className="absolute left-2 top-2 h-4 w-4 accent-accent"
                    aria-label="Select photo"
                  />
                )}
                {!selectMode && (
                <div className="absolute right-1 top-1" ref={openMenuKey === item.photoId ? openMenuRef : undefined}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenMenuKey(openMenuKey === item.photoId ? null : item.photoId);
                    }}
                    aria-label="Photo options"
                    className={`rounded-full bg-black/40 px-1.5 py-0.5 text-xs text-white ${
                      openMenuKey === item.photoId ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                    }`}
                  >
                    ⋯
                  </button>
                  {openMenuKey === item.photoId && (
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
                  )}
                </div>
                )}
                {showLabels && <p className="mt-1 truncate text-[11px] text-muted">{item.commonName ?? item.scientificName}</p>}
                {showRatings && (
                  <StarRating rating={item.qualityRating} onRate={(rating) => rateCapture(item.captureId, rating)} />
                )}
                {showCameraInfo && shotDataLine({
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
              </div>
            )}
          />
        )}
      </main>

      {lightboxIndex !== null && (
        <Lightbox slides={slides} index={lightboxIndex} onIndexChange={setLightboxIndex} onClose={() => setLightboxIndex(null)} />
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
