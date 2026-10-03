import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";
import RawUpload from "../components/RawUpload";
import PhotoImportRows from "../components/PhotoImportRows";
import type { CollectionItem, JobStatus } from "@lifer/shared";
import JobProgress, { type PhaseLabels } from "../components/JobProgress";
import { api } from "../api/client";
import { LoadingScreen } from "../components/LoadingScreen";
import PageHeader from "../components/PageHeader";
import SpeciesPicker, { type SuggestedSpecies } from "../components/SpeciesPicker";
import ImportReviewRow from "../components/importReview/ImportReviewRow";
import { useImportReview, type ReviewRowBase } from "../components/importReview/useImportReview";
import { useSpeciesGallery } from "../components/importReview/useSpeciesGallery";
import { useSettings } from "../hooks/useSettings";
import { mapWithConcurrency } from "../lib/concurrency";
import SpeciesCard from "../components/SpeciesCard";
import MasonryGrid from "../components/MasonryGrid";
import PhotoTile from "../components/PhotoTile";
import SearchInput from "../components/SearchInput";
import Lightbox, { type LightboxSlide } from "../components/Lightbox";
import EmptyState from "../components/EmptyState";
import CardCropEditor from "../components/CardCropEditor";
import EditableTextField from "../components/EditableTextField";
import { FolderBrowser, pickFolderNative } from "../components/FolderPicker";
import RegionBrowser from "../components/RegionBrowser";
import InfoTip from "../components/InfoTip";
import { usePhotoGridSize } from "../hooks/usePhotoGridSize";
import { useShowLabels } from "../hooks/useShowLabels";
import { useStorageVolumes } from "../hooks/useStorageVolumes";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import { useJobPoll } from "../hooks/useJobPoll";
import { useToast } from "../hooks/useToast";
import { downloadFile } from "../lib/downloadFile";
import Select from "../components/Select";
import FilterPopover, { FilterFieldLabel } from "../components/FilterPopover";
import SegmentedControl from "../components/SegmentedControl";
import SelectModeToggle from "../components/SelectModeToggle";
import { usePersistedState } from "../hooks/usePersistedState";
import Button from "../components/Button";
import ConfirmDialog from "../components/ConfirmDialog";
import FormMessage from "../components/FormMessage";
import InlineSpinner from "../components/InlineSpinner";
import Modal from "../components/Modal";
import { errorMessage } from "../lib/errorMessage";
import { formatDate } from "../lib/formatDate";
import { pluralize } from "../lib/pluralize";

const RELOCATE_INFO_PARAGRAPHS = [
  "Use this if this trip's folder moved: a new computer, a reinstall, a renamed drive.",
  "It doesn't move or copy any files. It just updates the path Lifer has stored, then automatically rescans the new location and relinks your existing photos by their content. You won't need to reassign species to anything that's already here.",
];

interface TripDetail {
  id: string;
  name: string;
  description: string | null;
  sourceFolder: string;
  destinationFolder: string;
  coverCaptureId: string | null;
  coverCropX: number | null;
  coverCropY: number | null;
  coverCropSize: number | null;
  coverLayout: "single" | "quad";
}

// GET /api/trips/:id/summary: what was new or notable about the trip.
interface TripSummary {
  speciesCount: number;
  liferCount: number;
  rareCount: number;
  endemicCount: number;
}

interface TripPhoto {
  photoId: string;
  width: number | null;
  height: number | null;
  captureId: string;
  speciesId: string;
  scientificName: string;
  commonName: string | null;
  takenAt: string | null;
  hasRaw: boolean;
  originalRef: string | null;
  originalKind: string | null;
  qualityRating: number | null;
  cameraModel: string | null;
  lens: string | null;
  focalLengthMm: number | null;
  aperture: number | null;
  shutter: string | null;
  iso: number | null;
}

type ScanStatus = JobStatus & {
  relinked: number;
  markedStale: number;
  collisions: number;
  recovered: number;
  rawsLinked: number;
  newFiles: Array<{ relativePath: string }>;
};

type ImportStatus = JobStatus<{ imported: number; failed: number }> & {
  results: Array<{ relativePath: string; captureId?: string; error?: string }>;
};

const SCAN_PHASES: PhaseLabels = {
  checking: { label: "Checking known photos", progress: "count" },
  recovering: { label: "Recovering photos", progress: "count" },
  "finding-new": { label: "Finding new photos in the trip folder", progress: "count" },
  "linking-raws": { label: "Linking RAW files", progress: "count" },
};
const IMPORT_PHASES: PhaseLabels = { importing: { label: "Importing photos", progress: "count" } };

type ReviewRowStatus = "pending" | "ready" | "importing" | "done" | "error";

// key is the file's path within the trip folder.
interface ReviewRow extends ReviewRowBase {
  status: ReviewRowStatus;
  error?: string;
}

// Shared with the import screen and the collection, so the last region picked anywhere is the default.
const LAST_REGION_KEY = "lifer:lastRegionId";
// Each check is a real inference pass on the server.
const INSPECT_CONCURRENCY = 2;

type View = "gallery" | "species";

