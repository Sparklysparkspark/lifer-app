import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams, useSearchParams } from "react-router-dom";
import RawUpload from "../components/RawUpload";
import PhotoImportRows from "../components/PhotoImportRows";
import { LoadingScreen } from "../components/LoadingScreen";
import PageHeader from "../components/PageHeader";
import { useSpeciesGallery } from "../components/importReview/useSpeciesGallery";
import { useSettings } from "../hooks/useSettings";
import SpeciesCard from "../components/SpeciesCard";
import SearchInput from "../components/SearchInput";
import Lightbox, { type LightboxSlide } from "../components/Lightbox";
import EmptyState from "../components/EmptyState";
import CardCropEditor from "../components/CardCropEditor";
import EditableTextField from "../components/EditableTextField";
import { FolderBrowser } from "../components/FolderPicker";
import { usePhotoGridSize } from "../hooks/usePhotoGridSize";
import { useShowLabels } from "../hooks/useShowLabels";
import { useStorageVolumes } from "../hooks/useStorageVolumes";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import FilterPopover from "../components/FilterPopover";
import {
  DateRangeField,
  FilterCheckbox,
  GridViewToggle,
  PhotoSortSelect,
  RawFilterField,
  ThumbSizeSlider,
} from "../components/PhotoGridControls";
import SelectModeToggle from "../components/SelectModeToggle";
import { usePersistedState } from "../hooks/usePersistedState";
import Button from "../components/Button";
import ConfirmDialog from "../components/ConfirmDialog";
import Modal from "../components/Modal";
import { formatDate } from "../lib/format";
import { useSpeciesName } from "../lib/speciesName";
import { countPhotoFilters, type PhotoSort, type RawFilter } from "../lib/photoListFilters";
import { useTripData } from "./trip/useTripData";
import { useTripScanImport } from "./trip/useTripScanImport";
import { useTripEdits } from "./trip/useTripEdits";
import { visibleTripPhotos, visibleTripSpecies } from "./trip/tripFilters";
import TripHeaderDetails from "./trip/TripHeaderDetails";
import TripJobStatus from "./trip/TripJobStatus";
import TripScanReview from "./trip/TripScanReview";
import TripPhotoGrid from "./trip/TripPhotoGrid";

const EMPTY_TRIP_ICON = (
  <svg
    viewBox="0 0 24 24"
    className="h-6 w-6 text-muted"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 15.5V5.5A2 2 0 0 1 5 3.5h10" />
    <rect x="6" y="6" width="14" height="14" rx="2" />
  </svg>
);

