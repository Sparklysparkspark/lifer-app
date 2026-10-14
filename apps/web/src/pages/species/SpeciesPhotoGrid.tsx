import { useMemo, useRef, useState } from "react";
import EmptyState from "../../components/EmptyState";
import PhotosIcon from "../../components/PhotosIcon";
import StarRating from "../../components/StarRating";
import Lightbox, { type LightboxSlide } from "../../components/Lightbox";
import PhotoTile from "../../components/PhotoTile";
import AddToAlbumModal from "../../components/AddToAlbumModal";
import SegmentedControl from "../../components/SegmentedControl";
import SelectModeToggle from "../../components/SelectModeToggle";
import Select from "../../components/Select";
import Pill from "../../components/Pill";
import MasonryGrid from "../../components/MasonryGrid";
import Button from "../../components/Button";
import InlineSpinner from "../../components/InlineSpinner";
import FormMessage from "../../components/FormMessage";
import { ThumbSizeSlider } from "../../components/PhotoGridControls";
import { usePhotoGridSize } from "../../hooks/usePhotoGridSize";
import { useDropdownMenu } from "../../hooks/useDropdownMenu";
import { useSelectMode } from "../../hooks/useSelectMode";
import { useDeploymentMode, useIsTauri } from "../../hooks/useDeploymentMode";
import { shotDataLine } from "../../lib/shotData";
import { formatDate } from "../../lib/format";
import { filterBucketFor, fullSizeUrl, type PhotoFilter, type SpeciesCapture, type SpeciesDetail } from "./types";
import {
  captureCounts,
  captureInfo,
  deleteNoun,
  selectionHasSeparateRaw,
  locationText,
  matchesFilter,
  photosSectionTitle,
  sortCaptures,
  type PhotoSort,
} from "./photoGridHelpers";
import { useCaptureEdits } from "./useCaptureEdits";
import CaptureMenu from "./CaptureMenu";
import CaptureEditModal, { type CaptureEdit } from "../../components/CaptureEditModal";
import { CaptureSelectBar, DeleteCapturesDialog } from "./CaptureSelection";

// Same one-line caption budget GalleryPage uses; wrapped lines are added per item.

