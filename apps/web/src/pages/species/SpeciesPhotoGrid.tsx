import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { api, ApiError } from "../../api/client";
import EmptyState from "../../components/EmptyState";
import StarRating from "../../components/StarRating";
import Lightbox, { photoFilePaths, TagEditor, type LightboxSlide } from "../../components/Lightbox";
import SpeciesPicker from "../../components/SpeciesPicker";
import RegionBrowser from "../../components/RegionBrowser";
import PhotoTile from "../../components/PhotoTile";
import AddToAlbumModal from "../../components/AddToAlbumModal";
import SegmentedControl from "../../components/SegmentedControl";
import SelectModeToggle from "../../components/SelectModeToggle";
import Select from "../../components/Select";
import MasonryGrid from "../../components/MasonryGrid";
import Modal from "../../components/Modal";
import Button from "../../components/Button";
import InlineSpinner from "../../components/InlineSpinner";
import FormMessage from "../../components/FormMessage";
import { usePhotoGridSize } from "../../hooks/usePhotoGridSize";
import { useDropdownMenu } from "../../hooks/useDropdownMenu";
import { useSelectMode } from "../../hooks/useSelectMode";
import { useDeploymentMode, useIsTauri } from "../../hooks/useDeploymentMode";
import { useToast } from "../../hooks/useToast";
import { shotDataLine, estimateShotDataWrapExtraPx } from "../../lib/shotData";
import { downloadFile } from "../../lib/downloadFile";
import { formatDate } from "../../lib/formatDate";
import { pluralize } from "../../lib/pluralize";
import { filterBucketFor, fullSizeUrl, type PhotoFilter, type SpeciesCapture, type SpeciesDetail } from "./types";

// Same one-line caption budget GalleryPage uses; wrapped lines are added per item.
const CAMERA_INFO_LINE_HEIGHT_PX = 13;
const MENU_ITEM = "block w-full px-3 py-1.5 text-left text-ink hover:bg-surface-muted";

type PhotoSort = "newest" | "oldest" | "rating";
type GridItem =
  | { kind: "capture"; c: SpeciesCapture; i: number; line: string | null }
  | { kind: "placeholder"; key: string };

function takenTime(c: SpeciesCapture): number {
  return c.taken_at ? new Date(c.taken_at).getTime() : 0;
}

function matchesFilter(c: SpeciesCapture, filter: PhotoFilter): boolean {
  return filter === "all" || filterBucketFor(c) === filter;
}

