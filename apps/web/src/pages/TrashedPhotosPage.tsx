import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import PageHeader from "../components/PageHeader";
import { Spinner } from "../components/LoadingScreen";
import Lightbox, { type LightboxSlide } from "../components/Lightbox";
import MasonryGrid from "../components/MasonryGrid";
import PhotoPlaceholder from "../components/PhotoPlaceholder";
import ProgressiveImg from "../components/ProgressiveImg";
import SegmentedControl from "../components/SegmentedControl";
import { useShowLabels } from "../hooks/useShowLabels";
import EmptyState from "../components/EmptyState";

interface TrashItem {
  captureId: string;
  speciesId: string;
  speciesName: string;
  deletedAt: string;
  pendingDeleteRaw: boolean;
  photoId: string | null;
  width: number | null;
  height: number | null;
  hasRawOriginal: boolean;
  kind: "image" | "video";
  durationSeconds: number | null;
  originalKind: string | null;
  purgesAt: string;
}

interface TrashResponse {
  retentionDays: number;
  items: TrashItem[];
}

function daysLeft(purgesAt: string): number {
  const ms = new Date(purgesAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

// Same gallery treatment as GalleryPage.tsx (MasonryGrid + ProgressiveImg + Lightbox, select
// mode with a checkbox overlay instead of opening the lightbox while selecting) but scoped to
// trashed photos and stripped of anything that doesn't apply to something already deleted — no
// featured/rating/camera-info toggles, and the per-photo "⋯" menu offers only Restore instead
// of SpeciesDetailPage/GalleryPage's full set.
export default function TrashedPhotosPage() {
  const [data, setData] = useState<TrashResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [emptying, setEmptying] = useState(false);
  const [confirmingEmpty, setConfirmingEmpty] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedCaptureIds, setSelectedCaptureIds] = useState<Set<string>>(new Set());
  const [showLabels, setShowLabels] = useShowLabels();
  const [photoFilter, setPhotoFilter] = useState<"all" | "edited" | "raw" | "video">("all");
  const openMenuRef = useRef<HTMLDivElement>(null);

  function load() {
    api
      .get<TrashResponse>("/trash")
      .then(setData)
      .catch(() => setError("Couldn't load Trash. Try again."));
  }

  useEffect(load, []);

  useEffect(() => {
    if (!openMenuKey) return;
    const closeIfOutside = (e: MouseEvent) => {
      if (openMenuRef.current && !openMenuRef.current.contains(e.target as Node)) setOpenMenuKey(null);
    };
    document.addEventListener("click", closeIfOutside);
    return () => document.removeEventListener("click", closeIfOutside);
  }, [openMenuKey]);

  async function restore(captureId: string) {
    setBusyId(captureId);
    try {
      await api.post(`/trash/${captureId}/restore`, {});
      load();
    } catch {
      alert("Couldn't restore this photo. Try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function restoreSelected() {
    const ids = [...selectedCaptureIds];
    setSelectMode(false);
    setSelectedCaptureIds(new Set());
    await Promise.allSettled(ids.map((id) => api.post(`/trash/${id}/restore`, {})));
    load();
  }

  async function emptyTrash() {
    setEmptying(true);
    try {
      await api.post("/trash/empty", {});
      setConfirmingEmpty(false);
      load();
    } catch {
      alert("Couldn't empty Trash. Try again.");
    } finally {
      setEmptying(false);
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

  const allItems = data?.items ?? [];
  // Same shape as SpeciesDetailPage's own photoFilter — "edited"/"raw" both explicitly exclude
  // videos (neither category applies to one), so a trashed video only ever shows under All/Video.
  const editedCount = allItems.filter((it) => it.photoId && it.kind !== "video" && it.originalKind !== "raw").length;
  const rawOnlyCount = allItems.filter((it) => it.photoId && it.kind !== "video" && it.originalKind === "raw").length;
  const videoCount = allItems.filter((it) => it.kind === "video").length;
  const visibleItems = allItems.filter((it) => {
    if (photoFilter === "all") return true;
    if (photoFilter === "video") return it.kind === "video";
    if (it.kind === "video") return false;
    return photoFilter === "raw" ? it.originalKind === "raw" : it.originalKind !== "raw";
  });
  const itemsWithPhoto = visibleItems.filter((it) => it.photoId);
  const slides: LightboxSlide[] = itemsWithPhoto.map((it) => ({
    url: `/api/photos/${it.photoId}/display`,
    videoUrl: it.kind === "video" ? `/api/photos/${it.photoId}/video` : null,
    caption: it.speciesName,
    info: it.kind === "video" ? { durationSeconds: it.durationSeconds } : null,
  }));

  return (
    <div className="min-h-screen bg-canvas">
      <PageHeader sticky
        title="Trash"
        backFallbackTo="/settings"
        backLabel="Settings"
        actions={
          data &&
          data.items.length > 0 && (
            <div className="flex items-center gap-4">
              {(rawOnlyCount > 0 || videoCount > 0) && (
                <SegmentedControl
                  size="sm"
                  value={photoFilter}
                  onChange={setPhotoFilter}
                  options={[
                    { value: "all", label: `All (${editedCount + rawOnlyCount + videoCount})` },
                    { value: "edited", label: `Edited (${editedCount})` },
                    ...(rawOnlyCount > 0 ? [{ value: "raw" as const, label: `RAW (${rawOnlyCount})` }] : []),
                    ...(videoCount > 0 ? [{ value: "video" as const, label: `Video (${videoCount})` }] : []),
                  ]}
                />
              )}
              <label className="flex items-center gap-1.5 text-xs text-muted">
                <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} />
                Labels
              </label>
              {selectMode ? (
                <button
                  onClick={() => {
                    setSelectMode(false);
                    setSelectedCaptureIds(new Set());
                  }}
                  className="text-xs text-muted hover:underline"
                >
                  Cancel
                </button>
              ) : (
                <button onClick={() => setSelectMode(true)} className="text-xs text-muted hover:underline">
                  Select
                </button>
              )}
              <button
                onClick={() => setConfirmingEmpty(true)}
                className="rounded-md border border-red-600 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
              >
                Empty Trash
              </button>
            </div>
          )
        }
      />

      {selectMode && (
        <div className="flex items-center justify-between border-b border-line bg-surface-muted px-6 py-2 text-xs">
          <span className="text-muted">{selectedCaptureIds.size} selected</span>
          <button
            onClick={restoreSelected}
            disabled={selectedCaptureIds.size === 0}
            className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-accent-fg hover:opacity-90 disabled:opacity-40"
          >
            Restore selected
          </button>
        </div>
      )}

      <main className="p-6">
        {error && <p className="text-sm text-red-600">{error}</p>}
        {!data && !error && <Spinner />}
        {data && (
          <>
            <p className="mb-4 text-sm text-muted">
              Deleted photos stay here for {data.retentionDays} days, then are permanently removed. You can restore any
              of them before then.
            </p>
            {data.items.length === 0 ? (
              <EmptyState
                icon={
                  <svg viewBox="0 0 24 24" className="h-6 w-6 text-muted" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6" />
                    <path d="M10 11v6M14 11v6" />
                  </svg>
                }
                title="Trash is empty"
                description="Deleted photos show up here for a while before they're gone for good."
              />
            ) : visibleItems.length === 0 ? (
              <p className="text-sm text-muted">Nothing matches this filter.</p>
            ) : (
              <MasonryGrid
                items={visibleItems}
                columnWidth={220}
                extraHeightPx={showLabels ? 32 : 0}
                keyFor={(item) => item.captureId}
                aspectRatioFor={(item) => (item.width && item.height ? item.width / item.height : null)}
                renderItem={(item, aspectRatio) => {
                  const photoIndex = itemsWithPhoto.findIndex((it) => it.captureId === item.captureId);
                  return (
                    <div key={item.captureId} className="group relative w-full min-w-0">
                      {item.photoId ? (
                        <button
                          onClick={() => (selectMode ? toggleSelected(item.captureId) : setLightboxIndex(photoIndex))}
                          className="relative block w-full overflow-hidden text-left"
                          style={{ aspectRatio }}
                        >
                          <ProgressiveImg
                            thumbSrc={`/api/photos/${item.photoId}/thumb`}
                            fullSrc={`/api/photos/${item.photoId}/display`}
                            alt={item.speciesName}
                            className={`block h-full w-full cursor-pointer rounded-md object-cover ${
                              selectMode && selectedCaptureIds.has(item.captureId) ? "ring-2 ring-inset ring-blue-500" : ""
                            }`}
                          />
                          {item.kind === "video" && (
                            <div className="pointer-events-none absolute bottom-2 right-2 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white">
                              <span aria-hidden>▶</span>
                              {item.durationSeconds != null && (
                                <span>
                                  {Math.floor(item.durationSeconds / 60)}:
                                  {String(Math.round(item.durationSeconds % 60)).padStart(2, "0")}
                                </span>
                              )}
                            </div>
                          )}
                        </button>
                      ) : (
                        <button
                          onClick={() => selectMode && toggleSelected(item.captureId)}
                          className="block w-full text-left"
                        >
                          <PhotoPlaceholder
                            className={`aspect-square w-full rounded-md ${
                              selectMode && selectedCaptureIds.has(item.captureId) ? "ring-2 ring-inset ring-blue-500" : ""
                            }`}
                          />
                        </button>
                      )}
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
                        <div
                          className="absolute right-1 top-1"
                          ref={openMenuKey === item.captureId ? openMenuRef : undefined}
                        >
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpenMenuKey(openMenuKey === item.captureId ? null : item.captureId);
                            }}
                            aria-label="Photo options"
                            className={`rounded-full bg-black/40 px-1.5 py-0.5 text-xs text-white ${
                              openMenuKey === item.captureId ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                            }`}
                          >
                            ⋯
                          </button>
                          {openMenuKey === item.captureId && (
                            <div className="absolute right-0 top-full z-10 mt-1 w-36 rounded-md border border-line bg-surface py-1 shadow-lg">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setOpenMenuKey(null);
                                  restore(item.captureId);
                                }}
                                disabled={busyId === item.captureId}
                                className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted disabled:opacity-50"
                              >
                                {busyId === item.captureId ? "Restoring…" : "Restore"}
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                      {showLabels && (
                        <>
                          <p className="mt-1 truncate text-[11px] text-muted">{item.speciesName}</p>
                          <p className="truncate text-[10px] text-muted">
                            {daysLeft(item.purgesAt)} day{daysLeft(item.purgesAt) === 1 ? "" : "s"} left
                            {item.hasRawOriginal && (item.pendingDeleteRaw ? " · RAW will also be deleted" : " · RAW will be kept")}
                          </p>
                        </>
                      )}
                    </div>
                  );
                }}
              />
            )}
          </>
        )}
      </main>

      {lightboxIndex !== null && (
        <Lightbox slides={slides} index={lightboxIndex} onIndexChange={setLightboxIndex} onClose={() => setLightboxIndex(null)} />
      )}

      {confirmingEmpty && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setConfirmingEmpty(false)}>
          <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-4 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-medium text-ink">Empty Trash?</h3>
            <p className="mt-2 text-xs text-muted">
              This permanently removes everything in Trash right now, even photos that haven't reached their 7-day
              limit yet. This can't be undone.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setConfirmingEmpty(false)} className="rounded-md px-3 py-1.5 text-xs text-muted hover:bg-surface-muted">
                Cancel
              </button>
              <button
                onClick={emptyTrash}
                disabled={emptying}
                className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-40"
              >
                {emptying ? "Emptying…" : "Empty Trash"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
