import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { LoadingScreen, Spinner } from "../components/LoadingScreen";
import PageHeader from "../components/PageHeader";
import PhotoImportRows from "../components/PhotoImportRows";
import SpeciesCard from "../components/SpeciesCard";
import Lightbox, { type LightboxSlide } from "../components/Lightbox";
import { photoFilePaths } from "../lib/photoFilePaths";
import CardCropEditor from "../components/CardCropEditor";
import EditableTextField from "../components/EditableTextField";
import EmptyState from "../components/EmptyState";
import PhotosIcon from "../components/PhotosIcon";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import { usePhotoGridSize } from "../hooks/usePhotoGridSize";
import { useShowLabels } from "../hooks/useShowLabels";
import { useDeploymentMode } from "../hooks/useDeploymentMode";
import FilterPopover from "../components/FilterPopover";
import {
  DateRangeField,
  FilterCheckbox,
  GridViewToggle,
  MediaFilterField,
  PhotoSortSelect,
  RawFilterFields,
  ThumbSizeSlider,
} from "../components/PhotoGridControls";
import SelectModeToggle from "../components/SelectModeToggle";
import { usePersistedState } from "../hooks/usePersistedState";
import { useSelectMode } from "../hooks/useSelectMode";
import Button from "../components/Button";
import {
  countPhotoFilters,
  DEFAULT_RAW_FILES,
  matchesMediaFilter,
  matchesPhotoFilters,
  sortPhotos,
  type MediaFilter,
  type PhotoSort,
  type EditedRawFilter,
  type RawFilesFilter,
} from "../lib/photoListFilters";
import type { AlbumView } from "./album/types";
import { useAlbumDetail } from "./album/useAlbumDetail";
import { useAlbumShares } from "./album/useAlbumShares";
import AlbumSharePanel from "./album/AlbumSharePanel";
import AlbumCoverEditor from "./album/AlbumCoverEditor";
import AlbumPhotoGrid from "./album/AlbumPhotoGrid";
import { useSpeciesName } from "../lib/speciesName";
import { backStateFor } from "../lib/backLabel";
import { useScrollMemory } from "../hooks/useScrollMemory";
import { useUrlParam } from "../hooks/useSearchParamsKeepingState";

const SPECIES_ICON = (
  <svg
    viewBox="0 0 24 24"
    className="h-6 w-6 text-muted"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 2 2 7l10 5 10-5-10-5ZM2 17l10 5 10-5M2 12l10 5 10-5" />
  </svg>
);

function toggleButtonClass(active: boolean): string {
  return `rounded-md border px-3 py-1.5 text-sm font-medium ${
    active ? "border-ink bg-surface-muted text-ink" : "border-line text-ink hover:bg-surface-muted"
  }`;
}