function locationText(c: SpeciesCapture): string | null {
  if (c.location_label && c.region_name) return `${c.location_label}, ${c.region_name}`;
  return c.location_label ?? c.region_name;
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export default function SpeciesPhotoGrid({
  detail,
  pendingUploadCount,
  load,
  updateCaptures,
  galleryView,
  onToggleGalleryView,
  onUpload,
}: {
  detail: SpeciesDetail;
  pendingUploadCount: number;
  load: () => void;
  updateCaptures: (ids: Iterable<string>, patch: (c: SpeciesCapture) => Partial<SpeciesCapture>) => void;
  galleryView: boolean;
  onToggleGalleryView: () => void;
  onUpload: () => void;
}) {
  const toast = useToast();
  const { species, captures, userSpecies } = detail;
  const speciesId = species.id;
  const { openKey: openMenuCaptureId, setOpenKey: setOpenMenuCaptureId, ref: openMenuRef } = useDropdownMenu<string>();
  const [thumbSizePx, updateThumbSize] = usePhotoGridSize();
  const [photoFilter, setPhotoFilter] = useState<PhotoFilter>("edited");
  // "newest" matches the server's own order, so it's a no-op sort.
  const [photoSort, setPhotoSort] = useState<PhotoSort>("newest");
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [addingToAlbumCaptureId, setAddingToAlbumCaptureId] = useState<string | null>(null);
  const [tagOptions, setTagOptions] = useState<string[]>([]);
  const [bulkTags, setBulkTags] = useState<string[]>([]);
  const [batchReassigning, setBatchReassigning] = useState(false);
  const [reassignError, setReassignError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteRawToo, setDeleteRawToo] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  // Reveal runs on the API's machine, so it only makes sense for the desktop app's own local API.
  const isTauri = useIsTauri();
  const deploymentMode = useDeploymentMode();
  const canRevealInFinder = isTauri && deploymentMode === "desktop";

  useEffect(() => {
    const controller = new AbortController();
    api
      .get<{ tags: string[] }>("/captures/tags", { signal: controller.signal })
      .then((res) => setTagOptions(res.tags))
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const addTagOptions = useCallback((tags: string[]) => {
    setTagOptions((prev) => [...new Set([...prev, ...tags])].sort());
  }, []);

  const sortedCaptures = useMemo(() => {
    if (photoSort === "newest") return captures;
    return [...captures].sort((a, b) =>
      // Unrated sinks below a genuine 1-star rather than counting as 0.
      photoSort === "oldest" ? takenTime(a) - takenTime(b) : (b.quality_rating ?? -1) - (a.quality_rating ?? -1),
    );
  }, [captures, photoSort]);

  // The lightbox browses every kind regardless of the grid's filter; the grid shows the filtered subset.
  const photoCaptures = useMemo(() => sortedCaptures.filter((c) => c.photo_id), [sortedCaptures]);
  const slideIndexById = useMemo(() => new Map(photoCaptures.map((c, i) => [c.id, i])), [photoCaptures]);
  const visibleCaptures = useMemo(() => photoCaptures.filter((c) => matchesFilter(c, photoFilter)), [photoCaptures, photoFilter]);

  const {
    selectMode,
    setSelectMode,
    selectedIds,
    setSelectedIds,
    toggle,
    clear: clearSelection,
    exit: exitSelect,
    dragPreviewIds,
    dragProps,
  } = useSelectMode(visibleCaptures, (c) => c.id);

  const exitSelectMode = useCallback(() => {
    exitSelect();
    setBulkTags([]);
  }, [exitSelect]);

  const counts = useMemo(() => {
    let edited = 0;
    let raw = 0;
    let video = 0;
    for (const c of captures) {
      if (c.photo_kind === "video") video++;
      else if (!c.photo_id) continue;
      else if (c.original_kind === "raw") raw++;
      else edited++;
    }
    return { edited, raw, video };
  }, [captures]);
  const hasPhotos = counts.edited + counts.raw > 0;
  const hasVideos = counts.video > 0;
  const photosSectionTitle =
    photoFilter === "video"
      ? "Your videos"
      : photoFilter !== "all"
        ? "Your photos"
        : hasPhotos && hasVideos
          ? "Your photos and videos"
          : hasVideos
            ? "Your videos"
            : "Your photos";

  const rateCapture = useCallback(
    async (captureId: string, rating: number | null) => {
      updateCaptures([captureId], () => ({ quality_rating: rating }));
      try {
        await api.patch(`/captures/${captureId}/rating`, { rating });
      } catch (err) {
        toast.error(errorText(err, "Couldn't save the rating"));
      }
      // Refreshes the server-computed "best shot", or undoes the optimistic rating on failure.
      load();
    },
    [updateCaptures, toast, load],
  );

  const tagCapture = useCallback(
    async (captureId: string, tags: string[]) => {
      addTagOptions(tags);
      updateCaptures([captureId], () => ({ tags }));
      try {
        await api.patch(`/captures/${captureId}/tags`, { tags });
      } catch (err) {
        toast.error(errorText(err, "Couldn't save the tags"));
        load();
      }
    },
    [addTagOptions, updateCaptures, toast, load],
  );

  const setCaptureRegion = useCallback(
    async (captureId: string, regionId: string | null) => {
      updateCaptures([captureId], () => ({ region_id: regionId }));
      try {
        await api.patch(`/captures/${captureId}/region`, { regionId });
      } catch (err) {
        toast.error(errorText(err, "Couldn't save the location"));
        load();
      }
    },
    [updateCaptures, toast, load],
  );

  const setCaptureLocationLabel = useCallback(
    async (captureId: string, locationLabel: string) => {
      updateCaptures([captureId], () => ({ location_label: locationLabel.trim() || null }));
      try {
        await api.patch(`/captures/${captureId}/region`, { locationLabel });
      } catch (err) {
        toast.error(errorText(err, "Couldn't save the place name"));
        load();
      }
    },
    [updateCaptures, toast, load],
  );

  async function setCover(photoId: string) {
    setOpenMenuCaptureId(null);
    try {
      await api.patch(`/species/${speciesId}/cover`, { photoId });
      load();
    } catch (err) {
      toast.error(errorText(err, "Couldn't set the featured photo"));
    }
  }

  async function revealInFinder(path: string) {
    setOpenMenuCaptureId(null);
    try {
      await api.post("/originals/reveal", { path });
    } catch {
      toast.error("Couldn't reveal that file. It may be unavailable.");
    }
  }

  async function copyPath(path: string) {
    setOpenMenuCaptureId(null);
    try {
      await navigator.clipboard.writeText(path);
      toast.success("Path copied");
    } catch {
      toast.error("Couldn't copy the path");
    }
  }

  // Marks a photo as also containing another species; it then shows on that species' page too.
  async function tagSpecies(captureId: string, otherSpeciesId: string) {
    setOpenMenuCaptureId(null);
    try {
      await api.post(`/captures/${captureId}/species`, { speciesId: otherSpeciesId });
      load();
    } catch (err) {
      toast.error(errorText(err, "Couldn't tag that species"));
    }
  }

  async function reassignSpecies(captureId: string, newSpeciesId: string) {
    setOpenMenuCaptureId(null);
    setReassignError(null);
    try {
      await api.patch(`/captures/${captureId}/reassign`, { speciesId: newSpeciesId });
      load();
    } catch (err) {
      setReassignError(errorText(err, "Couldn't reassign this photo"));
    }
  }

  // No batch endpoint: reassignment batches are small and interactive.
  async function reassignSelected(newSpeciesId: string) {
    setBatchReassigning(true);
    setReassignError(null);
    try {
      const results = await Promise.allSettled(
        [...selectedIds].map((captureId) => api.patch(`/captures/${captureId}/reassign`, { speciesId: newSpeciesId })),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) setReassignError(`${failed} of ${pluralize(results.length, "photo")} couldn't be reassigned`);
      exitSelectMode();
      load();
    } finally {
      setBatchReassigning(false);
    }
  }

  async function addBulkTags(tags: string[]) {
    const added = tags.filter((t) => !bulkTags.includes(t));
    setBulkTags(tags);
    if (added.length === 0) return;
    const ids = [...selectedIds];
    try {
      await api.patch("/captures/tags", { captureIds: ids, tags: added });
      addTagOptions(added);
      updateCaptures(ids, (c) => ({ tags: [...new Set([...c.tags, ...added])] }));
    } catch (err) {
      toast.error(errorText(err, "Couldn't add the tag"));
    }
  }

  // Single-photo delete shares the batch dialog so the trash wording lives in one place.
  function requestDeleteCapture(captureId: string) {
    setOpenMenuCaptureId(null);
    setSelectedIds(new Set([captureId]));
    setConfirmingDelete(true);
  }

  function cancelDelete() {
    setConfirmingDelete(false);
    setDeleteRawToo(false);
    if (!selectMode) clearSelection();
  }

  async function confirmDeleteSelected() {
    if (deleting) return;
    setDeleting(true);
    try {
      await api.post("/captures/batch-delete", { captureIds: [...selectedIds], deleteRaw: deleteRawToo });
      setConfirmingDelete(false);
      setDeleteRawToo(false);
      exitSelectMode();
      load();
    } catch (err) {
      toast.error(errorText(err, "Couldn't delete. Try again."));
    } finally {
      setDeleting(false);
    }
  }

  function onDeleteDialogKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Enter" || e.nativeEvent.isComposing || e.defaultPrevented) return;
    if ((e.target as HTMLElement).tagName === "BUTTON") return;
    e.preventDefault();
    void confirmDeleteSelected();
  }

  const selectedCaptures = captures.filter((c) => selectedIds.has(c.id));
  const selectedHaveRaw = selectedCaptures.some((c) => c.has_raw_original);
  const deleteNoun = (() => {
    const hasVideo = selectedCaptures.some((c) => c.photo_kind === "video");
    const hasPhoto = selectedCaptures.some((c) => c.photo_kind !== "video");
    return hasVideo && hasPhoto ? "file" : hasVideo ? "video" : "photo";
  })();

  const captureSlides = useMemo<LightboxSlide[]>(
    () =>
      photoCaptures.map((c) => ({
        url: fullSizeUrl(c)!,
        videoUrl: c.photo_kind === "video" ? `/api/photos/${c.photo_id}/video` : null,
        caption: c.taken_at ? formatDate(c.taken_at) : null,
        tags: c.tags,
        onTagsChange: (tags: string[]) => void tagCapture(c.id, tags),
        info: {
          cameraModel: c.camera_model,
          lens: c.lens,
          focalLengthMm: c.focal_length_mm,
          aperture: c.aperture,
          shutter: c.shutter,
          iso: c.iso,
          takenAt: c.taken_at,
          durationSeconds: c.duration_seconds,
          files: photoFilePaths(c.original_ref, c.raw_ref),
        },
      })),
    [photoCaptures, tagCapture],
  );

  const gridItems = useMemo<GridItem[]>(
    () => [
      ...visibleCaptures.map((c, i) => ({ kind: "capture" as const, c, i, line: shotDataLine(c) })),
      // Placeholder tiles for uploads in flight, right where the new photo will land.
      ...Array.from({ length: pendingUploadCount }, (_, idx) => ({ kind: "placeholder" as const, key: `pending-${idx}` })),
    ],
    [visibleCaptures, pendingUploadCount],
  );

  function closeLightbox() {
    // If you arrowed onto a capture the current filter hides, switch the filter so it's visible.
    const current = lightboxIndex == null ? undefined : photoCaptures[lightboxIndex];
    if (current && !matchesFilter(current, photoFilter)) setPhotoFilter(filterBucketFor(current));
    setLightboxIndex(null);
  }

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-4">
        <h2 className="text-sm font-medium text-ink">{photosSectionTitle}</h2>
        <div className="flex items-center gap-4">
          {captures.length > 0 && (
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
          )}
          <button
            onClick={onToggleGalleryView}
            className={`text-xs hover:underline ${galleryView ? "font-medium text-ink" : "text-muted"}`}
            title="Hide rarity, rating, and camera info: just the photos"
          >
            {galleryView ? "Gallery view ✓" : "Gallery view"}
          </button>
          {captures.length > 1 && (
            <Select label="Sort" value={photoSort} onChange={(e) => setPhotoSort(e.target.value as PhotoSort)}>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="rating">Highest rated first</option>
            </Select>
          )}
          {(counts.raw > 0 || counts.video > 0) && (
            <SegmentedControl
              size="sm"
              value={photoFilter}
              onChange={setPhotoFilter}
              options={[
                { value: "all", label: `All (${counts.edited + counts.raw + counts.video})` },
                { value: "edited", label: `Edited (${counts.edited})` },
                ...(counts.raw > 0 ? [{ value: "raw" as const, label: `RAW (${counts.raw})` }] : []),
                ...(counts.video > 0 ? [{ value: "video" as const, label: `Video (${counts.video})` }] : []),
              ]}
            />
          )}
          {captures.length > 0 && <SelectModeToggle active={selectMode} onEnter={() => setSelectMode(true)} onExit={exitSelectMode} />}
          <Button size="sm" onClick={onUpload}>
            Upload
          </Button>
        </div>
      </div>

      {selectMode && (
        <div className="mb-2 flex items-center justify-between gap-3 rounded-md border border-line bg-surface-muted px-3 py-2 text-xs">
          <span className="shrink-0 text-muted">{selectedIds.size} selected</span>
          {selectedIds.size > 0 && (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="shrink-0 text-muted">Correct ID to:</span>
              <div className="w-56">
                <SpeciesPicker placeholder="Type a species…" onSelect={(s) => reassignSelected(s.id)} />
              </div>
              {batchReassigning && <span className="shrink-0 text-muted">Reassigning…</span>}
              <span className="shrink-0 text-muted">Add tag:</span>
              <div className="w-48">
                <TagEditor tags={bulkTags} existingTags={tagOptions} compact onChange={(tags) => void addBulkTags(tags)} />
              </div>
              {bulkTags.length > 0 && (
                <Button size="sm" className="shrink-0" onClick={exitSelectMode}>
                  Done
                </Button>
              )}
            </div>
          )}
          <Button variant="danger" size="sm" className="shrink-0" onClick={() => setConfirmingDelete(true)} disabled={selectedIds.size === 0}>
            Delete selected
          </Button>
        </div>
      )}
      <FormMessage error={reassignError} className="mb-2" />

      <Modal
        open={confirmingDelete}
        onClose={cancelDelete}
        title={`Delete ${pluralize(selectedIds.size, deleteNoun)}?`}
        onKeyDown={onDeleteDialogKeyDown}
        initialFocusRef={deleteButtonRef}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={cancelDelete} disabled={deleting}>
              Cancel
            </Button>
            <Button ref={deleteButtonRef} variant="danger" size="sm" onClick={() => void confirmDeleteSelected()} loading={deleting}>
              Delete
            </Button>
          </>
        }
      >
        <p className="text-xs text-muted">
          Deleted photos go to Trash for 7 days first, where you can still restore them. After 7 days they're gone for good
          and can't be recovered.
        </p>
        {selectedHaveRaw && (
          <label className="mt-3 flex items-center gap-2 text-xs text-ink">
            <input type="checkbox" checked={deleteRawToo} onChange={(e) => setDeleteRawToo(e.target.checked)} className="h-3.5 w-3.5" />
            Also delete the matching RAW file when this is permanently removed
          </label>
        )}
      </Modal>

      {captures.length === 0 && pendingUploadCount === 0 ? (
        <EmptyState
          icon={
            <svg viewBox="0 0 24 24" className="h-6 w-6 text-muted" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <circle cx="9" cy="11" r="2" />
              <path d="m21 16-4.5-4.5L9 19" />
            </svg>
          }
          title="Not photographed yet"
          description="Upload a photo below to add this species to your collection."
        />
      ) : (
        <MasonryGrid
          items={gridItems}
          columnWidth={thumbSizePx}
          // Gallery view shows only absolutely positioned overlays, which add no height.
          extraHeightPx={galleryView ? 0 : 19 + 18 + CAMERA_INFO_LINE_HEIGHT_PX}
          extraHeightPxFor={
            galleryView
              ? undefined
              : (item, columnWidthPx) =>
                  item.kind === "capture" ? estimateShotDataWrapExtraPx(item.line, columnWidthPx, CAMERA_INFO_LINE_HEIGHT_PX) : 0
          }
          keyFor={(item) => (item.kind === "placeholder" ? item.key : item.c.id)}
          // 3:2 stands in for an ordinary landscape photo until the upload reports real dimensions.
          aspectRatioFor={(item) => (item.kind === "capture" && item.c.width && item.c.height ? item.c.width / item.c.height : 3 / 2)}
          renderItem={(item, aspectRatio) => {
            if (item.kind === "placeholder") {
              return (
                <div key={item.key} style={{ aspectRatio: aspectRatio ?? 3 / 2 }} className="flex w-full items-center justify-center rounded-md bg-surface-muted">
                  <InlineSpinner size="md" tone="ink" label="Uploading" />
                </div>
              );
            }
            const { c, i, line } = item;
            const menuOpen = openMenuCaptureId === c.id;
            const location = locationText(c);
            return (
              <PhotoTile
                key={c.id}
                photoId={c.photo_id!}
                alt=""
                kind={c.photo_kind === "video" ? "video" : "image"}
                durationSeconds={c.duration_seconds}
                onOpen={() => setLightboxIndex(slideIndexById.get(c.id) ?? 0)}
                selectMode={selectMode}
                selected={selectedIds.has(c.id) || (dragPreviewIds?.has(c.id) ?? false)}
                onToggleSelect={(shiftKey) => toggle(c.id, i, shiftKey)}
                onDragSelectStart={() => dragProps.onDragSelectStart(i)}
                onDragSelectEnter={() => dragProps.onDragSelectEnter(i)}
                aspectRatio={aspectRatio}
                menuOpen={menuOpen}
                onToggleMenu={() => setOpenMenuCaptureId(menuOpen ? null : c.id)}
                menuRef={openMenuRef}
                menuContent={
                  menuOpen ? (
                    <CaptureMenu
                      capture={c}
                      isCover={userSpecies?.cover_photo_id === c.photo_id}
                      canRevealInFinder={canRevealInFinder}
                      tagOptions={tagOptions}
                      onClose={() => setOpenMenuCaptureId(null)}
                      onRate={(rating) => void rateCapture(c.id, rating)}
                      onSetCover={() => void setCover(c.photo_id!)}
                      onAddToAlbum={() => {
                        setAddingToAlbumCaptureId(c.id);
                        setOpenMenuCaptureId(null);
                      }}
                      onReveal={() => void revealInFinder(c.original_ref!)}
                      onCopyPath={() => void copyPath(c.original_ref!)}
                      onTagSpecies={(otherId) => void tagSpecies(c.id, otherId)}
                      onReassign={(newId) => void reassignSpecies(c.id, newId)}
                      onSetRegion={(regionId) => void setCaptureRegion(c.id, regionId)}
                      onSetLocationLabel={(label) => void setCaptureLocationLabel(c.id, label)}
                      // Region names come from the server, so refresh once when the menu closes.
                      onLocationSettled={load}
                      onTagsChange={(tags) => void tagCapture(c.id, tags)}
                      onDelete={() => requestDeleteCapture(c.id)}
                    />
                  ) : null
                }
                label={
                  <>
                    {!galleryView && userSpecies?.best_quality != null && c.quality_rating === userSpecies.best_quality && (
                      <span className="absolute left-1 top-1 rounded-full bg-black/40 px-1.5 py-0.5 text-[9px] text-white">Best shot</span>
                    )}
                    {/* The explanation lives in the menu; the tile only gets a dot. */}
                    {c.original_available === false && (
                      <span
                        className="absolute bottom-1.5 left-1.5 h-2.5 w-2.5 rounded-full bg-red-600 shadow"
                        title={
                          c.original_volume_label
                            ? `Original unavailable. Connect "${c.original_volume_label}" to view it`
                            : "Original unavailable. The file couldn't be found at its saved location"
                        }
                      />
                    )}
                    {!galleryView && (
                      <div className="mt-1">
                        <StarRating rating={c.quality_rating} onRate={(rating) => void rateCapture(c.id, rating)} />
                      </div>
                    )}
                    {!galleryView && c.taken_at && <p className="mt-0.5 text-[10px] text-muted">{formatDate(c.taken_at)}</p>}
                    {!galleryView && line && <p className="text-[9px] text-muted">{line}</p>}
                    {!galleryView && location && <p className="truncate text-[9px] text-muted">{location}</p>}
                  </>
                }
              />
            );
          }}
        />
      )}

      {lightboxIndex != null && captureSlides.length > 0 && (
        <Lightbox
          slides={captureSlides}
          index={Math.min(lightboxIndex, captureSlides.length - 1)}
          onIndexChange={setLightboxIndex}
          onClose={closeLightbox}
          tagOptions={tagOptions}
        />
      )}

      {addingToAlbumCaptureId && <AddToAlbumModal captureIds={[addingToAlbumCaptureId]} onClose={() => setAddingToAlbumCaptureId(null)} />}
    </section>
  );
}