// A photo grid by default, with a species view toggle. The species-assignment review only opens
// once "Add more photos" scans the folder and finds something new.
export default function TripDetailPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  // Set by TripsPage's "Build a trip" flow: the folder is new and empty, so offer uploads instead of a scan.
  const [searchParams] = useSearchParams();
  const buildMode = searchParams.get("mode") === "build";
  const [trip, setTrip] = useState<TripDetail | null>(null);
  const [summary, setSummary] = useState<TripSummary | null>(null);
  const [photos, setPhotos] = useState<TripPhoto[] | null>(null);
  const [speciesItems, setSpeciesItems] = useState<CollectionItem[] | null>(null);
  const [view, setView] = useState<View>("gallery");
  const [loadError, setLoadError] = useState(false);
  const [thumbSizePx, updateThumbSize] = usePhotoGridSize();
  const { multiDriveInUse } = useStorageVolumes();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [showLabels, setShowLabels] = useShowLabels();
  const [sortBy, setSortBy] = usePersistedState<"newest" | "oldest" | "ratingHigh" | "ratingLow">("tripSortBy", "newest");
  const [search, setSearch] = useState("");
  const [settingCover, setSettingCover] = useState<string | null>(null);
  const [croppingCoverPhotoUrl, setCroppingCoverPhotoUrl] = useState<string | null>(null);
  // One loading tile per in-flight import; the review table closes as soon as an import starts.
  const [pendingImports, setPendingImports] = useState<string[]>([]);

  const [reviewRows, setReviewRows] = useState<ReviewRow[]>([]);
  // One region for the whole scanned batch: narrows the species suggestions and is stored on each
  // photo, as on the import screen.
  const [reviewRegionId, setReviewRegionId] = useState<string | null>(() => localStorage.getItem(LAST_REGION_KEY));
  const suggestEnabled = useSettings().settings?.speciesSuggestEnabled ?? false;
  const speciesGallery = useSpeciesGallery();

  // Which of the trip's two folders the in-page folder browser is choosing, if any.
  const [relocating, setRelocating] = useState<"sourceFolder" | "destinationFolder" | null>(null);
  const [relocateError, setRelocateError] = useState<string | null>(null);

  // Photo-grid multi-select (separate from `selected`, the review-row selection above). Trips have
  // no videos or per-photo tags, so the filters are just top rated, RAW and a date range.
  const [rawFilter, setRawFilter] = usePersistedState<"any" | "with" | "without">("tripRawFilter", "without");
  const [onlyTopRated, setOnlyTopRated] = useState(false);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [dateRangeOpen, setDateRangeOpen] = useState(false);
  const [gallerySelectMode, setGallerySelectMode] = useState(false);
  const [selectedPhotoCaptureIds, setSelectedPhotoCaptureIds] = useState<Set<string>>(new Set());
  const [confirmingDeleteCaptureId, setConfirmingDeleteCaptureId] = useState<string | null>(null);
  const [confirmingBatchDeletePhotos, setConfirmingBatchDeletePhotos] = useState(false);
  const [deletingPhoto, setDeletingPhoto] = useState(false);
  const [deleteRawTooPhotos, setDeleteRawTooPhotos] = useState(false);
  const batchDeleteRef = useRef<HTMLButtonElement>(null);

  const { openKey: openMenuCaptureId, setOpenKey: setOpenMenuCaptureId, ref: openMenuRef } = useDropdownMenu<string>();

  function load(): Promise<void> {
    if (!id) return Promise.resolve();
    setLoadError(false);
    // Supplementary, so a failure here doesn't block the trip itself.
    api.get<TripSummary>(`/trips/${id}/summary`).then(setSummary).catch(() => {});
    return Promise.all([
      api.get<TripDetail>(`/trips/${id}`),
      api.get<{ items: TripPhoto[] }>(`/trips/${id}/photos`),
      api.get<{ items: CollectionItem[] }>(`/trips/${id}/species`),
    ])
      .then(([tripRes, photosRes, speciesRes]) => {
        setTrip(tripRes);
        setPhotos(photosRes.items);
        setSpeciesItems(speciesRes.items);
      })
      .catch(() => setLoadError(true));
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Only a scan started (or still running) here shows its outcome.
  const [scanRequested, setScanRequested] = useState(false);
  const scanJob = useJobPoll<ScanStatus>(id ? `/trips/${id}/scan/status` : null, {
    intervalMs: 1500,
    onFinish: (res) => {
      const rows: ReviewRow[] = res.newFiles.map((f) => ({
        key: f.relativePath,
        speciesId: null,
        speciesLabel: null,
        suggestions: [],
        status: "ready",
        isInspecting: true,
      }));
      setReviewRows(rows);
      void inspectRows(rows.map((r) => r.key), reviewRegionId);
      if (res.recovered > 0) void load();
    },
  });
  const scanning = scanJob.starting || !!scanJob.status?.running;
  const scanStatus = scanRequested || scanJob.status?.running ? scanJob.status : null;

  // Refreshes the trip once at the end; in between, results only drain the loading tiles.
  const importJob = useJobPoll<ImportStatus>(id ? `/trips/${id}/import/status` : null, {
    intervalMs: 1000,
    onFinish: () => {
      void load().finally(() => setPendingImports([]));
    },
  });
  const importStatus = importJob.status;
  const importing = importJob.starting || !!importStatus?.running;
  const importResults = importStatus?.running ? importStatus.results : null;
  const importedSoFar = importResults?.filter((r) => r.captureId).length ?? 0;

  // A failed file drops its loading tile right away; imported ones stay until the final refresh.
  useEffect(() => {
    if (!importResults) return;
    const failed = new Set(importResults.filter((r) => !r.captureId).map((r) => r.relativePath));
    if (failed.size === 0) return;
    setPendingImports((prev) => (prev.some((p) => failed.has(p)) ? prev.filter((p) => !failed.has(p)) : prev));
  }, [importResults]);

  const visiblePhotos = useMemo(() => {
    if (!photos) return [];
    const query = search.trim().toLowerCase();
    let filtered = query
      ? photos.filter((p) => (p.commonName ?? "").toLowerCase().includes(query) || p.scientificName.toLowerCase().includes(query))
      : photos;
    filtered = filtered
      .filter((p) => rawFilter === "any" || (rawFilter === "with" ? p.hasRaw : !p.hasRaw))
      .filter((p) => !onlyTopRated || p.qualityRating === 5)
      .filter((p) => !dateFrom || !p.takenAt || p.takenAt >= dateFrom)
      .filter((p) => !dateTo || !p.takenAt || p.takenAt <= `${dateTo}T23:59:59`);
    // The API already returns newest first. Unrated sorts as a 3, same as Gallery/Album.
    if (sortBy === "newest") return filtered;
    return [...filtered].sort((a, b) => {
      if (sortBy === "oldest") {
        return (a.takenAt ? new Date(a.takenAt).getTime() : 0) - (b.takenAt ? new Date(b.takenAt).getTime() : 0);
      }
      const ratingA = a.qualityRating ?? 3;
      const ratingB = b.qualityRating ?? 3;
      return sortBy === "ratingHigh" ? ratingB - ratingA : ratingA - ratingB;
    });
  }, [photos, search, sortBy, rawFilter, onlyTopRated, dateFrom, dateTo]);

  // rawFilter counts toward the badge only when off its default ("without"), same as Gallery.
  const activeFilterCount = (onlyTopRated ? 1 : 0) + (rawFilter !== "without" ? 1 : 0) + (dateFrom || dateTo ? 1 : 0);

  const visibleSpecies = useMemo(() => {
    if (!speciesItems) return [];
    const query = search.trim().toLowerCase();
    if (!query) return speciesItems;
    return speciesItems.filter(
      (s) => (s.commonName ?? "").toLowerCase().includes(query) || s.scientificName.toLowerCase().includes(query),
    );
  }, [speciesItems, search]);

  const slides = useMemo<LightboxSlide[]>(
    () =>
      visiblePhotos.map((p) => ({
        url: `/api/photos/${p.photoId}/display`,
        caption: `${p.commonName ?? p.scientificName}${p.takenAt ? ` · ${formatDate(p.takenAt)}` : ""}`,
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
    [visiblePhotos],
  );

  async function startScan() {
    if (!id) return;
    setScanRequested(true);
    await scanJob.start(`/trips/${id}/scan`);
  }

  // Suggestions, a keyword match from the file's tags, and the not-wildlife flag for each photo
  // (POST /trips/:id/inspect). Best-effort: a failure only means picking the species by hand.
  // A newer pass (a region change) supersedes the running one, so old-region answers can't land late.
  const inspectGenerationRef = useRef(0);
  async function inspectRows(keys: string[], regionId: string | null) {
    if (!id) return;
    const generation = ++inspectGenerationRef.current;
    const keySet = new Set(keys);
    setReviewRows((prev) => prev.map((r) => (keySet.has(r.key) ? { ...r, isInspecting: true } : r)));
    await mapWithConcurrency(keys, INSPECT_CONCURRENCY, async (key) => {
      if (generation !== inspectGenerationRef.current) return;
      try {
        const res = await api.post<{ suggestions: SuggestedSpecies[]; notWildlife: { looksLike: string } | null }>(`/trips/${id}/inspect`, {
          relativePath: key,
          regionId: suggestEnabled ? regionId : null,
        });
        if (generation !== inspectGenerationRef.current) return;
        setReviewRows((prev) =>
          prev.map((r) => (r.key === key ? { ...r, suggestions: res.suggestions, notWildlife: res.notWildlife, isInspecting: false } : r)),
        );
      } catch {
        if (generation !== inspectGenerationRef.current) return;
        setReviewRows((prev) => prev.map((r) => (r.key === key ? { ...r, isInspecting: false } : r)));
      }
    });
  }

  function selectReviewRegion(regionId: string | null) {
    setReviewRegionId(regionId);
    if (regionId) localStorage.setItem(LAST_REGION_KEY, regionId);
    else localStorage.removeItem(LAST_REGION_KEY);
    // A region picked or changed mid-batch re-checks every photo not yet imported.
    if (regionId && suggestEnabled) void inspectRows(reviewRows.filter((r) => r.status !== "done").map((r) => r.key), regionId);
  }

  // A background job: each file costs an exiftool read and a resize, too slow to await in one request.
  async function importReady() {
    if (!id) return;
    const toImport = reviewRows.filter((r) => r.speciesId && (r.status === "ready" || r.status === "error"));
    if (toImport.length === 0) return;
    const previousRows = reviewRows;
    setPendingImports(toImport.map((r) => r.key));
    setReviewRows([]);
    const started = await importJob.start(`/trips/${id}/import`, {
      files: toImport.map((r) => ({ relativePath: r.key, speciesId: r.speciesId })),
      regionId: reviewRegionId,
    });
    if (!started) {
      setPendingImports([]);
      setReviewRows(previousRows);
    }
  }

  async function setCover(captureId: string | null) {
    if (!id) return;
    setOpenMenuCaptureId(null);
    setSettingCover(captureId);
    try {
      await api.put(`/trips/${id}/cover`, { captureId });
      void load();
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't change the featured photo"));
    } finally {
      setSettingCover(null);
    }
  }

  // A new cover opens straight into the crop editor, since positioning it is the next step anyway.
  async function setCoverAndEdit(captureId: string, photoUrl: string) {
    if (!id) return;
    setOpenMenuCaptureId(null);
    setSettingCover(captureId);
    try {
      await api.put(`/trips/${id}/cover`, { captureId });
      await load();
      setCroppingCoverPhotoUrl(photoUrl);
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't change the featured photo"));
    } finally {
      setSettingCover(null);
    }
  }

  async function confirmDeletePhoto(captureId: string) {
    setDeletingPhoto(true);
    try {
      await api.delete(`/captures/${captureId}`);
      setConfirmingDeleteCaptureId(null);
      void load();
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't delete that photo"));
    } finally {
      setDeletingPhoto(false);
    }
  }

  function togglePhotoSelected(captureId: string) {
    setSelectedPhotoCaptureIds((prev) => {
      const next = new Set(prev);
      if (next.has(captureId)) next.delete(captureId);
      else next.add(captureId);
      return next;
    });
  }

  function exitGallerySelectMode() {
    setGallerySelectMode(false);
    setSelectedPhotoCaptureIds(new Set());
  }

  const selectedPhotosHaveRaw = (photos ?? []).some((p) => selectedPhotoCaptureIds.has(p.captureId) && p.hasRaw);

  async function confirmDeleteSelectedPhotos() {
    setDeletingPhoto(true);
    try {
      await api.post("/captures/batch-delete", { captureIds: [...selectedPhotoCaptureIds], deleteRaw: deleteRawTooPhotos });
      setConfirmingBatchDeletePhotos(false);
      setDeleteRawTooPhotos(false);
      exitGallerySelectMode();
      void load();
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't delete those photos"));
    } finally {
      setDeletingPhoto(false);
    }
  }

  async function patchTrip(patch: Partial<Pick<TripDetail, "name" | "description" | "coverLayout">>, failure: string) {
    if (!id) return;
    try {
      await api.patch(`/trips/${id}`, patch);
      void load();
    } catch (err) {
      toast.error(errorMessage(err, failure));
    }
  }

  function saveName(name: string) {
    if (name) void patchTrip({ name }, "Couldn't rename this trip");
  }

  function saveDescription(description: string) {
    void patchTrip({ description }, "Couldn't save the description");
  }

  function setCoverLayout(coverLayout: "single" | "quad") {
    void patchTrip({ coverLayout }, "Couldn't change the cover style");
  }

  async function relocateFolder(which: "sourceFolder" | "destinationFolder") {
    if (!id) return;
    setRelocateError(null);
    const native = await pickFolderNative();
    if (native === undefined) {
      setRelocating(which);
      return;
    }
    if (!native) return;
    await applyRelocate(which, native);
  }

  async function applyRelocate(which: "sourceFolder" | "destinationFolder", folder: string) {
    if (!id) return;
    setRelocating(null);
    setRelocateError(null);
    try {
      await api.patch(`/trips/${id}`, { [which]: folder });
      void load();
      // A rescan relinks every existing photo by content hash (see scan.ts).
      void startScan();
    } catch (err) {
      setRelocateError(errorMessage(err, "Couldn't relocate this trip's folder"));
    }
  }

  const readyCount = reviewRows.filter((r) => r.speciesId && r.status === "ready").length;
  const notWildlifeCount = reviewRows.filter((r) => r.notWildlife && !r.speciesId).length;
  const review = useImportReview(reviewRows, setReviewRows, {
    onAllAssignedEnter: () => void importReady(),
    enterStartsImport: !importing && readyCount > 0,
  });
  const { selected, setSelected, toggleSelected, focusedRowKey, setFocusedRowKey, activeRow, highlightIndex, assignSpecies, assignAndAdvance } = review;

  if (loadError) {
    return (
      <div className="flex flex-col items-center gap-3 py-24">
        <p className="text-muted">Couldn't load this trip.</p>
        <button onClick={() => void load()} className="text-sm text-ink underline">
          Retry
        </button>
      </div>
    );
  }
  if (!trip || !photos || !speciesItems) return <LoadingScreen />;

  type GridItem = { kind: "placeholder"; key: string } | { kind: "photo"; photo: TripPhoto; photoIndex: number };
  const gridItems: GridItem[] = [
    ...pendingImports.map((relativePath): GridItem => ({ kind: "placeholder", key: relativePath })),
    ...visiblePhotos.map((photo, photoIndex): GridItem => ({ kind: "photo", photo, photoIndex })),
  ];

  return (
    <div className="flex-1 bg-canvas">
      <PageHeader
        sticky
        title={
          <EditableTextField value={trip.name} onSave={saveName} className="text-lg font-semibold text-ink" />
        }
        backFallbackTo="/trips"
        backLabel="Trips"
        actions={
          <div className="flex items-center gap-4">
            <div className="flex rounded-md border border-line text-sm">
              <button
                onClick={() => setView("gallery")}
                className={`rounded-l-md px-3 py-1.5 ${view === "gallery" ? "bg-accent text-accent-fg" : "text-muted hover:bg-surface-muted"}`}
              >
                Gallery
              </button>
              <button
                onClick={() => setView("species")}
                className={`rounded-r-md px-3 py-1.5 ${view === "species" ? "bg-accent text-accent-fg" : "text-muted hover:bg-surface-muted"}`}
              >
                Species view
              </button>
            </div>
            {view === "gallery" && photos.length > 0 && (
              <>
                <Select label="Sort" value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}>
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                  <option value="ratingHigh">Highest rated first</option>
                  <option value="ratingLow">Lowest rated first</option>
                </Select>
                <FilterPopover activeCount={activeFilterCount}>
                  <div className="space-y-2.5">
                    <label className="flex items-center gap-1.5 text-xs text-ink">
                      <input type="checkbox" checked={onlyTopRated} onChange={(e) => setOnlyTopRated(e.target.checked)} className="accent-ink" />
                      Top rated
                    </label>
                    <div>
                      <FilterFieldLabel>RAW files</FilterFieldLabel>
                      <SegmentedControl
                        value={rawFilter}
                        onChange={setRawFilter}
                        options={[
                          { value: "any", label: "Any" },
                          { value: "with", label: "With" },
                          { value: "without", label: "Without" },
                        ]}
                      />
                    </div>
                    <div>
                      <FilterFieldLabel>Date</FilterFieldLabel>
                      {dateRangeOpen || dateFrom || dateTo ? (
                        <div className="flex items-center gap-1.5">
                          <input
                            type="date"
                            value={dateFrom}
                            max={dateTo || undefined}
                            onChange={(e) => setDateFrom(e.target.value)}
                            className="w-full rounded-md border border-line px-1.5 py-1 text-xs text-ink"
                            aria-label="From date"
                          />
                          <span className="text-xs text-muted">to</span>
                          <input
                            type="date"
                            value={dateTo}
                            min={dateFrom || undefined}
                            onChange={(e) => setDateTo(e.target.value)}
                            className="w-full rounded-md border border-line px-1.5 py-1 text-xs text-ink"
                            aria-label="To date"
                          />
                        </div>
                      ) : (
                        <button
                          onClick={() => setDateRangeOpen(true)}
                          className="w-full rounded-md border border-line px-1.5 py-1 text-left text-xs text-muted hover:bg-surface-muted"
                        >
                          Any date
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="space-y-1.5 border-t border-line pt-2.5">
                    <label className="flex items-center gap-1.5 text-xs text-ink">
                      <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} className="accent-ink" />
                      Labels
                    </label>
                  </div>
                </FilterPopover>
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
                <SelectModeToggle active={gallerySelectMode} onEnter={() => setGallerySelectMode(true)} onExit={exitGallerySelectMode} />
              </>
            )}
            <Button variant="secondary" size="sm" onClick={startScan} disabled={scanning}>
              {scanning ? "Looking for photos…" : "Add more photos"}
            </Button>
          </div>
        }
      >
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted">
          <span className="shrink-0">Trip folder:</span>
          <span className="min-w-0 truncate" title={trip.sourceFolder}>
            {trip.sourceFolder}
          </span>
          <button onClick={() => relocateFolder("sourceFolder")} className="shrink-0 underline hover:text-ink">
            Relocate…
          </button>
          <InfoTip paragraphs={RELOCATE_INFO_PARAGRAPHS} className="shrink-0" />
          <span className="shrink-0">· {pluralize(photos.length + importedSoFar, "photo")}</span>
        </div>
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted">
          <span className="shrink-0">Wildlife saved to:</span>
          <span className="min-w-0 truncate" title={trip.destinationFolder}>
            {trip.destinationFolder}
          </span>
          <button onClick={() => relocateFolder("destinationFolder")} className="shrink-0 underline hover:text-ink">
            Relocate…
          </button>
        </div>
        {summary && summary.speciesCount > 0 && (
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
            <span>
              <span className="font-medium text-ink">{summary.speciesCount}</span> species
            </span>
            {summary.liferCount > 0 && (
              <span>
                <span className="font-medium text-ink">{summary.liferCount}</span> {summary.liferCount === 1 ? "lifer" : "lifers"}
              </span>
            )}
            {summary.rareCount > 0 && (
              <span>
                <span className="font-medium text-ink">{summary.rareCount}</span> rare/legendary
              </span>
            )}
            {summary.endemicCount > 0 && (
              <span>
                <span className="font-medium text-ink">{summary.endemicCount}</span> endemic
              </span>
            )}
          </div>
        )}
        <div className="mt-2 w-full">
          <EditableTextField
            value={trip.description ?? ""}
            onSave={saveDescription}
            placeholder="Add a description…"
            className="text-sm text-ink"
            multiline
          />
        </div>
      </PageHeader>

      {relocating && (
        <div className="border-b border-line bg-surface px-6 py-3">
          <FolderBrowser onChoose={(folder) => applyRelocate(relocating, folder)} onCancel={() => setRelocating(null)} />
        </div>
      )}

      <div className="flex items-center gap-3 border-b border-line bg-surface px-6 py-2 text-sm">
        <SearchInput value={search} onChange={setSearch} placeholder="Search this trip's species…" className="w-56" />
      </div>

      {gallerySelectMode && (
        <div className="flex items-center justify-between border-b border-line bg-surface-muted px-6 py-2 text-xs">
          <span className="text-muted">{selectedPhotoCaptureIds.size} selected</span>
          <Button variant="danger" size="sm" onClick={() => setConfirmingBatchDeletePhotos(true)} disabled={selectedPhotoCaptureIds.size === 0}>
            Delete selected
          </Button>
        </div>
      )}

      <main className="space-y-6 p-6">
        <FormMessage error={relocateError ?? scanJob.actionError ?? importJob.actionError} />
        {scanStatus?.running && (
          <JobProgress
            status={scanStatus}
            phases={SCAN_PHASES}
            fallbackLabel="Looking for photos…"
            onCancel={() => void scanJob.cancel(`/trips/${id}/scan/cancel`)}
            cancelling={scanJob.cancelling}
          />
        )}
        {importStatus?.running && (
          <JobProgress
            status={importStatus}
            phases={IMPORT_PHASES}
            onCancel={() => void importJob.cancel(`/trips/${id}/import/cancel`)}
            cancelling={importJob.cancelling}
          />
        )}
        {scanStatus && !scanning && scanStatus.finishedAt && reviewRows.length === 0 && (
          <p className="text-sm text-muted">
            {scanStatus.cancelled
              ? "Scan cancelled."
              : scanStatus.recovered === 0 && scanStatus.relinked === 0 && scanStatus.markedStale === 0 && scanStatus.rawsLinked === 0
                ? "No new photos found."
                : ""}
            {scanStatus.recovered > 0 && ` ${pluralize(scanStatus.recovered, "photo")} automatically recovered.`}
            {scanStatus.relinked > 0 && ` ${pluralize(scanStatus.relinked, "moved file")} relinked.`}
            {scanStatus.markedStale > 0 && ` ${scanStatus.markedStale} missing (kept, marked stale).`}
            {scanStatus.rawsLinked > 0 && ` ${pluralize(scanStatus.rawsLinked, "RAW file")} linked.`}
            {scanStatus.error && <span className="text-rose-700 dark:text-rose-400"> {scanStatus.error}</span>}
          </p>
        )}

        {reviewRows.length > 0 && (
          <section className="space-y-3 rounded-lg border border-line bg-surface p-4">
            <div className="flex items-center gap-3 text-sm text-muted">
              <span>
                {pluralize(reviewRows.length, "new photo")} · {readyCount} ready to import
                {notWildlifeCount > 0 && ` · ${notWildlifeCount} not wildlife, left out`}
              </span>
              {selected.size > 0 && (
                <div className="flex items-center gap-2">
                  <span>Assign {selected.size} selected to:</span>
                  <div className="w-56">
                    <SpeciesPicker
                      placeholder="Type a species…"
                      regionId={reviewRegionId}
                      onSelect={(r) => {
                        assignSpecies([...selected], r);
                        setSelected(new Set());
                      }}
                    />
                  </div>
                </div>
              )}
              <Button size="sm" onClick={importReady} disabled={importing || readyCount === 0} className="ml-auto">
                {importing ? "Importing…" : readyCount ? `Import ${pluralize(readyCount, "photo")}` : "Import photos"}
              </Button>
            </div>
            <div className="rounded-lg border border-line bg-surface-muted px-3 py-2">
              <p className="mb-1 text-sm text-muted">
                {suggestEnabled ? "Region for species suggestions (also saved as each photo's location):" : "Location for this batch (optional):"}
              </p>
              <RegionBrowser regionId={reviewRegionId} onChange={selectReviewRegion} allowAnyRegion={!suggestEnabled} />
              {suggestEnabled && !reviewRegionId && <p className="mt-1 text-xs text-muted">Pick a region to see species suggestions below.</p>}
            </div>
            {trip && (
              <p className="text-xs text-muted">
                Imported photos are copied to {trip.destinationFolder}, sorted by species. The originals stay where they are.
              </p>
            )}

            <div className="divide-y divide-line rounded-lg border border-line bg-surface">
              {reviewRows.map((row) => (
                <ImportReviewRow
                  key={row.key}
                  row={row}
                  name={row.key}
                  preview={
                    <img
                      src={`/api/trips/${id}/scan-preview?file=${encodeURIComponent(row.key)}`}
                      alt=""
                      loading="lazy"
                      className="h-14 w-14 rounded-md object-cover"
                    />
                  }
                  status={
                    <span className="text-xs text-muted">
                      {row.status === "done" ? "✓ Imported" : row.status === "error" ? row.error : row.status === "importing" ? "Importing…" : ""}
                    </span>
                  }
                  removable={row.status !== "importing" && row.status !== "done"}
                  onRemove={() => {
                    setReviewRows((prev) => prev.filter((r) => r.key !== row.key));
                    review.forgetRow(row.key);
                  }}
                  removeLabel="Leave this photo out of the import"
                  selected={selected.has(row.key)}
                  onToggleSelected={() => toggleSelected(row.key)}
                  focused={focusedRowKey === row.key}
                  onFocus={() => setFocusedRowKey(row.key)}
                  regionId={reviewRegionId}
                  onPick={(r) => assignAndAdvance(row.key, r)}
                  isActive={row.key === activeRow?.key}
                  highlightIndex={highlightIndex}
                  onDismissWarning={(warning) => review.dismissWarning(row.key, warning)}
                  onViewSpeciesGallery={speciesGallery.open}
                />
              ))}
            </div>
            {speciesGallery.lightbox}
          </section>
        )}

        {view === "species" ? (
          visibleSpecies.length === 0 ? (
            <p className="text-muted">{search ? `No species match "${search}".` : "No species collected on this trip yet."}</p>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
              {visibleSpecies.map((item) => (
                <SpeciesCard key={item.speciesId} item={item} backLabel={trip?.name} showVolumeBadge={multiDriveInUse} />
              ))}
            </div>
          )
        ) : photos.length === 0 && pendingImports.length === 0 && buildMode ? (
          <div className="max-w-2xl space-y-3 rounded-lg border border-line bg-surface p-4">
            <p className="text-sm text-ink">Drop in this trip's photos, then assign each one to a species below.</p>
            <PhotoImportRows tripId={id} onImported={() => void load()} />
            <div className="border-t border-line pt-3">
              {/* matchOnly ignores speciesId: the matched trip photo decides each RAW's species. */}
              <RawUpload speciesId="" volumeId="" matchOnly onFiled={() => void load()} />
            </div>
            <p className="text-xs text-muted">
              Prefer to organize the folder yourself first? Use "Add more photos" above to scan it instead.
            </p>
          </div>
        ) : photos.length === 0 && pendingImports.length === 0 ? (
          <EmptyState
            icon={
              <svg viewBox="0 0 24 24" className="h-6 w-6 text-muted" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 15.5V5.5A2 2 0 0 1 5 3.5h10" />
                <rect x="6" y="6" width="14" height="14" rx="2" />
              </svg>
            }
            title="Nothing imported yet"
            description={
              reviewRows.length === 0
                ? "Scan this trip's folder to bring in what's there."
                : "Assign a species to each photo above, then import."
            }
            action={reviewRows.length === 0 ? { label: scanning ? "Looking for photos…" : "Add more photos", onClick: startScan } : undefined}
          />
        ) : visiblePhotos.length === 0 && pendingImports.length === 0 ? (
          <p className="text-muted">No photos match "{search}".</p>
        ) : (
          <>
            <div className="mb-4 flex items-center gap-2 text-sm text-muted">
              Cover style
              <button
                onClick={() => setCoverLayout("single")}
                className={`rounded-md border px-2 py-1 text-xs ${
                  trip.coverLayout === "single" ? "border-ink bg-surface-muted text-ink" : "border-line hover:bg-surface-muted"
                }`}
              >
                Single photo
              </button>
              <button
                onClick={() => setCoverLayout("quad")}
                className={`rounded-md border px-2 py-1 text-xs ${
                  trip.coverLayout === "quad" ? "border-ink bg-surface-muted text-ink" : "border-line hover:bg-surface-muted"
                }`}
              >
                Quad grid
              </button>
            </div>
            <MasonryGrid
            items={gridItems}
            columnWidth={thumbSizePx}
            extraHeightPx={showLabels ? 19 : 0}
            keyFor={(gi) => (gi.kind === "placeholder" ? `pending-${gi.key}` : gi.photo.photoId)}
            aspectRatioFor={(gi) =>
              gi.kind === "photo" && gi.photo.width && gi.photo.height ? gi.photo.width / gi.photo.height : null
            }
            renderItem={(gi, aspectRatio) => {
              if (gi.kind === "placeholder") {
                // Still being processed (EXIF read, thumbnails).
                return (
                  <div className="flex aspect-square w-full items-center justify-center rounded-md bg-surface-muted">
                    <InlineSpinner size="md" label="Importing" />
                  </div>
                );
              }
              const { photo, photoIndex } = gi;
              const isCover = trip.coverCaptureId === photo.captureId;
              return (
                <PhotoTile
                  key={photo.photoId}
                  photoId={photo.photoId}
                  alt={photo.commonName ?? photo.scientificName}
                  onOpen={() => setLightboxIndex(photoIndex)}
                  selectMode={gallerySelectMode}
                  selected={selectedPhotoCaptureIds.has(photo.captureId)}
                  aspectRatio={aspectRatio}
                  onToggleSelect={() => togglePhotoSelected(photo.captureId)}
                  menuOpen={openMenuCaptureId === photo.captureId}
                  onToggleMenu={() => setOpenMenuCaptureId(openMenuCaptureId === photo.captureId ? null : photo.captureId)}
                  menuRef={openMenuRef}
                  menuContent={
                    <div className="absolute right-0 top-full z-10 mt-1 whitespace-nowrap rounded-md border border-line bg-surface py-1 text-xs shadow-lg">
                      <Link
                        to={`/species/${photo.speciesId}`}
                        onClick={() => setOpenMenuCaptureId(null)}
                        className="block w-full px-3 py-1.5 text-left text-ink hover:bg-surface-muted"
                      >
                        View species
                      </Link>
                      <button
                        onClick={() =>
                          isCover
                            ? setCover(null)
                            : setCoverAndEdit(photo.captureId, `/api/photos/${photo.photoId}/display`)
                        }
                        disabled={settingCover === photo.captureId}
                        className="block w-full px-3 py-1.5 text-left text-ink hover:bg-surface-muted"
                      >
                        {isCover ? "Featured photo ✓" : "Set as featured photo"}
                      </button>
                      {isCover && trip.coverLayout === "single" && (
                        <button
                          onClick={() => {
                            setOpenMenuCaptureId(null);
                            setCroppingCoverPhotoUrl(`/api/photos/${photo.photoId}/display`);
                          }}
                          className="block w-full px-3 py-1.5 text-left text-ink hover:bg-surface-muted"
                        >
                          Adjust position
                        </button>
                      )}
                      {/* Hidden when the only original is the RAW, which Download RAW covers. */}
                      {photo.originalRef && photo.originalKind !== "raw" && (
                        <button
                          onClick={() => {
                            setOpenMenuCaptureId(null);
                            downloadFile(`/api/photos/${photo.photoId}/original?download=1`, "original.jpg");
                          }}
                          className="block w-full px-3 py-1.5 text-left text-ink hover:bg-surface-muted"
                        >
                          Download original
                        </button>
                      )}
                      {photo.hasRaw && (
                        <button
                          onClick={() => {
                            setOpenMenuCaptureId(null);
                            downloadFile(`/api/photos/${photo.photoId}/original-raw?download=1`, "original.raw");
                          }}
                          className="block w-full px-3 py-1.5 text-left text-ink hover:bg-surface-muted"
                        >
                          Download RAW
                        </button>
                      )}
                      <button
                        onClick={() => {
                          setOpenMenuCaptureId(null);
                          setConfirmingDeleteCaptureId(photo.captureId);
                        }}
                        className="block w-full px-3 py-1.5 text-left text-rose-700 hover:bg-surface-muted dark:text-rose-400"
                      >
                        Delete photo
                      </button>
                    </div>
                  }
                  label={
                    showLabels && (
                      <p className="mt-1 truncate text-[11px] text-muted">{photo.commonName ?? photo.scientificName}</p>
                    )
                  }
                />
              );
            }}
          />
          </>
        )}
      </main>

      {lightboxIndex !== null && (
        <Lightbox slides={slides} index={lightboxIndex} onIndexChange={setLightboxIndex} onClose={() => setLightboxIndex(null)} />
      )}

      {croppingCoverPhotoUrl && (
        <CardCropEditor
          photoUrl={croppingCoverPhotoUrl}
          initialX={trip.coverCropX}
          initialY={trip.coverCropY}
          initialSize={trip.coverCropSize}
          onClose={() => setCroppingCoverPhotoUrl(null)}
          onSave={async (crop) => {
            await api.patch(`/trips/${id}/cover-crop`, crop);
            void load();
          }}
          onReset={async () => {
            await api.patch(`/trips/${id}/cover-crop`, { reset: true });
            void load();
          }}
        />
      )}

      <ConfirmDialog
        open={!!confirmingDeleteCaptureId}
        title="Delete this photo?"
        message="Deleted photos go to Trash for 7 days first, where you can still restore them. After 7 days they're gone for good and can't be recovered."
        confirmLabel="Delete"
        danger
        busy={deletingPhoto}
        onConfirm={() => confirmingDeleteCaptureId && void confirmDeletePhoto(confirmingDeleteCaptureId)}
        onCancel={() => setConfirmingDeleteCaptureId(null)}
      />

      <Modal
        open={confirmingBatchDeletePhotos}
        onClose={() => {
          if (deletingPhoto) return;
          setConfirmingBatchDeletePhotos(false);
          setDeleteRawTooPhotos(false);
        }}
        title={`Delete ${pluralize(selectedPhotoCaptureIds.size, "photo")}?`}
        initialFocusRef={batchDeleteRef}
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              disabled={deletingPhoto}
              onClick={() => {
                setConfirmingBatchDeletePhotos(false);
                setDeleteRawTooPhotos(false);
              }}
            >
              Cancel
            </Button>
            <Button ref={batchDeleteRef} variant="danger" size="sm" onClick={confirmDeleteSelectedPhotos} loading={deletingPhoto}>
              Delete
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">
          Deleted photos go to Trash for 7 days first, where you can still restore them. After 7 days they're gone for good and can't
          be recovered.
        </p>
        {selectedPhotosHaveRaw && (
          <label className="mt-3 flex items-center gap-2 text-xs text-ink">
            <input type="checkbox" checked={deleteRawTooPhotos} onChange={(e) => setDeleteRawTooPhotos(e.target.checked)} className="h-3.5 w-3.5" />
            Also delete the matching RAW file when this is permanently removed
          </label>
        )}
      </Modal>
    </div>
  );
}