export default function AlbumDetailPage() {
  const speciesName = useSpeciesName();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [thumbSizePx, setThumbSizePx] = usePhotoGridSize();
  const [showLabels, setShowLabels] = useShowLabels();
  // Sorting and filtering are client-side since the whole album loads at once. Unrated sorts as 3.
  const [sortBy, setSortBy] = usePersistedState<PhotoSort>("albumSortBy", "newest");
  const [mediaFilter, setMediaFilter] = usePersistedState<MediaFilter>("albumMediaFilter", "photos");
  const [rawFiles, setRawFiles] = usePersistedState<RawFilesFilter>("albumRawFiles", DEFAULT_RAW_FILES);
  const [editedRaw, setEditedRaw] = usePersistedState<EditedRawFilter>("albumEditedRaw", "any");
  const [onlyTopRated, setOnlyTopRated] = useState(false);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [dateRangeOpen, setDateRangeOpen] = useState(false);
  const menu = useDropdownMenu<string>();
  const isServerMode = useDeploymentMode() === "server";
  // In the URL so returning from a species opened here lands on the same view.
  const [viewParam, setViewParam] = useUrlParam("view");
  const view: AlbumView = viewParam === "species" ? "species" : "gallery";
  const setView = (next: AlbumView) => setViewParam(next === "species" ? next : "");
  const [croppingCoverPhotoUrl, setCroppingCoverPhotoUrl] = useState<string | null>(null);
  // Cover controls and the edit toolbar stay hidden until asked for, keeping the grid uncluttered.
  const [editingCover, setEditingCover] = useState(false);
  const [editMode, setEditMode] = useState(false);
  // Imports link new captures into the album; files stay wherever the library stores them.
  const [showImportPanel, setShowImportPanel] = useState(false);
  // Which quad tile (0-3) is mid pick-a-photo or crop; only one at a time.
  const [pickingQuadSlot, setPickingQuadSlot] = useState<number | null>(null);
  const [croppingQuadSlot, setCroppingQuadSlot] = useState<number | null>(null);
  const shares = useAlbumShares(id);
  const detail = useAlbumDetail(id, view);
  const { album } = detail;

  // Slides and the grid both derive from this array so the shared lightbox index stays correct.
  const sortedItems = useMemo(() => {
    if (!album) return [];
    const photoFilters = { rawFiles, editedRaw, onlyTopRated, dateFrom, dateTo };
    return sortPhotos(album.items, sortBy).filter(
      (item) =>
        matchesMediaFilter(item.kind, mediaFilter) &&
        matchesPhotoFilters(
          item,
          { hasRaw: !!item.hasRawOriginal, rawOnly: item.originalKind === "raw" },
          photoFilters,
        ),
    );
  }, [album, sortBy, mediaFilter, rawFiles, editedRaw, onlyTopRated, dateFrom, dateTo]);
  const select = useSelectMode(sortedItems, (item) => item.captureId);
  const { selectMode } = select;
  useScrollMemory(!!album);

  if (detail.loadError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <p className="text-muted">Couldn't load this album.</p>
        <Button variant="secondary" size="sm" onClick={detail.load}>
          Retry
        </Button>
      </div>
    );
  }
  if (!album) return <LoadingScreen />;

  const hasVideoInAlbum = album.items.some((i) => i.kind === "video");
  // Media and RAW filters count toward the badge only when off their default preset.
  const activeFilterCount =
    countPhotoFilters({ rawFiles, editedRaw, onlyTopRated, dateFrom, dateTo }) + (mediaFilter !== "photos" ? 1 : 0);

  const slides: LightboxSlide[] = sortedItems.map((item) => ({
    url: `/api/photos/${item.photoId}/display`,
    videoUrl: item.kind === "video" ? `/api/photos/${item.photoId}/video` : null,
    caption: speciesName(item),
    speciesId: item.speciesId,
    info: {
      cameraModel: item.cameraModel,
      lens: item.lens,
      focalLengthMm: item.focalLengthMm,
      aperture: item.aperture,
      shutter: item.shutter,
      iso: item.iso,
      durationSeconds: item.durationSeconds,
      files: photoFilePaths(item.originalRef, item.rawRef),
    },
  }));
  // The Gallery picker and species pages opened from here name the album on their back link.
  const backState = backStateFor(location, t, album.name);
  const croppingSlot = croppingQuadSlot != null ? album.quadSlots[croppingQuadSlot] : null;

  return (
    <div className="flex-1 bg-canvas">
      <PageHeader
        sticky
        title={
          <EditableTextField value={album.name} onSave={detail.saveName} className="text-lg font-semibold text-ink" />
        }
        backFallbackTo="/albums"
        backLabel="Albums"
        actions={
          <>
            <GridViewToggle view={view} onChange={setView} />
            {view === "gallery" && (
              <>
                <PhotoSortSelect value={sortBy} onChange={setSortBy} />
                <FilterPopover activeCount={activeFilterCount}>
                  <div className="space-y-2.5">
                    {hasVideoInAlbum && <MediaFilterField value={mediaFilter} onChange={setMediaFilter} />}
                    <RawFilterFields
                      rawFiles={rawFiles}
                      editedRaw={editedRaw}
                      onRawFilesChange={setRawFiles}
                      onEditedRawChange={setEditedRaw}
                    />
                    <FilterCheckbox checked={onlyTopRated} onChange={setOnlyTopRated}>
                      Top rated
                    </FilterCheckbox>
                    <DateRangeField
                      dateFrom={dateFrom}
                      dateTo={dateTo}
                      onDateFromChange={setDateFrom}
                      onDateToChange={setDateTo}
                      open={dateRangeOpen}
                      onOpen={() => setDateRangeOpen(true)}
                    />
                  </div>
                  <div className="space-y-1.5 border-t border-line pt-2.5">
                    <FilterCheckbox checked={showLabels} onChange={setShowLabels}>
                      Labels
                    </FilterCheckbox>
                  </div>
                </FilterPopover>
                <ThumbSizeSlider value={thumbSizePx} onChange={setThumbSizePx} />
                <SelectModeToggle active={selectMode} onEnter={() => select.setSelectMode(true)} onExit={select.exit} />
              </>
            )}
            <button onClick={() => setEditMode((v) => !v)} className={toggleButtonClass(editMode)}>
              {editMode ? "Done editing" : "Edit album"}
            </button>
            {/* Desktop has no public URL to share, so sharing is server mode only. */}
            {isServerMode && (
              <button
                onClick={shares.togglePanel}
                className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-muted"
              >
                {shares.showPanel ? "Hide sharing" : "Share…"}
              </button>
            )}
          </>
        }
      >
        <div className="mt-2 w-full">
          <EditableTextField
            value={album.description ?? ""}
            onSave={detail.saveDescription}
            placeholder="Add a description…"
            className="text-sm text-ink"
            multiline
          />
        </div>
        {editMode && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Link
              to={`/gallery?select=1&albumId=${album.id}`}
              state={backState}
              className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-muted"
            >
              Add photos
            </Link>
            <button onClick={() => setEditingCover((v) => !v)} className={toggleButtonClass(editingCover)}>
              {editingCover ? "Done editing cover" : "Edit cover"}
            </button>
            <button
              onClick={() => setShowImportPanel((v) => !v)}
              className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-muted"
            >
              Import album
            </button>
          </div>
        )}
      </PageHeader>

      {showImportPanel && id && (
        <div className="border-b border-line bg-surface-muted px-page py-4">
          <PhotoImportRows
            albumId={id}
            onImported={() => {
              detail.load();
              setShowImportPanel(false);
            }}
          />
        </div>
      )}

      {shares.showPanel && isServerMode && <AlbumSharePanel shares={shares} />}

      <main className="p-page">
        {album.items.length === 0 ? (
          <EmptyState
            icon={<PhotosIcon />}
            title="Nothing in this album yet"
            description="Add photos from the Gallery, a Trip, or a species page."
            action={{
              label: "Add photos",
              onClick: () => navigate(`/gallery?select=1&albumId=${album.id}`, { state: backState }),
            }}
          />
        ) : view === "species" ? (
          detail.speciesItems == null ? (
            <Spinner />
          ) : detail.speciesItems.length === 0 ? (
            <EmptyState
              icon={SPECIES_ICON}
              title="No species in this album yet"
              description="Photos in this album haven't been identified to species."
            />
          ) : (
            <div className="grid grid-cols-2 gap-item sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
              {detail.speciesItems.map((item) => (
                <SpeciesCard key={item.speciesId} item={item} backLabel={album.name} />
              ))}
            </div>
          )
        ) : (
          <>
            {editingCover && (
              <AlbumCoverEditor
                coverLayout={album.coverLayout}
                quadSlots={album.quadSlots}
                pickingSlot={pickingQuadSlot}
                onSetCoverLayout={detail.setCoverLayout}
                onPickSlot={setPickingQuadSlot}
                onCropSlot={setCroppingQuadSlot}
              />
            )}
            <AlbumPhotoGrid
              items={sortedItems}
              select={select}
              thumbSizePx={thumbSizePx}
              showLabels={showLabels}
              coverPhotoId={album.coverPhotoId}
              coverLayout={album.coverLayout}
              pickingQuadSlot={pickingQuadSlot}
              menu={menu}
              speciesLinkState={backState}
              onOpen={setLightboxIndex}
              onPickQuadPhoto={(slot, photoId) => {
                setPickingQuadSlot(null);
                return detail.setQuadSlotPhoto(slot, photoId);
              }}
              onSetCover={(photoId) => {
                menu.setOpenKey(null);
                return detail.setCoverPhoto(photoId);
              }}
              onAdjustCover={setCroppingCoverPhotoUrl}
              onRemove={detail.removeFromAlbum}
            />
          </>
        )}
      </main>

      {lightboxIndex !== null && (
        <Lightbox
          slides={slides}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
          backLabel={album.name}
        />
      )}

      {croppingCoverPhotoUrl && (
        <CardCropEditor
          photoUrl={croppingCoverPhotoUrl}
          initialX={album.coverCropX}
          initialY={album.coverCropY}
          initialSize={album.coverCropSize}
          onClose={() => setCroppingCoverPhotoUrl(null)}
          onSave={detail.saveCoverCrop}
          onReset={detail.resetCoverCrop}
        />
      )}

      {croppingQuadSlot != null && croppingSlot && (
        <CardCropEditor
          photoUrl={`/api/photos/${croppingSlot.photoId}/display`}
          initialX={croppingSlot.cropX}
          initialY={croppingSlot.cropY}
          initialSize={croppingSlot.cropSize}
          onClose={() => setCroppingQuadSlot(null)}
          onSave={async (crop) => {
            await detail.saveQuadSlotCrop(croppingQuadSlot, crop);
            setCroppingQuadSlot(null);
          }}
          onReset={async () => {
            await detail.resetQuadSlotCrop(croppingQuadSlot);
            setCroppingQuadSlot(null);
          }}
        />
      )}
    </div>
  );
}