// A photo grid by default, with a species view toggle. The species-assignment review only opens
// once "Add more photos" scans the folder and finds something new.
export default function TripDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const speciesName = useSpeciesName();
  // Set by TripsPage's "Build a trip" flow: the folder is new and empty, so offer uploads instead of a scan.
  const [searchParams] = useSearchParams();
  const buildMode = searchParams.get("mode") === "build";
  const [view, setView] = useState<"gallery" | "species">("gallery");
  const [thumbSizePx, updateThumbSize] = usePhotoGridSize();
  const { multiDriveInUse } = useStorageVolumes();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [showLabels, setShowLabels] = useShowLabels();
  const [sortBy, setSortBy] = usePersistedState<PhotoSort>("tripSortBy", "newest");
  const [search, setSearch] = useState("");
  const suggestEnabled = useSettings().settings?.speciesSuggestEnabled ?? false;
  const speciesGallery = useSpeciesGallery();
  const [rawFilter, setRawFilter] = usePersistedState<RawFilter>("tripRawFilter", "without");
  const [onlyTopRated, setOnlyTopRated] = useState(false);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [dateRangeOpen, setDateRangeOpen] = useState(false);
  const batchDeleteRef = useRef<HTMLButtonElement>(null);
  const menu = useDropdownMenu<string>();
  const { trip, summary, photos, speciesItems, loadError, load } = useTripData(id);
  const jobs = useTripScanImport({ id, load, suggestEnabled });
  const edits = useTripEdits({ id, load, photos, closeMenu: () => menu.setOpenKey(null) });

  const visiblePhotos = useMemo(
    () => visibleTripPhotos(photos ?? [], search, { rawFilter, onlyTopRated, dateFrom, dateTo }, sortBy),
    [photos, search, sortBy, rawFilter, onlyTopRated, dateFrom, dateTo],
  );
  const activeFilterCount = countPhotoFilters({ rawFilter, onlyTopRated, dateFrom, dateTo });
  const visibleSpecies = useMemo(() => visibleTripSpecies(speciesItems ?? [], search), [speciesItems, search]);

  const slides = useMemo<LightboxSlide[]>(
    () =>
      visiblePhotos.map((p) => ({
        url: `/api/photos/${p.photoId}/display`,
        caption: `${speciesName(p)}${p.takenAt ? ` · ${formatDate(p.takenAt)}` : ""}`,
        info: {
          cameraModel: p.cameraModel,
          lens: p.lens,
          focalLengthMm: p.focalLengthMm,
          aperture: p.aperture,
          shutter: p.shutter,
          iso: p.iso,
          takenAt: p.takenAt,
        },
      })),
    [visiblePhotos, speciesName],
  );

  if (loadError) {
    return (
      <div className="flex flex-col items-center gap-3 py-24">
        <p className="text-muted">{t("trips.detail.loadFailed")}</p>
        <button onClick={() => void load()} className="text-sm text-ink underline">
          {t("common.retry")}
        </button>
      </div>
    );
  }
  if (!trip || !photos || !speciesItems) return <LoadingScreen />;

  const { pendingImports, scanning, startScan } = jobs;
  // Every photo the scan found, including ones a culling app rejected that the review leaves out.
  const scannedCount = jobs.scannedCount;
  const noPhotos = photos.length === 0 && pendingImports.length === 0;

  return (
    <div className="flex-1 bg-canvas">
      <PageHeader
        sticky
        title={
          <EditableTextField value={trip.name} onSave={edits.saveName} className="text-lg font-semibold text-ink" />
        }
        backFallbackTo="/trips"
        backLabel={t("trips.detail.backLabel")}
        actions={
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <GridViewToggle view={view} onChange={setView} />
            {view === "gallery" && photos.length > 0 && (
              <>
                <PhotoSortSelect value={sortBy} onChange={setSortBy} />
                <FilterPopover activeCount={activeFilterCount}>
                  <div className="space-y-2.5">
                    <FilterCheckbox checked={onlyTopRated} onChange={setOnlyTopRated}>
                      {t("trips.detail.filters.topRated")}
                    </FilterCheckbox>
                    <RawFilterField value={rawFilter} onChange={setRawFilter} />
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
                      {t("trips.detail.filters.labels")}
                    </FilterCheckbox>
                  </div>
                </FilterPopover>
                <ThumbSizeSlider value={thumbSizePx} onChange={updateThumbSize} />
                <SelectModeToggle
                  active={edits.selectMode}
                  onEnter={() => edits.setSelectMode(true)}
                  onExit={edits.exitSelectMode}
                />
              </>
            )}
            <Button variant="secondary" size="sm" onClick={startScan} disabled={scanning}>
              {scanning ? t("trips.detail.scanning") : t("trips.detail.addMorePhotos")}
            </Button>
          </div>
        }
      >
        <TripHeaderDetails
          trip={trip}
          photoCount={photos.length + jobs.importedSoFar}
          summary={summary}
          onRelocate={jobs.relocateFolder}
          onSaveDescription={edits.saveDescription}
        />
      </PageHeader>

      {jobs.relocating && (
        <div className="border-b border-line bg-surface px-6 py-3">
          <FolderBrowser
            onChoose={(folder) => jobs.applyRelocate(jobs.relocating!, folder)}
            onCancel={() => jobs.setRelocating(null)}
          />
        </div>
      )}

      <div className="flex items-center gap-3 border-b border-line bg-surface px-6 py-2 text-sm">
        <SearchInput value={search} onChange={setSearch} placeholder={t("trips.detail.searchPlaceholder")} className="w-56" />
      </div>

      {edits.selectMode && (
        <div className="flex items-center justify-between border-b border-line bg-surface-muted px-6 py-2 text-xs">
          <span className="text-muted">{t("trips.detail.selectedCount", { count: edits.selectedCaptureIds.size })}</span>
          <Button
            variant="danger"
            size="sm"
            onClick={() => edits.setConfirmingBatchDelete(true)}
            disabled={edits.selectedCaptureIds.size === 0}
          >
            {t("trips.detail.deleteSelected")}
          </Button>
        </div>
      )}

      <main className="space-y-6 p-6">
        <TripJobStatus tripId={id} jobs={jobs} />

        {scannedCount > 0 && (
          <TripScanReview
            tripId={id}
            destinationFolder={trip.destinationFolder}
            suggestEnabled={suggestEnabled}
            jobs={jobs}
            onViewSpeciesGallery={speciesGallery.open}
            speciesGalleryLightbox={speciesGallery.lightbox}
          />
        )}

        {view === "species" ? (
          visibleSpecies.length === 0 ? (
            <p className="text-muted">
              {search ? t("trips.detail.noSpeciesMatch", { search }) : t("trips.detail.noSpecies")}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
              {visibleSpecies.map((item) => (
                <SpeciesCard key={item.speciesId} item={item} backLabel={trip.name} showVolumeBadge={multiDriveInUse} />
              ))}
            </div>
          )
        ) : noPhotos && buildMode ? (
          <div className="max-w-2xl space-y-3 rounded-lg border border-line bg-surface p-4">
            <p className="text-sm text-ink">{t("trips.detail.build.dropPhotos")}</p>
            <PhotoImportRows tripId={id} onImported={() => void load()} />
            <div className="border-t border-line pt-3">
              {/* matchOnly ignores speciesId: the matched trip photo decides each RAW's species. */}
              <RawUpload speciesId="" volumeId="" matchOnly onFiled={() => void load()} />
            </div>
            <p className="text-xs text-muted">
              {t("trips.detail.build.scanInstead")}
            </p>
          </div>
        ) : noPhotos ? (
          <EmptyState
            icon={EMPTY_TRIP_ICON}
            title={t("trips.detail.empty.title")}
            description={
              scannedCount === 0 ? t("trips.detail.empty.scanFolder") : t("trips.detail.empty.assignThenImport")
            }
            action={
              scannedCount === 0
                ? { label: scanning ? t("trips.detail.scanning") : t("trips.detail.addMorePhotos"), onClick: startScan }
                : undefined
            }
          />
        ) : visiblePhotos.length === 0 && pendingImports.length === 0 ? (
          <p className="text-muted">{t("trips.detail.noPhotosMatch", { search })}</p>
        ) : (
          <TripPhotoGrid
            trip={trip}
            photos={visiblePhotos}
            pendingImports={pendingImports}
            thumbSizePx={thumbSizePx}
            showLabels={showLabels}
            edits={edits}
            menu={menu}
            onOpen={setLightboxIndex}
          />
        )}
      </main>

      {lightboxIndex !== null && (
        <Lightbox
          slides={slides}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}

      {edits.croppingCoverPhotoUrl && (
        <CardCropEditor
          photoUrl={edits.croppingCoverPhotoUrl}
          initialX={trip.coverCropX}
          initialY={trip.coverCropY}
          initialSize={trip.coverCropSize}
          onClose={() => edits.setCroppingCoverPhotoUrl(null)}
          onSave={edits.saveCoverCrop}
          onReset={edits.resetCoverCrop}
        />
      )}

      <ConfirmDialog
        open={!!edits.confirmingDeleteCaptureId}
        title={t("trips.detail.deletePhoto.title")}
        message={t("trips.detail.trashMessage")}
        confirmLabel={t("common.delete")}
        danger
        busy={edits.deleting}
        onConfirm={() =>
          edits.confirmingDeleteCaptureId && void edits.confirmDeletePhoto(edits.confirmingDeleteCaptureId)
        }
        onCancel={() => edits.setConfirmingDeleteCaptureId(null)}
      />

      <Modal
        open={edits.confirmingBatchDelete}
        onClose={() => {
          if (edits.deleting) return;
          edits.closeBatchDelete();
        }}
        title={t("trips.detail.deleteSelectedTitle", { count: edits.selectedCaptureIds.size })}
        initialFocusRef={batchDeleteRef}
        footer={
          <>
            <Button variant="secondary" size="sm" disabled={edits.deleting} onClick={edits.closeBatchDelete}>
              {t("common.cancel")}
            </Button>
            <Button
              ref={batchDeleteRef}
              variant="danger"
              size="sm"
              onClick={edits.confirmDeleteSelected}
              loading={edits.deleting}
            >
              {t("common.delete")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">{t("trips.detail.trashMessage")}</p>
        {edits.selectedHaveRaw && (
          <label className="mt-3 flex items-center gap-2 text-xs text-ink">
            <input
              type="checkbox"
              checked={edits.deleteRawToo}
              onChange={(e) => edits.setDeleteRawToo(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            {t("trips.detail.deleteRawToo")}
          </label>
        )}
      </Modal>
    </div>
  );
}
