import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import EmptyState from "../../components/EmptyState";
import PhotosIcon from "../../components/PhotosIcon";
import PhotoTileCaption from "../../components/PhotoTileCaption";
import { usePhotoCaptionPrefs } from "../../hooks/usePhotoCaptionPrefs";
import Lightbox, { type LightboxSlide } from "../../components/Lightbox";
import PhotoGrid, { type PhotoGridTileData } from "../../components/PhotoGrid";
import PhotoMenu from "../../components/PhotoMenu";
import AddToAlbumModal from "../../components/AddToAlbumModal";
import CoordinatesModal from "../../components/CoordinatesModal";
import SegmentedControl from "../../components/SegmentedControl";
import SelectModeToggle from "../../components/SelectModeToggle";
import Button from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import ConnectShareButton from "../../components/ConnectShareButton";
import { useDeploymentMode } from "../../hooks/useDeploymentMode";
import { PhotoViewMenu } from "../../components/PhotoGridControls";
import { usePhotoGridSize } from "../../hooks/usePhotoGridSize";
import { useDropdownMenu } from "../../hooks/useDropdownMenu";
import { useSelectMode } from "../../hooks/useSelectMode";
import { useLatest } from "../../hooks/useLatest";
import type { SpeciesResult } from "../../components/SpeciesPicker";
import { shotDataLine } from "../../lib/shotData";
import { formatTakenAt } from "../../lib/format";
import { filterBucketFor, fullSizeUrl, type PhotoFilter, type SpeciesCapture, type SpeciesDetail } from "./types";
import {
  captureCounts,
  captureInfo,
  selectionHasSeparateRaw,
  locationText,
  matchesFilter,
  photosSectionTitle,
  sortCaptures,
  type PhotoSort,
} from "./photoGridHelpers";
import { useCaptureEdits } from "./useCaptureEdits";
import CaptureEditModal, { type CaptureEdit } from "../../components/CaptureEditModal";
import { CaptureSelectBar } from "./CaptureSelection";
import type { Appearance } from "@lifer/shared";
import { AppearanceSummary } from "../../components/Appearance";

const SPECIES_PHOTO_SORTS: readonly PhotoSort[] = ["newest", "oldest", "rating"];

// Same one-line caption budget GalleryPage uses; wrapped lines are added per item.

const captureKey = (c: SpeciesCapture) => c.id;
const appearanceOf = (c: SpeciesCapture): Appearance => ({
  lifeStage: c.life_stage ?? null,
  sex: c.sex ?? null,
  plumage: c.plumage ?? null,
  morph: c.morph ?? null,
});
const captureTile = (c: SpeciesCapture): PhotoGridTileData => ({
  photoId: c.photo_id,
  alt: "",
  kind: c.photo_kind,
  durationSeconds: c.duration_seconds,
  width: c.width,
  height: c.height,
});