type GridItem =
  { kind: "capture"; c: SpeciesCapture; i: number; line: string | null } | { kind: "placeholder"; key: string };

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
  const { species, captures, userSpecies } = detail;
  const menu = useDropdownMenu<string>();
  const [thumbSizePx, updateThumbSize] = usePhotoGridSize();
  // Where the grid starts within the section, so the reserved block ends just below the panel.
  // Null until the user picks one: then edited photos when there are any, else everything (a species
  // with only RAWs so far shouldn't open on an empty grid).
  const [chosenFilter, setPhotoFilter] = useState<PhotoFilter | null>(null);
  // "newest" matches the server's own order, so it's a no-op sort.
  const [photoSort, setPhotoSort] = useState<PhotoSort>("newest");
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [addingToAlbumCaptureId, setAddingToAlbumCaptureId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ captureId: string; edit: CaptureEdit } | null>(null);
  const editingCapture = editing && captures.find((c) => c.id === editing.captureId);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  // Reveal runs on the API's machine, so it only makes sense for the desktop app's own local API.
  const isTauri = useIsTauri();
  const deploymentMode = useDeploymentMode();
  const canRevealInFinder = isTauri && deploymentMode === "desktop";

  const counts = useMemo(() => captureCounts(captures), [captures]);
  const photoFilter = chosenFilter ?? (counts.edited > 0 ? "edited" : "all");
  // The cover photo leads, since the page has no hero photo above the grid.
  const sortedCaptures = useMemo(() => {
    const sorted = sortCaptures(captures, photoSort);
    const cover = sorted.findIndex((c) => c.photo_id && c.photo_id === userSpecies?.cover_photo_id);
    return cover > 0 ? [sorted[cover], ...sorted.slice(0, cover), ...sorted.slice(cover + 1)] : sorted;
  }, [captures, photoSort, userSpecies?.cover_photo_id]);
  // The lightbox browses every kind regardless of the grid's filter; the grid shows the filtered subset.
  const photoCaptures = useMemo(() => sortedCaptures.filter((c) => c.photo_id), [sortedCaptures]);
  const slideIndexById = useMemo(() => new Map(photoCaptures.map((c, i) => [c.id, i])), [photoCaptures]);
  const visibleCaptures = useMemo(
    () => photoCaptures.filter((c) => matchesFilter(c, photoFilter)),
    [photoCaptures, photoFilter],
  );

  const select = useSelectMode(visibleCaptures, (c) => c.id);
  const { selectMode, setSelectMode, selectedIds, toggle, dragPreviewIds, dragProps } = select;
  const edits = useCaptureEdits({
    speciesId: species.id,
    load,
    updateCaptures,
    select,
    closeMenu: () => menu.setOpenKey(null),
  });
  const { tagCapture, rateCapture } = edits;

  const selectedCaptures = captures.filter((c) => selectedIds.has(c.id));

  const captureSlides = useMemo<LightboxSlide[]>(
    () =>
      photoCaptures.map((c) => ({
        url: fullSizeUrl(c)!,
        videoUrl: c.photo_kind === "video" ? `/api/photos/${c.photo_id}/video` : null,
        caption: c.taken_at ? formatDate(c.taken_at) : null,
        tags: c.tags,
        onTagsChange: (tags: string[]) => void tagCapture(c.id, tags),
        info: captureInfo(c),
      })),
    [photoCaptures, tagCapture],
  );

  const gridItems = useMemo<GridItem[]>(
    () => [
      ...visibleCaptures.map((c, i) => ({ kind: "capture" as const, c, i, line: shotDataLine(c) })),
      // Placeholder tiles for uploads in flight, right where the new photo will land.
      ...Array.from({ length: pendingUploadCount }, (_, idx) => ({
        kind: "placeholder" as const,
        key: `pending-${idx}`,
      })),
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
    <section className="relative">
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          {/* For screen readers only: on screen the photos speak for themselves. */}
          <h2 className="sr-only">{photosSectionTitle(photoFilter, counts)}</h2>
          <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2">
            {captures.length > 0 && <ThumbSizeSlider value={thumbSizePx} onChange={updateThumbSize} />}
            <Pill active={galleryView} onClick={onToggleGalleryView}>
              Gallery view
            </Pill>
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
            {captures.length > 0 && (
              <SelectModeToggle active={selectMode} onEnter={() => setSelectMode(true)} onExit={edits.exitSelectMode} />
            )}
            <Button size="sm" onClick={onUpload}>
              Upload
            </Button>
          </div>
        </div>

        {selectMode && <CaptureSelectBar selectedCount={selectedIds.size} edits={edits} />}
        <FormMessage error={edits.reassignError} className="mb-2" />
      </div>

      <DeleteCapturesDialog
        dialog={edits.deleteDialog}
        count={selectedIds.size}
        noun={deleteNoun(selectedCaptures)}
        selectedHaveRaw={selectionHasSeparateRaw(selectedCaptures)}
        deleteButtonRef={deleteButtonRef}
      />

      {captures.length === 0 && pendingUploadCount === 0 ? (
        <div>
          <EmptyState
            icon={<PhotosIcon />}
            title="Not photographed yet"
            description="Upload a photo to add this species to your collection."
          />
        </div>
      ) : (
        <div>
          <MasonryGrid
            items={gridItems}
            columnWidth={thumbSizePx}
            // Gallery view shows only absolutely positioned overlays, which add no height.
            keyFor={(item) => (item.kind === "placeholder" ? item.key : item.c.id)}
            // 3:2 stands in for an ordinary landscape photo until the upload reports real dimensions.
            aspectRatioFor={(item) =>
              item.kind === "capture" && item.c.width && item.c.height ? item.c.width / item.c.height : 3 / 2
            }
            renderItem={(item, aspectRatio) => {
              if (item.kind === "placeholder") {
                return (
                  <div
                    key={item.key}
                    style={{ aspectRatio: aspectRatio ?? 3 / 2 }}
                    className="flex w-full items-center justify-center rounded-md bg-surface-muted"
                  >
                    <InlineSpinner size="md" tone="ink" label="Uploading" />
                  </div>
                );
              }
              const { c, i, line } = item;
              const menuOpen = menu.openKey === c.id;
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
                  onToggleMenu={() => menu.setOpenKey(menuOpen ? null : c.id)}
                  menuRef={menu.ref}
                  menuContent={
                    menuOpen ? (
                      <CaptureMenu
                        capture={c}
                        isCover={userSpecies?.cover_photo_id === c.photo_id}
                        canRevealInFinder={canRevealInFinder}
                        onClose={() => menu.setOpenKey(null)}
                        onRate={(rating) => void rateCapture(c.id, rating)}
                        onSetCover={() => void edits.setCover(c.photo_id!)}
                        onAddToAlbum={() => {
                          setAddingToAlbumCaptureId(c.id);
                          menu.setOpenKey(null);
                        }}
                        onReveal={() => void edits.revealInFinder(c.original_ref!)}
                        onCopyPath={() => void edits.copyPath(c.original_ref!)}
                        onEdit={(edit) => {
                          setEditing({ captureId: c.id, edit });
                          menu.setOpenKey(null);
                        }}
                        onDelete={() => edits.requestDeleteCapture(c.id)}
                      />
                    ) : null
                  }
                  label={
                    <>
                      {!galleryView &&
                        userSpecies?.best_quality != null &&
                        c.quality_rating === userSpecies.best_quality && (
                          // Beside the select checkbox (left-2, w-4) in select mode, not over it, and never
                          // in the way of a click.
                          <span
                            className={`pointer-events-none absolute top-1.5 rounded-full bg-black/40 px-1.5 py-0.5 text-[9px] text-white ${
                              selectMode ? "left-7" : "left-1"
                            }`}
                          >
                            Best shot
                          </span>
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
                      {/* Date and place share a line, saving one under every photo. */}
                      {!galleryView && (c.taken_at || location) && (
                        <p className="mt-0.5 truncate text-[10px] text-muted">
                          {[c.taken_at && formatDate(c.taken_at), location].filter(Boolean).join(" · ")}
                        </p>
                      )}
                      {!galleryView && line && <p className="text-[9px] text-muted">{line}</p>}
                    </>
                  }
                />
              );
            }}
          />
        </div>
      )}

      {lightboxIndex != null && captureSlides.length > 0 && (
        <Lightbox
          slides={captureSlides}
          index={Math.min(lightboxIndex, captureSlides.length - 1)}
          onIndexChange={setLightboxIndex}
          onClose={closeLightbox}
          tagOptions={edits.tagOptions}
        />
      )}

      {editing && editingCapture && (
        <CaptureEditModal
          edit={editing.edit}
          capture={{
            tags: editingCapture.tags,
            locationLabel: editingCapture.location_label,
            regionId: editingCapture.region_id,
          }}
          onClose={() => setEditing(null)}
          onReassign={(speciesId) => void edits.reassignSpecies(editing.captureId, speciesId)}
          onTagSpecies={(speciesId) => void edits.tagSpecies(editing.captureId, speciesId)}
          onSaveLocation={(label, regionId) => void edits.setCaptureLocation(editing.captureId, label, regionId)}
          tagOptions={edits.tagOptions}
          onTagsChange={(tags) => void tagCapture(editing.captureId, tags)}
        />
      )}
      {addingToAlbumCaptureId && (
        <AddToAlbumModal captureIds={[addingToAlbumCaptureId]} onClose={() => setAddingToAlbumCaptureId(null)} />
      )}
    </section>
  );
}