// Mounted only for the tile whose menu is open, so its sub-editor state resets on close.
function CaptureMenu({
  capture: c,
  isCover,
  canRevealInFinder,
  tagOptions,
  onClose,
  onRate,
  onSetCover,
  onAddToAlbum,
  onReveal,
  onCopyPath,
  onTagSpecies,
  onReassign,
  onSetRegion,
  onSetLocationLabel,
  onLocationSettled,
  onTagsChange,
  onDelete,
}: {
  capture: SpeciesCapture;
  isCover: boolean;
  canRevealInFinder: boolean;
  tagOptions: string[];
  onClose: () => void;
  onRate: (rating: number | null) => void;
  onSetCover: () => void;
  onAddToAlbum: () => void;
  onReveal: () => void;
  onCopyPath: () => void;
  onTagSpecies: (speciesId: string) => void;
  onReassign: (speciesId: string) => void;
  onSetRegion: (regionId: string | null) => void;
  onSetLocationLabel: (label: string) => void;
  onLocationSettled: () => void;
  onTagsChange: (tags: string[]) => void;
  onDelete: () => void;
}) {
  const [editor, setEditor] = useState<"tagSpecies" | "reassign" | "location" | "tags" | null>(null);
  const regionChanged = useRef(false);
  const settle = useRef(onLocationSettled);
  settle.current = onLocationSettled;
  useEffect(
    () => () => {
      if (regionChanged.current) settle.current();
    },
    [],
  );

  // stopPropagation: the button swaps itself for its editor before the click bubbles, and
  // useDropdownMenu's outside-click check then sees a detached node and closes the menu.
  function openEditor(e: MouseEvent, which: NonNullable<typeof editor>) {
    e.stopPropagation();
    setEditor(which);
  }

  const location = locationText(c);

  return (
    <div className="absolute right-0 top-full z-10 mt-1 max-h-[70vh] w-64 overflow-y-auto overflow-x-hidden rounded-md border border-line bg-surface py-1 text-xs shadow-lg">
      {/* Stays open on click so a rating can be nudged without reopening the menu. */}
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5">
        <span className="text-muted">Rate</span>
        <StarRating rating={c.quality_rating} onRate={onRate} />
      </div>
      <button onClick={onSetCover} className={MENU_ITEM}>
        {isCover ? "Featured photo ✓" : "Set as featured photo"}
      </button>
      <button onClick={onAddToAlbum} className={MENU_ITEM}>
        Add to album…
      </button>
      {c.original_ref && c.original_available === false ? (
        <p className="w-full px-3 py-1.5 text-left text-muted">
          {c.original_volume_label ? `Connect "${c.original_volume_label}" to view this original` : "Original unavailable"}
        </p>
      ) : (
        c.original_ref && (
          <>
            {/* A RAW-only original is already covered by "Download RAW". */}
            {c.original_kind !== "raw" && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClose();
                  downloadFile(`/api/photos/${c.photo_id}/original?download=1`, "original.jpg");
                }}
                className={MENU_ITEM}
              >
                Download original
              </button>
            )}
            {c.has_raw_original && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClose();
                  downloadFile(`/api/photos/${c.photo_id}/original-raw?download=1`, "original.raw");
                }}
                className={MENU_ITEM}
              >
                Download RAW
              </button>
            )}
            {!c.original_managed && (
              <>
                {canRevealInFinder && (
                  <button onClick={onReveal} className={MENU_ITEM}>
                    Reveal in Finder
                  </button>
                )}
                <button onClick={onCopyPath} className={MENU_ITEM}>
                  Copy original's path
                </button>
              </>
            )}
          </>
        )
      )}
      {editor === "tagSpecies" ? (
        <div className="px-3 py-1.5">
          <SpeciesPicker autoFocus placeholder="Also features…" onSelect={(s) => onTagSpecies(s.id)} />
        </div>
      ) : (
        <button onClick={(e) => openEditor(e, "tagSpecies")} className={MENU_ITEM}>
          Also features another species…
        </button>
      )}
      {editor === "reassign" ? (
        <div className="px-3 py-1.5">
          <SpeciesPicker autoFocus placeholder="Correct ID to…" onSelect={(s) => onReassign(s.id)} />
        </div>
      ) : (
        <button onClick={(e) => openEditor(e, "reassign")} className={MENU_ITEM}>
          Correct the ID…
        </button>
      )}
      {editor === "location" ? (
        <div className="space-y-2 px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
          <input
            type="text"
            autoFocus
            defaultValue={c.location_label ?? ""}
            placeholder="Custom place name (e.g. Prince George)…"
            onBlur={(e) => {
              if (e.target.value.trim() !== (c.location_label ?? "")) onSetLocationLabel(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            className="w-full rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink outline-none focus:border-accent"
          />
          <p className="text-[10px] uppercase tracking-wide text-muted">Attached to region</p>
          {/* Fires on every drill-down click, so it saves without closing the menu. */}
          <RegionBrowser
            regionId={c.region_id}
            onChange={(regionId) => {
              regionChanged.current = true;
              onSetRegion(regionId);
            }}
            allowAnyRegion
          />
        </div>
      ) : (
        <button onClick={(e) => openEditor(e, "location")} className={MENU_ITEM}>
          {location ? `Location: ${location}` : "Set location…"}
        </button>
      )}
      {editor === "tags" ? (
        <div className="px-3 py-1.5">
          <TagEditor tags={c.tags} existingTags={tagOptions} onChange={onTagsChange} />
        </div>
      ) : (
        <button onClick={(e) => openEditor(e, "tags")} className={MENU_ITEM}>
          Edit tags…
        </button>
      )}
      <button onClick={onDelete} className="block w-full px-3 py-1.5 text-left text-red-600 hover:bg-surface-muted dark:text-red-400">
        Delete {c.photo_kind === "video" ? "video" : "photo"}
      </button>
    </div>
  );
}