export default function SpeciesPhotoGrid({
  detail,
  pendingUploadCount,
  load,
  updateCaptures,
  onUpload,
  trip,
}: {
  /** Opened from a trip: its photos lead in their own section, the rest follow. */
  trip?: { id: string; name: string | null };
  detail: SpeciesDetail;
  pendingUploadCount: number;
  load: () => void;
  updateCaptures: (ids: Iterable<string>, patch: (c: SpeciesCapture) => Partial<SpeciesCapture>) => void;
  onUpload: () => void;
}) {
  const { t } = useTranslation();
  const { species, captures, userSpecies } = detail;
  const menu = useDropdownMenu<string>();
  const [thumbSizePx, updateThumbSize] = usePhotoGridSize();
  const captions = usePhotoCaptionPrefs();
  // Where the grid starts within the section, so the reserved block ends just below the panel.
  // Null until the user picks one: then edited photos when there are any, else everything (a species
  // with only RAWs so far shouldn't open on an empty grid).
  const [chosenFilter, setPhotoFilter] = useState<PhotoFilter | null>(null);
  // "newest" matches the server's own order, so it's a no-op sort.
  const [photoSort, setPhotoSort] = useState<PhotoSort>("newest");
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [addingToAlbumCaptureId, setAddingToAlbumCaptureId] = useState<string | null>(null);
  // The coordinates dialog, as on the map.
  const [placingCaptureId, setPlacingCaptureId] = useState<string | null>(null);
  const placingCapture = placingCaptureId ? captures.find((c) => c.id === placingCaptureId) : undefined;
  const [editing, setEditing] = useState<{ captureId: string; edit: CaptureEdit } | null>(null);
  const editingCapture = editing && captures.find((c) => c.id === editing.captureId);

  const counts = useMemo(() => captureCounts(captures), [captures]);
  const desktop = useDeploymentMode() === "desktop";
  const unmountedShare = captures.find((c) => c.original_share_path && c.original_volume_label);
  const photoFilter = chosenFilter ?? (counts.edited > 0 ? "edited" : "all");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const navigate = useNavigate();
  const inTrip = useCallback((c: SpeciesCapture) => !!trip && c.trip_id === trip.id, [trip]);
  // Trip photos first, so the grid, range select and the lightbox all follow the on-screen order.
  const sortedCaptures = useMemo(() => {
    const sorted = sortCaptures(captures, photoSort);
    return trip ? [...sorted.filter(inTrip), ...sorted.filter((c) => !inTrip(c))] : sorted;
  }, [captures, photoSort, trip, inTrip]);
  // The lightbox browses every kind regardless of the grid's filter; the grid shows the filtered subset.
  const photoCaptures = useMemo(() => sortedCaptures.filter((c) => c.photo_id), [sortedCaptures]);
  const slideIndexById = useMemo(() => new Map(photoCaptures.map((c, i) => [c.id, i])), [photoCaptures]);
  const visibleCaptures = useMemo(
    () => photoCaptures.filter((c) => matchesFilter(c, photoFilter)),
    [photoCaptures, photoFilter],
  );
  // Omitted when the trip has none of this species' photos in view: then it's the plain grid.
  const groups = useMemo(() => {
    if (!trip) return null;
    const entries = visibleCaptures.map((item, i) => ({ item, i }));
    const fromTrip = entries.filter((e) => inTrip(e.item));
    if (fromTrip.length === 0) return null;
    const toggle = (key: string) => () =>
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (!next.delete(key)) next.add(key);
        return next;
      });
    return [
      {
        key: "trip",
        label: trip.name ? t("species.photoGrid.fromTrip", { trip: trip.name }) : t("species.photoGrid.fromThisTrip"),
        entries: fromTrip,
        collapsed: collapsed.has("trip"),
        onToggle: toggle("trip"),
        action: (
          <Button variant="link" size="sm" onClick={() => navigate(`/trips/${trip.id}`)} className="shrink-0">
            {t("species.photoGrid.openTrip")}
          </Button>
        ),
      },
      {
        key: "other",
        label: t("species.photoGrid.otherPhotos"),
        entries: entries.filter((e) => !inTrip(e.item)),
        collapsed: collapsed.has("other"),
        onToggle: toggle("other"),
      },
    ].filter((g) => g.entries.length > 0);
  }, [trip, visibleCaptures, inTrip, collapsed, navigate, t]);

  const select = useSelectMode(visibleCaptures, (c) => c.id);
  const { selectMode, setSelectMode, selectedIds } = select;
  const edits = useCaptureEdits({
    speciesId: species.id,
    load,
    updateCaptures,
    select,
    closeMenu: () => menu.setOpenKey(null),
  });
  const { tagCapture, rateCapture } = edits;
  // Changes every render; the ref keeps the slides memoized.
  const reassignRef = useLatest(edits.reassignSpecies);
  const renderMenuRef = useLatest(renderCaptureMenu);

  const selectedCaptures = captures.filter((c) => selectedIds.has(c.id));

  const captureSlides = useMemo<LightboxSlide[]>(
    () =>
      photoCaptures.map((c) => ({
        url: fullSizeUrl(c)!,
        videoUrl: c.photo_kind === "video" ? `/api/photos/${c.photo_id}/video` : null,
        audioUrl: c.photo_kind === "audio" ? `/api/photos/${c.photo_id}/audio` : null,
        frameUrl: c.photo_kind === "video" ? `/photos/${c.photo_id}/frame` : null,
        rating: c.quality_rating,
        onRate: (rating: number | null) => void rateCapture(c.id, rating),
        captureId: c.id,
        onReassign: (species: SpeciesResult) => void reassignRef.current(c.id, species),
        tags: c.tags,
        onTagsChange: (tags: string[]) => void tagCapture(c.id, tags),
        appearance: appearanceOf(c),
        onAppearanceChange: (changes: Partial<Appearance>) =>
          updateCaptures([c.id], () => ({
            ...("lifeStage" in changes && { life_stage: changes.lifeStage }),
            ...("sex" in changes && { sex: changes.sex }),
            ...("plumage" in changes && { plumage: changes.plumage }),
            ...("morph" in changes && { morph: changes.morph }),
          })),
        info: captureInfo(c),
        // The grid's own photo menu, built when the viewer's ⋯ opens.
        menu: (close: () => void) => renderMenuRef.current(c, close),
      })),
    [photoCaptures, tagCapture, rateCapture, reassignRef, updateCaptures, renderMenuRef],
  );
  const appearances = useMemo(() => captures.map(appearanceOf), [captures]);
  const morphOptions = useMemo(() => appearances.flatMap((a) => (a.morph ? [a.morph] : [])), [appearances]);

  // Loading tiles for uploads in flight, right where the new photo will land.
  const pendingKeys = useMemo(
    () => Array.from({ length: pendingUploadCount }, (_, i) => String(i)),
    [pendingUploadCount],
  );

  function renderCaptureMenu(c: SpeciesCapture, close = () => menu.setOpenKey(null)) {
    const isCover = userSpecies?.cover_photo_id === c.photo_id;
    const edit = (edit: CaptureEdit) => () => setEditing({ captureId: c.id, edit });
    const [editTags, correctId, tagSpecies] = [edit("tags"), edit("reassign"), edit("tagSpecies")];
    return (
      <PhotoMenu
        photo={{
          captureId: c.id,
          photoId: c.photo_id!,
          kind: c.photo_kind,
          rating: c.quality_rating,
          originalRef: c.original_ref,
          originalKind: c.original_kind,
          originalManaged: c.original_managed,
          originalAvailable: c.original_available,
          originalVolumeLabel: c.original_volume_label,
          originalSharePath: c.original_share_path,
          hasRaw: c.has_raw_original,
          inatObservationId: c.inat_observation_id,
        }}
        onClose={close}
        onRate={(rating) => void rateCapture(c.id, rating)}
        featured={isCover}
        onToggleFeatured={() => void edits.setCover(isCover ? null : c.photo_id!)}
        onAddToAlbum={() => setAddingToAlbumCaptureId(c.id)}
        onEditTags={editTags}
        onCorrectId={correctId}
        onTagSpecies={tagSpecies}
        location={locationText(c)}
        onSetLocation={() => setPlacingCaptureId(c.id)}
        onInatSent={load}
        onHide={() => void edits.hide([c.id])}
        onDelete={() => void edits.deletePhoto(c.id)}
        onDeleteWithRaw={() => void edits.deletePhoto(c.id, true)}
      />
    );
  }

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
          <AppearanceSummary items={appearances} className="max-w-prose" />
          <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2">
            {(counts.raw > 0 || counts.video > 0) && (
              <SegmentedControl
                size="sm"
                value={photoFilter}
                onChange={setPhotoFilter}
                options={[
                  {
                    value: "all",
                    label: t("species.photoGrid.filterAll", { count: counts.all }),
                  },
                  { value: "edited", label: t("species.photoGrid.filterEdited", { count: counts.edited }) },
                  ...(counts.raw > 0
                    ? [{ value: "raw" as const, label: t("species.photoGrid.filterRaw", { count: counts.raw }) }]
                    : []),
                  ...(counts.video > 0
                    ? [{ value: "video" as const, label: t("species.photoGrid.filterVideo", { count: counts.video }) }]
                    : []),
                ]}
              />
            )}
            {/* Finding (kind), then viewing (the View menu), then actions, as on every grid. */}
            {captures.length > 0 && (
              <PhotoViewMenu
                sections={captures.length > 1 ? ["sort", "size", "captions"] : ["size", "captions"]}
                activeCount={photoSort !== "newest" ? 1 : 0}
                sort={{ value: photoSort, options: SPECIES_PHOTO_SORTS, onChange: setPhotoSort }}
                size={{ value: thumbSizePx, onChange: updateThumbSize }}
                captions={captions}
              />
            )}
            {captures.length > 0 && (
              <SelectModeToggle active={selectMode} onEnter={() => setSelectMode(true)} onExit={edits.exitSelectMode} />
            )}
            <Button size="sm" onClick={onUpload}>
              {t("species.detail.upload")}
            </Button>
          </div>
        </div>

        {selectMode && (
          <CaptureSelectBar
            selectedCount={selectedIds.size}
            selectedHaveRaw={selectionHasSeparateRaw(selectedCaptures)}
            edits={edits}
          />
        )}
        <FormMessage error={edits.reassignError} className="mb-2" />
        {/* The tiles only get a dot; one line says which share to connect, with the button. */}
        {desktop && unmountedShare && (
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-footnote text-muted">
            <p>{t("libraryLocations.someOriginalsOn", { name: unmountedShare.original_volume_label })}</p>
            <ConnectShareButton
              mountPath={unmountedShare.original_share_path!}
              name={unmountedShare.original_volume_label!}
            />
          </div>
        )}
      </div>

      {captures.length === 0 && pendingUploadCount === 0 ? (
        <div>
          <EmptyState
            icon={<PhotosIcon />}
            title={t("species.photoGrid.empty.title")}
            description={t("species.photoGrid.empty.description")}
          />
        </div>
      ) : (
        <div>
          <PhotoGrid
            items={visibleCaptures}
            groups={groups}
            idFor={captureKey}
            tileFor={captureTile}
            columnWidth={thumbSizePx}
            select={select}
            menu={menu}
            pending={{ keys: pendingKeys, label: t("species.photoGrid.uploading") }}
            onOpen={(i) => setLightboxIndex(slideIndexById.get(visibleCaptures[i].id) ?? 0)}
            renderMenu={(c) => renderCaptureMenu(c)}
            renderLabel={(c) => {
              const location = locationText(c);
              return (
                <>
                  {captions.showRatings &&
                    userSpecies?.best_quality != null &&
                    c.quality_rating === userSpecies.best_quality && (
                      // Beside the select checkbox (left-2, w-4) in select mode, not over it, and never
                      // in the way of a click.
                      <span
                        className={`pointer-events-none absolute top-1.5 rounded-full bg-black/40 px-1.5 py-0.5 text-micro text-white ${
                          selectMode ? "left-7" : "left-1"
                        }`}
                      >
                        {t("species.photoGrid.bestShot")}
                      </span>
                    )}
                  {/* The explanation lives in the menu; the tile only gets a dot. */}
                  {c.original_available === false && (
                    <span
                      className="absolute bottom-1.5 left-1.5 h-2.5 w-2.5 rounded-full bg-red-600 shadow"
                      title={
                        c.original_not_responding
                          ? t("species.photoGrid.unavailableNotResponding")
                          : c.original_volume_label
                            ? t("species.photoGrid.unavailableConnect", { volume: c.original_volume_label })
                            : t("species.photoGrid.unavailableMissing")
                      }
                    />
                  )}
                  {/* Every photo here is this species, so its label is when and where it was taken. */}
                  <PhotoTileCaption
                    {...captions}
                    label={[formatTakenAt(c.taken_at, c.taken_at_zoned), location].filter(Boolean).join(" · ")}
                    rating={c.quality_rating}
                    onRate={(rating) => void rateCapture(c.id, rating)}
                    shotLine={shotDataLine(c)}
                  />
                </>
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
          morphOptions={morphOptions}
        />
      )}

      {editing && editingCapture && (
        <CaptureEditModal
          edit={editing.edit}
          capture={{
            captureId: editing.captureId,
            tags: editingCapture.tags,
            locationLabel: editingCapture.location_label,
            regionId: editingCapture.region_id,
          }}
          onClose={() => setEditing(null)}
          onReassign={(species) => void edits.reassignSpecies(editing.captureId, species)}
          onTagSpecies={(speciesId) => void edits.tagSpecies(editing.captureId, speciesId)}
          tagOptions={edits.tagOptions}
          onTagsChange={(tags) => void tagCapture(editing.captureId, tags)}
        />
      )}
      {placingCapture && (
        <CoordinatesModal
          captureIds={[placingCapture.id]}
          lat={placingCapture.lat == null ? null : Number(placingCapture.lat)}
          lon={placingCapture.lon == null ? null : Number(placingCapture.lon)}
          suggestRegion={!placingCapture.region_id}
          place={{ label: placingCapture.location_label, regionId: placingCapture.region_id }}
          onSaved={(point, region) => {
            updateCaptures([placingCapture.id], () => ({
              lat: point?.lat ?? null,
              lon: point?.lon ?? null,
              ...(region ? { region_id: region.id, region_name: region.name } : {}),
            }));
            load();
          }}
          onUndone={load}
          onClose={() => setPlacingCaptureId(null)}
        />
      )}
      {addingToAlbumCaptureId && (
        <AddToAlbumModal captureIds={[addingToAlbumCaptureId]} onClose={() => setAddingToAlbumCaptureId(null)} />
      )}
    </section>
  );
}
