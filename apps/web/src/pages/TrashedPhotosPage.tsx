import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import BackToCollectionLink from "../components/BackToCollectionLink";
import { Spinner } from "../components/LoadingScreen";
import Lightbox, { type LightboxSlide } from "../components/Lightbox";
import MasonryGrid from "../components/MasonryGrid";
import PhotoPlaceholder from "../components/PhotoPlaceholder";
import ProgressiveImg from "../components/ProgressiveImg";

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
  const openMenuRef = useRef<HTMLDivElement>(null);

  function load() {
    api
      .get<TrashResponse>("/trash")
      .then(setData)
      .catch(() => setError("Couldn't load Trash — try again."));
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
      alert("Couldn't restore this photo — try again.");
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
      alert("Couldn't empty Trash — try again.");
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

  const itemsWithPhoto = (data?.items ?? []).filter((it) => it.photoId);
  const slides: LightboxSlide[] = itemsWithPhoto.map((it) => ({
    url: `/api/photos/${it.photoId}/display`,
    caption: it.speciesName,
  }));

  return (
    <div className="min-h-screen bg-canvas">
      <header className="page-header flex items-center justify-between border-b border-line bg-surface px-6 py-4">
        <div>
          <BackToCollectionLink fallbackTo="/settings" label="Settings" className="text-sm text-muted hover:underline" />
          <h1 className="mt-1 text-xl font-semibold text-ink">Trash</h1>
        </div>
        {data && data.items.length > 0 && (
          <div className="flex items-center gap-4">
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
        )}
      </header>

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
              <p className="text-sm text-muted">Trash is empty.</p>
            ) : (
              <MasonryGrid
                items={data.items}
                columnWidth={220}
                keyFor={(item) => item.captureId}
                aspectRatioFor={(item) => (item.width && item.height ? item.width / item.height : null)}
                renderItem={(item) => {
                  const photoIndex = itemsWithPhoto.findIndex((it) => it.captureId === item.captureId);
                  return (
                    <div key={item.captureId} className="group relative w-full min-w-0">
                      {item.photoId ? (
                        <button
                          onClick={() => (selectMode ? toggleSelected(item.captureId) : setLightboxIndex(photoIndex))}
                          className="block w-full text-left"
                        >
                          <ProgressiveImg
                            thumbSrc={`/api/photos/${item.photoId}/thumb`}
                            fullSrc={`/api/photos/${item.photoId}/display`}
                            alt={item.speciesName}
                            className={`block w-full cursor-pointer rounded-md ${
                              selectMode && selectedCaptureIds.has(item.captureId) ? "ring-2 ring-accent ring-offset-2" : ""
                            }`}
                          />
                        </button>
                      ) : (
                        <button
                          onClick={() => selectMode && toggleSelected(item.captureId)}
                          className="block w-full text-left"
                        >
                          <PhotoPlaceholder
                            className={`aspect-square w-full rounded-md ${
                              selectMode && selectedCaptureIds.has(item.captureId) ? "ring-2 ring-accent ring-offset-2" : ""
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
                      <p className="mt-1 truncate text-[11px] text-muted">{item.speciesName}</p>
                      <p className="truncate text-[10px] text-muted">
                        {daysLeft(item.purgesAt)} day{daysLeft(item.purgesAt) === 1 ? "" : "s"} left
                        {item.hasRawOriginal && (item.pendingDeleteRaw ? " · RAW will also be deleted" : " · RAW will be kept")}
                      </p>
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
