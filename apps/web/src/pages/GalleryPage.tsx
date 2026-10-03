import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useSearchParams, useNavigate, Link } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { errorMessage } from "../lib/errorMessage";
import Lightbox, { photoFilePaths, TagEditor, type LightboxSlide } from "../components/Lightbox";
import { Spinner } from "../components/LoadingScreen";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import MasonryGrid from "../components/MasonryGrid";
import PhotoTile from "../components/PhotoTile";
import AddToAlbumButton from "../components/AddToAlbumButton";
import AddToAlbumModal from "../components/AddToAlbumModal";
import SpeciesPicker from "../components/SpeciesPicker";
import StarRating from "../components/StarRating";
import Modal from "../components/Modal";
import Button from "../components/Button";
import FormMessage from "../components/FormMessage";
import InlineSpinner from "../components/InlineSpinner";
import { usePhotoGridSize } from "../hooks/usePhotoGridSize";
import { useSelectMode } from "../hooks/useSelectMode";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { isTauri } from "../lib/tauri";
import { useEnterToConfirm } from "../hooks/useEnterToConfirm";
import { useDeploymentMode, useIsTauri } from "../hooks/useDeploymentMode";
import { useShowLabels } from "../hooks/useShowLabels";
import { useSettings } from "../hooks/useSettings";
import { useToast } from "../hooks/useToast";
import { shotDataLine, estimateShotDataWrapExtraPx } from "../lib/shotData";
import { formatDate } from "../lib/formatDate";
import { pluralize } from "../lib/pluralize";
import { ALL_TAXON_CLASSES, taxonDisplayLabel } from "@lifer/shared";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import Pill from "../components/Pill";
import Select from "../components/Select";
import SearchInput from "../components/SearchInput";
import RegionBrowser from "../components/RegionBrowser";
import FilterPopover, { FilterGroupLabel, FilterFieldLabel } from "../components/FilterPopover";
import SegmentedControl from "../components/SegmentedControl";
import SelectModeToggle from "../components/SelectModeToggle";
import { usePersistedState } from "../hooks/usePersistedState";
import { downloadFile } from "../lib/downloadFile";

// Matches the API's UNCATEGORIZED_REGION_ID sentinel (gallery/routes.ts): captures with no region.
const UNCATEGORIZED_REGION_ID = "uncategorized";
// Per-line heights of the optional caption rows, so MasonryGrid reserves room for them.
const LABEL_LINE_HEIGHT_PX = 19;
const RATING_LINE_HEIGHT_PX = 18;
const CAMERA_INFO_LINE_HEIGHT_PX = 13;
const EMPTY_SET: ReadonlySet<string> = new Set();
// The plain listing loads in pages as you scroll; catch-up loads (select all, keep place on a
// reload) use the server's largest page.
const PAGE_SIZE = 200;
const CATCH_UP_PAGE_SIZE = 500;

function anySelectedIn(ids: ReadonlySet<string> | undefined, selected: ReadonlySet<string>): boolean {
  if (!ids) return false;
  for (const id of ids) if (selected.has(id)) return true;
  return false;
}

// Appends the photos not already present (a page can overlap after a local delete or reload).
function appendNew(prev: GalleryItem[], extra: GalleryItem[]): GalleryItem[] {
  if (extra.length === 0) return prev;
  const seen = new Set(prev.map((it) => it.photoId));
  const fresh = extra.filter((it) => !seen.has(it.photoId));
  return fresh.length === 0 ? prev : [...prev, ...fresh];
}

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
  regionId: string | null;
  regionName: string | null;
  kind: "image" | "video";
  durationSeconds: number | null;
  tags: string[];
  isFeatured: boolean;
  hasRawOriginal: boolean;
  originalRef: string | null;
  originalManaged: boolean | null;
  originalKind: string | null;
  rawRef: string | null;
}

interface SearchInterpretation {
  species: string[];
  groups: string[];
  places: string[];
  dates: string[];
  description: string | null;
}

type SearchResponse = { items: GalleryItem[]; interpretation?: SearchInterpretation; pending?: boolean };
// total only comes with the first page.
type GalleryPageResponse = { items: GalleryItem[]; nextCursor: string | null; total?: number };
type ContextAnchor = { photoId: string; x: number; y: number };

// "ducks · Washington · 2024 · looks like “swimming”". Null when there's nothing beyond the query.
function describeSearchReading(i: SearchInterpretation | undefined): string | null {
  if (!i) return null;
  const subject = [...i.species.slice(0, 3), ...(i.species.length > 3 ? [`+${i.species.length - 3} more`] : []), ...i.groups];
  const parts = [subject.join(", "), ...i.places, ...i.dates].filter(Boolean);
  if (parts.length === 0) return null;
  if (i.description) parts.push(`looks like “${i.description}”`);
  return parts.join(" · ");
}

function itemShotData(item: GalleryItem): string | null {
  return shotDataLine({
    camera_model: item.cameraModel,
    lens: item.lens,
    focal_length_mm: item.focalLengthMm,
    aperture: item.aperture,
    shutter: item.shutter,
    iso: item.iso,
  });
}

function toggleInSet(prev: Set<string>, value: string): Set<string> {
  const next = new Set(prev);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

const MENU_ITEM = "block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted";

// Memoized so a selection, rating or menu change only re-renders the tiles it touches. Every
// callback takes ids/indices so the page can pass the same function to every tile.
const GalleryTile = memo(function GalleryTile({
  item,
  index,
  aspectRatio,
  cornerRadiusPx,
  selectMode,
  selected,
  menuOpen,
  contextMenuAnchor,
  menuContent,
  menuRef,
  shotLine,
  showLabels,
  showRatings,
  showCameraInfo,
  missingDate,
  savingDate,
  onOpen,
  onToggleSelect,
  onDragStart,
  onDragEnter,
  onToggleMenu,
  onOpenContextMenu,
  onRate,
  onSetTakenAt,
}: {
  item: GalleryItem;
  index: number;
  aspectRatio: number;
  cornerRadiusPx: number;
  selectMode: boolean;
  selected: boolean;
  menuOpen: boolean;
  contextMenuAnchor: ContextAnchor | null;
  // Null for closed tiles: keeps the trigger without building their panels.
  menuContent: ReactNode | null;
  menuRef: RefObject<HTMLDivElement | null>;
  shotLine: string | null;
  showLabels: boolean;
  showRatings: boolean;
  showCameraInfo: boolean;
  missingDate: boolean;
  savingDate: boolean;
  onOpen: (index: number) => void;
  onToggleSelect: (captureId: string, index: number, shiftKey: boolean) => void;
  onDragStart: (index: number) => void;
  onDragEnter: (index: number) => void;
  onToggleMenu: (photoId: string) => void;
  onOpenContextMenu: (photoId: string, point: { x: number; y: number }) => void;
  onRate: (captureId: string, rating: number | null) => void;
  onSetTakenAt: (captureId: string, value: string) => void;
}) {
  return (
    <PhotoTile
      photoId={item.photoId}
      alt={item.commonName ?? item.scientificName}
      kind={item.kind}
      durationSeconds={item.durationSeconds}
      onOpen={() => onOpen(index)}
      selectMode={selectMode}
      selected={selected}
      onToggleSelect={(shiftKey) => onToggleSelect(item.captureId, index, shiftKey)}
      onDragSelectStart={() => onDragStart(index)}
      onDragSelectEnter={() => onDragEnter(index)}
      aspectRatio={aspectRatio}
      cornerRadiusPx={cornerRadiusPx}
      menuOpen={menuOpen && !contextMenuAnchor}
      onToggleMenu={() => onToggleMenu(item.photoId)}
      menuRef={menuRef}
      onOpenContextMenu={(point) => onOpenContextMenu(item.photoId, point)}
      contextMenuOpen={menuOpen && !!contextMenuAnchor}
      contextMenuAnchor={contextMenuAnchor}
      menuContent={menuContent}
      label={
        <>
          {showLabels && <p className="mt-1 truncate text-[11px] text-muted">{item.commonName ?? item.scientificName}</p>}
          {showRatings && (
            // Tighter under a name so the two read as one caption.
            <div className={showLabels ? "mt-0.5" : "mt-1"}>
              <StarRating rating={item.qualityRating} onRate={(rating) => onRate(item.captureId, rating)} />
            </div>
          )}
          {showCameraInfo && shotLine && <p className="text-[9px] text-muted">{shotLine}</p>}
          {missingDate && (
            <input
              type="date"
              disabled={savingDate}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => e.target.value && onSetTakenAt(item.captureId, e.target.value)}
              className="mt-1 w-full rounded border border-line bg-surface px-1.5 py-0.5 text-[11px] text-ink disabled:opacity-50"
            />
          )}
        </>
      }
    />
  );
});

// Every photo across all species, as one browsable, filterable, searchable masonry grid.
export default function GalleryPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [items, setItems] = useState<GalleryItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Null once the plain listing is fully loaded (and always for a search, which answers at once).
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  // Every photo the plain listing's filters match, loaded or not.
  const [total, setTotal] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const nextCursorRef = useRef(nextCursor);
  nextCursorRef.current = nextCursor;
  const loadingMoreRef = useRef(false);
  // The listing's filters and sort, resent unchanged with every cursor (the cursor encodes the sort).
  const listingParamsRef = useRef<URLSearchParams | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  // How the server read the current search, shown next to the result count.
  const [searchReading, setSearchReading] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [thumbSizePx, updateThumbSize] = usePhotoGridSize();
  // Gap and corner radius scale with thumbnail size so chrome doesn't dominate small tiles.
  const gridGapPx = Math.round(Math.min(8, Math.max(3, thumbSizePx / 30)));
  const gridCornerRadiusPx = Math.round(Math.min(8, Math.max(2, thumbSizePx / 40)));
  const [showCameraInfo, setShowCameraInfo] = usePersistedState("galleryShowCameraInfo", false);
  const [showLabels, setShowLabels] = useShowLabels();
  const [showRatings, setShowRatings] = usePersistedState("galleryShowRatings", false);
  const [groupByRegion, setGroupByRegion] = usePersistedState("galleryGroupByRegion", false);
  // Camera info wraps per photo, so it adds its second line through extraHeightPxFor below.
  const extraHeightPx =
    (showLabels ? LABEL_LINE_HEIGHT_PX : 0) + (showRatings ? RATING_LINE_HEIGHT_PX : 0) + (showCameraInfo ? CAMERA_INFO_LINE_HEIGHT_PX : 0);
  const [onlyTopRated, setOnlyTopRated] = useState(false);
  const [onlyFeatured, setOnlyFeatured] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  // From Stats' "Missing date" row. Read once: fixing a date drops the item locally.
  const [missingDate] = useState(() => searchParams.get("missingDate") === "1");
  // ?select=1&albumId=X turns the page into an "add photos to this album" picker.
  const startInSelectMode = searchParams.get("select") === "1";
  const targetAlbumId = searchParams.get("albumId");
  const [targetAlbumName, setTargetAlbumName] = useState<string | null>(null);
  useEffect(() => {
    if (!targetAlbumId) return;
    api.get<{ name: string }>(`/albums/${targetAlbumId}`).then((res) => setTargetAlbumName(res.name)).catch(() => {});
  }, [targetAlbumId]);
  const [selectedTaxa, setSelectedTaxa] = useState<Set<string>>(new Set());
  // Persisted browsing presets; "without RAW, photos only" is the neutral default.
  const [rawFilter, setRawFilter] = usePersistedState<"any" | "with" | "without">("galleryRawFilter", "without");
  const excludeHasRaw = rawFilter === "without";
  const onlyHasRaw = rawFilter === "with";
  const [mediaFilter, setMediaFilter] = usePersistedState<"both" | "photos" | "videos">("galleryMediaFilter", "photos");
  const onlyVideo = mediaFilter === "videos";
  const excludeVideo = mediaFilter === "photos";
  // Only offer the media filter when the library has a video at all.
  const [hasVideoInLibrary, setHasVideoInLibrary] = useState(false);
  useEffect(() => {
    api.get<{ hasVideo: boolean }>("/gallery/has-video").then((res) => setHasVideoInLibrary(res.hasVideo)).catch(() => {});
  }, []);
  // Taxa the library actually has, so the taxon filter never offers an empty choice. An empty set
  // also means the library has no photos at all.
  const [availableTaxa, setAvailableTaxa] = useState<Set<string> | null>(null);
  useEffect(() => {
    api.get<{ taxa: string[] }>("/gallery/taxa").then((res) => setAvailableTaxa(new Set(res.taxa))).catch(() => {});
  }, []);
  // Other Taxa classes (e.g. "insecta") get their own pills beside the built-in classes.
  const otherTaxaClasses = useMemo(
    () => [...(availableTaxa ?? [])].filter((tc) => !(ALL_TAXON_CLASSES as string[]).includes(tc)).sort(),
    [availableTaxa],
  );
  const { settings } = useSettings();
  const namingStyles = settings?.speciesNamingStyles ?? [];
  // Region filter offers only regions that have photos.
  const [regionsWithPhotos, setRegionsWithPhotos] = useState<Set<string> | null>(null);
  useEffect(() => {
    api.get<{ regionIds: string[] }>("/gallery/regions-with-photos").then((res) => setRegionsWithPhotos(new Set(res.regionIds))).catch(() => {});
  }, []);
  // YYYY-MM-DD; the server treats dateTo as inclusive.
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [dateRangeOpen, setDateRangeOpen] = useState(false);
  const [regionId, setRegionId] = useState<string | null>(null);
  // Seeded from ?tag=X (e.g. Manage tags' photo counts).
  const [tag, setTag] = useState<string | null>(() => searchParams.get("tag"));
  // From the palette's "search this trip/album": ?tripId= or ?inAlbum= (albumId is the add-photos picker).
  const [scopeTrip, setScopeTrip] = useState<{ id: string; name: string | null } | null>(() => {
    const id = searchParams.get("tripId");
    return id ? { id, name: null } : null;
  });
  const [scopeAlbum, setScopeAlbum] = useState<{ id: string; name: string | null } | null>(() => {
    const id = searchParams.get("inAlbum");
    return id ? { id, name: null } : null;
  });
  const scopeTripId = scopeTrip?.id ?? null;
  const scopeAlbumId = scopeAlbum?.id ?? null;
  useEffect(() => {
    if (!scopeTripId) return;
    api
      .get<{ name: string }>(`/trips/${scopeTripId}`)
      .then((res) => setScopeTrip((prev) => (prev?.id === scopeTripId ? { ...prev, name: res.name } : prev)))
      .catch(() => {});
  }, [scopeTripId]);
  useEffect(() => {
    if (!scopeAlbumId) return;
    api
      .get<{ name: string }>(`/albums/${scopeAlbumId}`)
      .then((res) => setScopeAlbum((prev) => (prev?.id === scopeAlbumId ? { ...prev, name: res.name } : prev)))
      .catch(() => {});
  }, [scopeAlbumId]);
  function clearScope(kind: "trip" | "album") {
    if (kind === "trip") setScopeTrip(null);
    else setScopeAlbum(null);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(kind === "trip" ? "tripId" : "inAlbum");
        return next;
      },
      { replace: true },
    );
  }
  const [sortBy, setSortBy] = usePersistedState<"newest" | "oldest" | "ratingHigh" | "ratingLow">("gallerySortBy", "newest");
  // Presets off their default count too: the badge answers "why am I seeing fewer photos".
  const activeFilterCount =
    (onlyTopRated ? 1 : 0) +
    (onlyFeatured ? 1 : 0) +
    (mediaFilter !== "photos" ? 1 : 0) +
    (rawFilter !== "without" ? 1 : 0) +
    (selectedTaxa.size > 0 ? 1 : 0) +
    (dateFrom || dateTo ? 1 : 0) +
    (regionId ? 1 : 0) +
    (tag ? 1 : 0) +
    (scopeTripId ? 1 : 0) +
    (scopeAlbumId ? 1 : 0);
  // The query lives in ?q= so back navigation restores it.
  const [searchInput, setSearchInput] = useState(() => searchParams.get("q") ?? "");
  // Debounced copy of searchInput that is actually sent.
  const [searchQuery, setSearchQuery] = useState(() => {
    const q = (searchParams.get("q") ?? "").trim();
    return q.length >= 3 ? q : "";
  });
  const [searching, setSearching] = useState(false);
  const requestAbortRef = useRef<AbortController | null>(null);
  const { openKey: openMenuKey, setOpenKey: setOpenMenuKey, ref: openMenuRef } = useDropdownMenu<string>();
  // Right-click menu position; the open tile is still tracked by openMenuKey.
  const [contextMenuAnchor, setContextMenuAnchor] = useState<ContextAnchor | null>(null);
  const [confirmingDeleteKey, setConfirmingDeleteKey] = useState<string | null>(null);
  const [addingToAlbumCaptureId, setAddingToAlbumCaptureId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const {
    selectMode,
    setSelectMode,
    selectedIds: selectedCaptureIds,
    toggle: toggleSelected,
    setSelectedIds,
    dragPreviewIds,
    dragProps,
    exit: exitSelectModeBase,
  } = useSelectMode(items, (item) => item.captureId, startInSelectMode);
  const [confirmingBatchDelete, setConfirmingBatchDelete] = useState(false);
  const [deleteRawToo, setDeleteRawToo] = useState(false);
  useEnterToConfirm(() => confirmingDeleteKey && void confirmDelete(confirmingDeleteKey), !!confirmingDeleteKey && !deleting);
  useEnterToConfirm(() => void confirmDeleteSelected(), confirmingBatchDelete && !deleting);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const batchDeleteButtonRef = useRef<HTMLButtonElement>(null);
  // Reveal runs on the API's machine, so only the desktop app's own local API can do it.
  const inTauriShell = useIsTauri();
  const deploymentMode = useDeploymentMode();
  const canRevealInFinder = inTauriShell && deploymentMode === "desktop";
  const [reassigningCaptureId, setReassigningCaptureId] = useState<string | null>(null);
  const [editingTagsCaptureId, setEditingTagsCaptureId] = useState<string | null>(null);
  const [tagOptions, setTagOptions] = useState<string[]>([]);
  const [bulkTags, setBulkTags] = useState<string[]>([]);
  useEffect(() => {
    api.get<{ tags: string[] }>("/captures/tags").then((res) => setTagOptions(res.tags)).catch(() => {});
  }, []);
  const [batchReassigning, setBatchReassigning] = useState(false);
  const [reassignError, setReassignError] = useState<string | null>(null);
  const [bulkTagError, setBulkTagError] = useState<string | null>(null);

  // keepLoaded: a refresh after an edit reloads as many photos as were showing, so the grid
  // doesn't jump back to the first page.
  function load(opts?: { keepLoaded?: boolean }) {
    const keepCount = opts?.keepLoaded ? (itemsRef.current?.length ?? 0) : 0;
    // Cancel the previous request (and any page still loading) so a slow older response can't
    // overwrite a newer one.
    requestAbortRef.current?.abort();
    const controller = new AbortController();
    requestAbortRef.current = controller;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setLoadMoreError(false);
    setLoadError(null);

    const params = new URLSearchParams();
    if (searchQuery) params.set("q", searchQuery);
    if (onlyTopRated) params.set("onlyTopRated", "1");
    if (onlyFeatured) params.set("onlyFeatured", "1");
    if (missingDate) params.set("missingDate", "1");
    if (selectedTaxa.size > 0) params.set("taxa", [...selectedTaxa].join(","));
    if (excludeHasRaw) params.set("excludeHasRaw", "1");
    if (onlyHasRaw) params.set("onlyHasRaw", "1");
    if (onlyVideo) params.set("onlyVideo", "1");
    if (excludeVideo) params.set("excludeVideo", "1");
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    if (regionId) params.set("regionId", regionId);
    if (tag) params.set("tag", tag);
    if (scopeTripId) params.set("tripId", scopeTripId);
    if (scopeAlbumId) params.set("albumId", scopeAlbumId);

    const fail = (err: unknown) => {
      if (controller.signal.aborted) return;
      setLoadError(errorMessage(err, searchQuery ? "Search failed" : "Couldn't load your photos"));
      setSearching(false);
    };

    if (searchQuery) {
      listingParamsRef.current = null;
      setNextCursor(null);
      setTotal(null);
      setSearching(true);
      // Two passes sent together: a quick one (names, places, dates) shows first, then the full one with
      // picture matching replaces it. A quick pass with nothing reliable leaves current results up.
      let fullArrived = false;
      const quickParams = new URLSearchParams(params);
      quickParams.set("quick", "1");
      api
        .get<SearchResponse>(`/gallery/search?${quickParams}`, { signal: controller.signal })
        .then((res) => {
          if (fullArrived) return;
          if (!res.pending || res.items.length > 0) setItems(res.items);
          setSearchReading(describeSearchReading(res.interpretation));
          if (!res.pending) {
            // Nothing about the picture to match: this is already the whole answer.
            fullArrived = true;
            controller.abort();
            setSearching(false);
          }
        })
        // The full pass reports failures.
        .catch(() => {});
      api
        .get<SearchResponse>(`/gallery/search?${params}`, { signal: controller.signal })
        .then((res) => {
          fullArrived = true;
          setItems(res.items);
          setSearchReading(describeSearchReading(res.interpretation));
          setSearching(false);
        })
        .catch(fail);
      return;
    }

    setSearching(false);
    if (sortBy !== "newest") params.set("sort", sortBy);
    listingParamsRef.current = params;
    const pageParams = new URLSearchParams(params);
    pageParams.set("limit", String(keepCount > PAGE_SIZE ? CATCH_UP_PAGE_SIZE : PAGE_SIZE));
    api
      .get<GalleryPageResponse>(`/gallery?${pageParams}`, { signal: controller.signal })
      .then(async (res) => {
        let loaded = res.items;
        let cursor = res.nextCursor;
        while (cursor && loaded.length < keepCount) {
          const page = await fetchPage(params, cursor, CATCH_UP_PAGE_SIZE, controller.signal);
          loaded = appendNew(loaded, page.items);
          cursor = page.nextCursor;
        }
        if (controller.signal.aborted) return;
        setItems(loaded);
        setNextCursor(cursor);
        setTotal(res.total ?? null);
      })
      .catch(fail);
  }

  function fetchPage(params: URLSearchParams, cursor: string, limit: number, signal: AbortSignal) {
    const pageParams = new URLSearchParams(params);
    pageParams.set("limit", String(limit));
    pageParams.set("cursor", cursor);
    return api.get<GalleryPageResponse>(`/gallery?${pageParams}`, { signal });
  }

  // Next page of the plain listing, from the scroll sentinel or the lightbox nearing the end.
  function loadMore() {
    const cursor = nextCursorRef.current;
    const params = listingParamsRef.current;
    const controller = requestAbortRef.current;
    if (!cursor || !params || !controller || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setLoadMoreError(false);
    fetchPage(params, cursor, PAGE_SIZE, controller.signal)
      .then((page) => {
        // Superseded by a reload, or a select-all already loaded past this cursor.
        if (controller.signal.aborted || nextCursorRef.current !== cursor) return;
        setItems((prev) => appendNew(prev ?? [], page.items));
        setNextCursor(page.nextCursor);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadMoreError(true);
      })
      .finally(() => {
        if (requestAbortRef.current === controller) {
          loadingMoreRef.current = false;
          setLoadingMore(false);
        }
      });
  }
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;

  // Video and RAW capture ids from the last select all, for selected photos not loaded yet.
  const selectAllMetaRef = useRef<{ video: Set<string>; raw: Set<string> } | null>(null);

  // Select all means every photo matching the filters. Unloaded pages are fetched as ids only:
  // loading and mounting every full item is what made this slow on large libraries.
  async function selectAllPhotos() {
    const controller = requestAbortRef.current;
    const params = listingParamsRef.current;
    if (nextCursorRef.current && params && controller) {
      setSelectingAll(true);
      try {
        const res = await api.get<{ captureIds: string[]; videoCaptureIds: string[]; rawCaptureIds: string[] }>(
          `/gallery/ids?${params}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        selectAllMetaRef.current = { video: new Set(res.videoCaptureIds), raw: new Set(res.rawCaptureIds) };
        setSelectMode(true);
        setSelectedIds(new Set(res.captureIds));
      } catch (err) {
        if (!controller.signal.aborted) toast.error(errorMessage(err, "Couldn't select every photo"));
      } finally {
        setSelectingAll(false);
      }
      return;
    }
    selectAllMetaRef.current = null;
    setSelectMode(true);
    setSelectedIds(new Set((itemsRef.current ?? []).map((it) => it.captureId)));
  }
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => load(), [onlyTopRated, onlyFeatured, missingDate, searchQuery, selectedTaxa, rawFilter, mediaFilter, dateFrom, dateTo, regionId, tag, scopeTripId, scopeAlbumId, sortBy]);
  useEffect(() => () => requestAbortRef.current?.abort(), []);

  // 80ms debounce: the quick pass answers in milliseconds. Under three characters there's
  // nothing meaningful to match, so the whole gallery stays.
  useEffect(() => {
    const typed = searchInput.trim();
    const timer = setTimeout(() => setSearchQuery(typed.length >= 3 ? typed : ""), 80);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // The search palette hands off with /gallery?q=, which can arrive while this page is open.
  const urlQuery = searchParams.get("q") ?? "";
  const lastWrittenQueryRef = useRef<string | null>(null);
  useEffect(() => {
    if (urlQuery === lastWrittenQueryRef.current) return;
    const q = urlQuery.trim();
    const effective = q.length >= 3 ? q : "";
    if (effective === searchQuery) return;
    setSearchInput(urlQuery);
    setSearchQuery(effective);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlQuery]);

  useEffect(() => {
    if ((searchParams.get("q") ?? "") === searchQuery) return;
    lastWrittenQueryRef.current = searchQuery;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (searchQuery) next.set("q", searchQuery);
        else next.delete("q");
        return next;
      },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  // Re-observed after each page: on a tall screen the sentinel can still be in view, and an
  // observer only fires on a change, so it would otherwise stall.
  const itemCount = items?.length ?? 0;
  useEffect(() => {
    if (!nextCursor || loadingMore || loadMoreError) return;
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMoreRef.current();
      },
      { rootMargin: "1200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [nextCursor, loadingMore, loadMoreError, itemCount, groupByRegion]);

  // Paging through the lightbox reaches the end of what's loaded before the grid does.
  useEffect(() => {
    if (lightboxIndex !== null && nextCursor && lightboxIndex >= itemCount - 5) loadMoreRef.current();
  }, [lightboxIndex, itemCount, nextCursor]);

  const [savingDateCaptureId, setSavingDateCaptureId] = useState<string | null>(null);
  const setTakenAt = useCallback(
    async (captureId: string, takenAt: string) => {
      setSavingDateCaptureId(captureId);
      try {
        await api.patch(`/captures/${captureId}/taken-at`, { takenAt: new Date(takenAt).toISOString() });
        // This view is the "missing a date" list, so a fixed item leaves it.
        setItems((prev) => prev?.filter((it) => it.captureId !== captureId) ?? prev);
        setTotal((t) => (t === null ? t : Math.max(0, t - 1)));
      } catch (err) {
        toast.error(errorMessage(err, "Couldn't save that date"));
      } finally {
        setSavingDateCaptureId(null);
      }
    },
    [toast],
  );

  const rateCapture = useCallback(
    async (captureId: string, rating: number | null) => {
      setItems((prev) => prev?.map((it) => (it.captureId === captureId ? { ...it, qualityRating: rating } : it)) ?? prev);
      try {
        await api.patch(`/captures/${captureId}/rating`, { rating });
      } catch (err) {
        toast.error(errorMessage(err, "Couldn't save that rating"));
        loadRef.current({ keepLoaded: true });
      }
    },
    [toast],
  );

  const tagCapture = useCallback(
    async (captureId: string, tags: string[]) => {
      setItems((prev) => prev?.map((it) => (it.captureId === captureId ? { ...it, tags } : it)) ?? prev);
      setTagOptions((prev) => [...new Set([...prev, ...tags])].sort());
      try {
        await api.patch(`/captures/${captureId}/tags`, { tags });
      } catch (err) {
        toast.error(errorMessage(err, "Couldn't save those tags"));
        loadRef.current({ keepLoaded: true });
      }
    },
    [toast],
  );

  async function toggleFeatured(item: GalleryItem) {
    const featuring = !item.isFeatured;
    // One featured photo per species: featuring this one unfeatures its siblings.
    setItems(
      (prev) =>
        prev?.map((it) =>
          it.speciesId !== item.speciesId ? it : { ...it, isFeatured: featuring ? it.photoId === item.photoId : it.photoId === item.photoId ? false : it.isFeatured },
        ) ?? prev,
    );
    try {
      await api.patch(`/species/${item.speciesId}/cover`, { photoId: featuring ? item.photoId : null });
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't update the featured photo"));
      loadRef.current({ keepLoaded: true });
    }
  }

  async function revealInFinder(path: string) {
    setOpenMenuKey(null);
    try {
      await api.post("/originals/reveal", { path });
    } catch {
      toast.error("Couldn't reveal that file. It may be unavailable.");
    }
  }

  async function confirmDelete(captureId: string) {
    setDeleting(true);
    try {
      await api.delete(`/captures/${captureId}`);
      setConfirmingDeleteKey(null);
      setItems((prev) => prev?.filter((it) => it.captureId !== captureId) ?? prev);
      setTotal((t) => (t === null ? t : Math.max(0, t - 1)));
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't delete that photo"));
    } finally {
      setDeleting(false);
    }
  }

  // In the album picker, leaving select mode goes back to the album.
  function exitSelectMode() {
    setBulkTags([]);
    setBulkTagError(null);
    if (targetAlbumId) {
      navigate(`/albums/${targetAlbumId}`);
      return;
    }
    exitSelectModeBase();
  }

  function requestBatchDelete() {
    if (selectMode && selectedCaptureIds.size > 0) setConfirmingBatchDelete(true);
  }
  const requestBatchDeleteRef = useRef(requestBatchDelete);
  useEffect(() => {
    requestBatchDeleteRef.current = requestBatchDelete;
  });

  // Off while the lightbox is open; it owns the keyboard then.
  useKeyboardShortcuts(
    {
      escape: () => {
        if (selectMode) exitSelectMode();
      },
      "mod+a": (e) => {
        e.preventDefault();
        void selectAllPhotos();
      },
      delete: requestBatchDelete,
      s: () => setSelectMode((v) => !v),
    },
    { enabled: lightboxIndex === null },
  );

  // Desktop: the native Edit menu's "Delete" item fires this event, same as the Delete key.
  useEffect(() => {
    if (!isTauri() || lightboxIndex !== null) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen("menu:delete-selected", () => requestBatchDeleteRef.current()))
      .then((fn) => {
        // listen() resolves async: if cleanup already ran, drop the listener right away.
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [lightboxIndex]);

  const [addingToTargetAlbum, setAddingToTargetAlbum] = useState(false);
  async function addSelectedToTargetAlbum() {
    if (!targetAlbumId) return;
    setAddingToTargetAlbum(true);
    try {
      await api.post(`/albums/${targetAlbumId}/captures`, { captureIds: [...selectedCaptureIds] });
      navigate(`/albums/${targetAlbumId}`);
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't add those photos to the album"));
    } finally {
      setAddingToTargetAlbum(false);
    }
  }

  const selectedHaveRaw = useMemo(
    () =>
      selectedCaptureIds.size > 0 &&
      ((items ?? []).some((it) => selectedCaptureIds.has(it.captureId) && it.hasRawOriginal) ||
        anySelectedIn(selectAllMetaRef.current?.raw, selectedCaptureIds)),
    [items, selectedCaptureIds],
  );

  function closeBatchDelete() {
    setConfirmingBatchDelete(false);
    setDeleteRawToo(false);
  }

  async function confirmDeleteSelected() {
    setDeleting(true);
    const ids = new Set(selectedCaptureIds);
    try {
      await api.post("/captures/batch-delete", { captureIds: [...ids], deleteRaw: deleteRawToo });
      closeBatchDelete();
      exitSelectMode();
      setItems((prev) => prev?.filter((it) => !ids.has(it.captureId)) ?? prev);
      setTotal((t) => (t === null ? t : Math.max(0, t - ids.size)));
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't delete those photos"));
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
      load({ keepLoaded: true });
    } catch (err) {
      setReassignError(err instanceof ApiError ? err.message : "Couldn't reassign this photo");
    }
  }

  // No batch endpoint: one PATCH per selected photo.
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
      load({ keepLoaded: true });
    } finally {
      setBatchReassigning(false);
    }
  }

  function clearFilters() {
    // With nothing but the presets active, "clear" means show everything.
    const onlyPresets = activeFilterCount === 0 && !searchQuery;
    setOnlyTopRated(false);
    setOnlyFeatured(false);
    setMediaFilter(onlyPresets ? "both" : "photos");
    setRawFilter(onlyPresets ? "any" : "without");
    setSelectedTaxa(new Set());
    setDateFrom("");
    setDateTo("");
    setDateRangeOpen(false);
    setRegionId(null);
    setTag(null);
    if (scopeTripId) clearScope("trip");
    if (scopeAlbumId) clearScope("album");
    setSearchInput("");
    setSearchQuery("");
  }

  const slides = useMemo<LightboxSlide[]>(
    () =>
      (items ?? []).map((i) => ({
        url: `/api/photos/${i.photoId}/display`,
        videoUrl: i.kind === "video" ? `/api/photos/${i.photoId}/video` : null,
        caption: `${i.commonName ?? i.scientificName}${i.takenAt ? " · " + formatDate(i.takenAt, "medium") : ""}`,
        speciesId: i.speciesId,
        rating: i.qualityRating,
        onRate: (rating: number | null) => rateCapture(i.captureId, rating),
        tags: i.tags,
        onTagsChange: (tags: string[]) => tagCapture(i.captureId, tags),
        info: {
          cameraModel: i.cameraModel,
          lens: i.lens,
          focalLengthMm: i.focalLengthMm,
          aperture: i.aperture,
          shutter: i.shutter,
          iso: i.iso,
          takenAt: i.takenAt,
          durationSeconds: i.durationSeconds,
          files: photoFilePaths(i.originalRef, i.rawRef),
        },
      })),
    [items, rateCapture, tagCapture],
  );

  const shotLines = useMemo(() => new Map((items ?? []).map((it) => [it.photoId, itemShotData(it)])), [items]);

  // `i` is always the index into the flat `items` array, so grouped tiles open and select the
  // same way as ungrouped ones.
  const regionGroups = useMemo(() => {
    if (!items) return null;
    const buckets = new Map<string, { label: string; entries: { item: GalleryItem; i: number }[] }>();
    items.forEach((item, i) => {
      const key = item.regionId ?? "unknown";
      const label = item.regionId ? (item.regionName ?? "Unknown region") : "Unknown region";
      if (!buckets.has(key)) buckets.set(key, { label, entries: [] });
      buckets.get(key)!.entries.push({ item, i });
    });
    return [...buckets.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [items]);
  const flatEntries = useMemo(() => (items ?? []).map((item, i) => ({ item, i })), [items]);

  const toggleMenu = useCallback(
    (photoId: string) => {
      setContextMenuAnchor(null);
      setOpenMenuKey((key) => (key === photoId ? null : photoId));
    },
    [setOpenMenuKey],
  );
  const openContextMenu = useCallback(
    (photoId: string, point: { x: number; y: number }) => {
      setOpenMenuKey(photoId);
      setContextMenuAnchor({ photoId, ...point });
    },
    [setOpenMenuKey],
  );

  // Built only for the tile whose menu is open.
  function renderMenu(item: GalleryItem) {
    const wide = reassigningCaptureId === item.captureId || editingTagsCaptureId === item.captureId;
    return (
      <div className={`absolute right-0 top-full z-10 mt-1 rounded-md border border-line bg-surface py-1 shadow-lg ${wide ? "w-56" : "w-44"}`}>
        <Link
          to={`/species/${item.speciesId}`}
          onClick={(e) => {
            e.stopPropagation();
            setOpenMenuKey(null);
          }}
          className={MENU_ITEM}
        >
          View species
        </Link>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void toggleFeatured(item);
            setOpenMenuKey(null);
          }}
          className={MENU_ITEM}
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
          className={MENU_ITEM}
        >
          Add to album…
        </button>
        {editingTagsCaptureId === item.captureId ? (
          <div className="px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
            <TagEditor tags={item.tags} existingTags={tagOptions} onChange={(tags) => tagCapture(item.captureId, tags)} />
          </div>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setEditingTagsCaptureId(item.captureId);
            }}
            className={MENU_ITEM}
          >
            Edit tags…
          </button>
        )}
        {reassigningCaptureId === item.captureId ? (
          <div className="px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
            <SpeciesPicker autoFocus placeholder="Correct ID to…" onSelect={(s) => reassignSpecies(item.captureId, s.id)} />
          </div>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setReassigningCaptureId(item.captureId);
            }}
            className={MENU_ITEM}
          >
            Correct the ID…
          </button>
        )}
        {/* When the only original is the RAW, "Download RAW" below already covers it. */}
        {item.originalRef && item.originalKind !== "raw" && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setOpenMenuKey(null);
              downloadFile(`/api/photos/${item.photoId}/original?download=1`, "original.jpg");
            }}
            className={MENU_ITEM}
          >
            Download original
          </button>
        )}
        {item.hasRawOriginal && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setOpenMenuKey(null);
              downloadFile(`/api/photos/${item.photoId}/original-raw?download=1`, "original.raw");
            }}
            className={MENU_ITEM}
          >
            Download RAW
          </button>
        )}
        {canRevealInFinder && item.originalRef && !item.originalManaged && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void revealInFinder(item.originalRef!);
            }}
            className={MENU_ITEM}
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
          className="block w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-surface-muted dark:text-red-400"
        >
          Delete {item.kind === "video" ? "video" : "photo"}
        </button>
      </div>
    );
  }

  const extraHeightPxFor = useMemo(
    () =>
      showCameraInfo
        ? ({ item }: { item: GalleryItem }, columnWidthPx: number) =>
            estimateShotDataWrapExtraPx(shotLines.get(item.photoId) ?? null, columnWidthPx, CAMERA_INFO_LINE_HEIGHT_PX)
        : undefined,
    [showCameraInfo, shotLines],
  );

  const previewIds = dragPreviewIds ?? EMPTY_SET;

  // Grouping stacks one MasonryGrid per region; a single grid can't splice headers in without
  // breaking column alignment.
  function renderGrid(entries: { item: GalleryItem; i: number }[]) {
    return (
      <MasonryGrid
        items={entries}
        columnWidth={thumbSizePx}
        gap={gridGapPx}
        extraHeightPx={extraHeightPx}
        extraHeightPxFor={extraHeightPxFor}
        keyFor={({ item }) => item.photoId}
        aspectRatioFor={({ item }) => (item.width && item.height ? item.width / item.height : null)}
        renderItem={({ item, i }, aspectRatio) => {
          const menuOpen = openMenuKey === item.photoId;
          return (
            <GalleryTile
              key={item.photoId}
              item={item}
              index={i}
              aspectRatio={aspectRatio}
              cornerRadiusPx={gridCornerRadiusPx}
              selectMode={selectMode}
              selected={selectedCaptureIds.has(item.captureId) || previewIds.has(item.captureId)}
              menuOpen={menuOpen}
              contextMenuAnchor={contextMenuAnchor?.photoId === item.photoId ? contextMenuAnchor : null}
              menuContent={menuOpen ? renderMenu(item) : null}
              menuRef={openMenuRef}
              shotLine={showCameraInfo ? (shotLines.get(item.photoId) ?? null) : null}
              showLabels={showLabels}
              showRatings={showRatings}
              showCameraInfo={showCameraInfo}
              missingDate={missingDate}
              savingDate={savingDateCaptureId === item.captureId}
              onOpen={setLightboxIndex}
              onToggleSelect={toggleSelected}
              onDragStart={dragProps.onDragSelectStart}
              onDragEnter={dragProps.onDragSelectEnter}
              onToggleMenu={toggleMenu}
              onOpenContextMenu={openContextMenu}
              onRate={rateCapture}
              onSetTakenAt={setTakenAt}
            />
          );
        }}
      />
    );
  }

  const libraryEmpty = availableTaxa !== null && availableTaxa.size === 0;
  const batchNoun = useMemo(() => {
    // Select all lists the videos among photos not loaded yet.
    const selectedVideos = new Set<string>();
    for (const it of items ?? []) if (it.kind === "video" && selectedCaptureIds.has(it.captureId)) selectedVideos.add(it.captureId);
    for (const id of selectAllMetaRef.current?.video ?? []) if (selectedCaptureIds.has(id)) selectedVideos.add(id);
    const hasVideo = selectedVideos.size > 0;
    const hasPhoto = selectedCaptureIds.size > selectedVideos.size;
    return hasVideo && hasPhoto ? "file" : hasVideo ? "video" : "photo";
  }, [items, selectedCaptureIds]);
  const emptyIcon = (
    <svg viewBox="0 0 24 24" className="h-6 w-6 text-muted" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="9" cy="11" r="2" />
      <path d="m21 16-4.5-4.5L9 19" />
    </svg>
  );

  function renderEmpty() {
    if (missingDate) return <p className="text-muted">Every photo has a date. Nothing to fix here.</p>;
    if (libraryEmpty && !searchQuery) {
      return <EmptyState icon={emptyIcon} title="No photos yet" description="Upload one from a species page to get started." />;
    }
    if (searchQuery) {
      return (
        <EmptyState
          icon={emptyIcon}
          title={`No photos match "${searchQuery}"`}
          description="Try different words, or clear the search and filters."
          action={{ label: "Clear search and filters", onClick: clearFilters }}
        />
      );
    }
    const onlyPresets = activeFilterCount === 0;
    return (
      <EmptyState
        icon={emptyIcon}
        title="No photos match these filters"
        description={onlyPresets ? "Gallery shows photos without RAW files by default." : "Loosen or clear the filters to see more."}
        action={{ label: onlyPresets ? "Show all photos" : "Clear filters", onClick: clearFilters }}
      />
    );
  }

  return (
    <div className="flex-1 bg-canvas">
      {targetAlbumId ? (
        // A picker, not a browsed page: no back link or "Gallery" title.
        <header data-tauri-drag-region className="border-b border-line bg-surface px-6 py-4">
          <h1 className="text-lg font-semibold text-ink">Add photos to {targetAlbumName ?? "album"}</h1>
        </header>
      ) : (
        <PageHeader
          title="Gallery"
          actions={
            items && (
              <div className="flex items-center gap-4 text-xs">
                <SearchInput
                  value={searchInput}
                  onChange={setSearchInput}
                  placeholder="Search your photos… (e.g. “owl flying”, “ducks in Canada 2024”)"
                  className="w-96"
                  aria-label="Search your photos by what's in them"
                />
                {searching && <InlineSpinner size="sm" label="Searching…" />}

                <Select
                  label="Sort"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                  disabled={!!searchQuery}
                  title={searchQuery ? "Search results are already ranked by relevance" : undefined}
                >
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                  <option value="ratingHigh">Highest rated first</option>
                  <option value="ratingLow">Lowest rated first</option>
                </Select>

            <FilterPopover activeCount={activeFilterCount}>
              <div className="space-y-2.5">
                <FilterGroupLabel>Filter</FilterGroupLabel>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-1.5 text-xs text-ink">
                    <input type="checkbox" checked={onlyTopRated} onChange={(e) => setOnlyTopRated(e.target.checked)} className="accent-ink" />
                    Top rated
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-ink">
                    <input type="checkbox" checked={onlyFeatured} onChange={(e) => setOnlyFeatured(e.target.checked)} className="accent-ink" />
                    Featured
                  </label>
                </div>

                {hasVideoInLibrary && (
                  <div>
                    <FilterFieldLabel>Media type</FilterFieldLabel>
                    <SegmentedControl
                      value={mediaFilter}
                      onChange={setMediaFilter}
                      options={[
                        { value: "both", label: "Both" },
                        { value: "photos", label: "Photos" },
                        { value: "videos", label: "Videos" },
                      ]}
                    />
                  </div>
                )}

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
                      {(dateFrom || dateTo) && (
                        <button
                          onClick={() => {
                            setDateFrom("");
                            setDateTo("");
                            setDateRangeOpen(false);
                          }}
                          className="shrink-0 text-[11px] text-muted hover:underline"
                        >
                          Clear
                        </button>
                      )}
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

                <div>
                  <FilterFieldLabel>Region</FilterFieldLabel>
                  <label className="mb-1.5 flex items-center gap-1.5 text-xs text-ink">
                    <input
                      type="checkbox"
                      checked={regionId === UNCATEGORIZED_REGION_ID}
                      onChange={(e) => setRegionId(e.target.checked ? UNCATEGORIZED_REGION_ID : null)}
                      className="accent-ink"
                    />
                    No region set yet
                  </label>
                  {regionId !== UNCATEGORIZED_REGION_ID && (
                    <RegionBrowser regionId={regionId} onChange={setRegionId} allowAnyRegion restrictToIds={regionsWithPhotos} />
                  )}
                </div>

                {tagOptions.length > 0 && (
                  <div>
                    <FilterFieldLabel>Tag</FilterFieldLabel>
                    <Select value={tag ?? ""} onChange={(e) => setTag(e.target.value || null)}>
                      <option value="">Any tag</option>
                      {tagOptions.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </Select>
                  </div>
                )}

                <div>
                  <FilterFieldLabel>Taxon</FilterFieldLabel>
                  <div className="flex max-h-32 flex-wrap gap-1 overflow-y-auto">
                    {ALL_TAXON_CLASSES.filter((tc) => !availableTaxa || availableTaxa.has(tc)).map((tc) => (
                      <Pill
                        key={tc}
                        size="sm"
                        active={selectedTaxa.has(tc)}
                        onClick={() => setSelectedTaxa((prev) => toggleInSet(prev, tc))}
                      >
                        {taxonDisplayLabel(tc, namingStyles)}
                      </Pill>
                    ))}
                    {otherTaxaClasses.map((tc) => (
                      <Pill
                        key={tc}
                        size="sm"
                        active={selectedTaxa.has(tc)}
                        onClick={() => setSelectedTaxa((prev) => toggleInSet(prev, tc))}
                      >
                        {taxonDisplayLabel(tc, namingStyles)}
                      </Pill>
                    ))}
                  </div>
                  {selectedTaxa.size > 0 && (
                    <button type="button" onClick={() => setSelectedTaxa(new Set())} className="mt-1 text-[11px] text-muted hover:underline">
                      Clear taxon filter
                    </button>
                  )}
                </div>
              </div>

              <div className="space-y-1.5 border-t border-line pt-2.5">
                <FilterGroupLabel>Display</FilterGroupLabel>
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
                <label className="flex items-center gap-1.5 text-xs text-ink">
                  <input
                    type="checkbox"
                    checked={groupByRegion}
                    onChange={(e) => setGroupByRegion(e.target.checked)}
                    className="accent-ink"
                  />
                  Group by region
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
                {items.length > 0 && <SelectModeToggle active={selectMode} onEnter={() => setSelectMode(true)} onExit={exitSelectMode} />}
              </div>
            )
          }
        >
          {items && (
            <p className="text-xs text-muted">
              {missingDate
                ? `${nextCursor ? "At least " : ""}${pluralize(items.length, "photo")} missing a date. Pick one below to fix it`
                : nextCursor && total !== null
                  ? pluralize(total, "photo")
                  : nextCursor
                    ? `${pluralize(items.length, "photo")} loaded, more as you scroll`
                    : `${pluralize(items.length, "photo")}${searchQuery ? ` matching "${searchQuery}"` : ""}${searchQuery && searchReading ? `: ${searchReading}` : ""}`}
            </p>
          )}
          {(scopeTrip || scopeAlbum) && (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {scopeTrip && <ScopeChip label={`In trip ${scopeTrip.name ?? ""}`.trim()} onRemove={() => clearScope("trip")} />}
              {scopeAlbum && <ScopeChip label={`In album ${scopeAlbum.name ?? ""}`.trim()} onRemove={() => clearScope("album")} />}
            </div>
          )}
        </PageHeader>
      )}

      {selectMode && (
        <div className="flex items-center gap-3 border-b border-line bg-surface-muted px-6 py-2 text-xs">
          <span className="shrink-0 text-muted">{selectedCaptureIds.size.toLocaleString()} selected</span>
          {selectingAll && <InlineSpinner size="xs" label="Selecting every photo" />}
          {/* Always rendered as a flex spacer so the controls don't shift with the selection. */}
          <div className="flex min-w-0 flex-1 items-center gap-6">
            {/* ID correction doesn't belong in the album picker. */}
            {!targetAlbumId && selectedCaptureIds.size > 0 && (
              <>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="shrink-0 text-muted">Correct ID to:</span>
                  <div className="w-56">
                    <SpeciesPicker placeholder="Type a species…" onSelect={(s) => reassignSelected(s.id)} />
                  </div>
                  {batchReassigning && <span className="shrink-0 text-muted">Reassigning…</span>}
                </div>
                <span aria-hidden className="h-4 w-px shrink-0 bg-line" />
                <div className="flex shrink-0 items-center gap-2">
                  <span className="shrink-0 text-muted">Add tag:</span>
                  <div className="w-48">
                    <TagEditor
                      tags={bulkTags}
                      existingTags={tagOptions}
                      compact
                      onChange={(tags) => {
                        // Only newly added tags are sent; bulkTags is this session's running list.
                        const added = tags.filter((t) => !bulkTags.includes(t));
                        setBulkTags(tags);
                        setBulkTagError(null);
                        if (added.length > 0) {
                          api
                            .patch("/captures/tags", { captureIds: [...selectedCaptureIds], tags: added })
                            .then(() => setTagOptions((prev) => [...new Set([...prev, ...added])].sort()))
                            .catch((err) => {
                              // Drop the chip again so a failed tag doesn't read as applied.
                              setBulkTags((prev) => prev.filter((t) => !added.includes(t)));
                              setBulkTagError(errorMessage(err, "Couldn't add that tag"));
                            });
                        }
                      }}
                    />
                  </div>
                </div>
                {bulkTags.length > 0 && (
                  <Button size="sm" onClick={exitSelectMode} className="shrink-0">
                    Done
                  </Button>
                )}
              </>
            )}
          </div>
          {targetAlbumId ? (
            <Button
              size="sm"
              onClick={addSelectedToTargetAlbum}
              disabled={selectedCaptureIds.size === 0}
              loading={addingToTargetAlbum}
              className="shrink-0"
            >
              {addingToTargetAlbum ? "Adding…" : `Add ${selectedCaptureIds.size || ""} to album`}
            </Button>
          ) : (
            <AddToAlbumButton captureIds={[...selectedCaptureIds]} onAdded={exitSelectMode} />
          )}
          <Button variant="danger" size="sm" onClick={() => setConfirmingBatchDelete(true)} disabled={selectedCaptureIds.size === 0} className="shrink-0">
            Delete selected
          </Button>
        </div>
      )}
      {(reassignError || bulkTagError) && (
        <div className="space-y-2 border-b border-line bg-surface px-6 py-2">
          <FormMessage error={reassignError} />
          <FormMessage error={bulkTagError} />
        </div>
      )}

      <main className="p-6">
        {loadError && (
          <div className="mb-4 flex items-center gap-3">
            <FormMessage error={loadError} className="flex-1" />
            <Button variant="secondary" size="sm" onClick={() => load()}>
              Retry
            </Button>
          </div>
        )}
        {!items ? (
          !loadError && <Spinner />
        ) : items.length === 0 ? (
          renderEmpty()
        ) : groupByRegion && regionGroups ? (
          <div className="space-y-8">
            {regionGroups.map((group) => (
              <section key={group.label}>
                <h2 className="mb-2 text-sm font-semibold text-ink">{group.label}</h2>
                {renderGrid(group.entries)}
              </section>
            ))}
          </div>
        ) : (
          renderGrid(flatEntries)
        )}
        {items && nextCursor && (
          <div ref={sentinelRef} className="flex h-16 items-center justify-center gap-3 text-xs text-muted">
            {loadMoreError ? (
              <>
                <span>Couldn't load more photos.</span>
                <Button variant="secondary" size="sm" onClick={() => loadMoreRef.current()}>
                  Retry
                </Button>
              </>
            ) : (
              <InlineSpinner size="sm" label="Loading more photos" />
            )}
          </div>
        )}
      </main>

      {lightboxIndex !== null && (
        <Lightbox
          slides={slides}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
          tagOptions={tagOptions}
        />
      )}

      {addingToAlbumCaptureId && <AddToAlbumModal captureIds={[addingToAlbumCaptureId]} onClose={() => setAddingToAlbumCaptureId(null)} />}

      <Modal
        open={!!confirmingDeleteKey}
        onClose={() => setConfirmingDeleteKey(null)}
        title={`Delete this ${items?.find((it) => it.captureId === confirmingDeleteKey)?.kind === "video" ? "video" : "photo"}?`}
        initialFocusRef={deleteButtonRef}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setConfirmingDeleteKey(null)}>
              Cancel
            </Button>
            <Button
              ref={deleteButtonRef}
              variant="danger"
              size="sm"
              loading={deleting}
              onClick={() => confirmingDeleteKey && confirmDelete(confirmingDeleteKey)}
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </>
        }
      >
        <p className="text-xs text-muted">
          Deleted photos go to Trash for 7 days first, where you can still restore them. After 7 days they're gone for good
          and can't be recovered.
        </p>
      </Modal>

      <Modal
        open={confirmingBatchDelete}
        onClose={closeBatchDelete}
        title={`Delete ${pluralize(selectedCaptureIds.size, batchNoun)}?`}
        initialFocusRef={batchDeleteButtonRef}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={closeBatchDelete}>
              Cancel
            </Button>
            <Button ref={batchDeleteButtonRef} variant="danger" size="sm" loading={deleting} onClick={confirmDeleteSelected}>
              {deleting ? "Deleting…" : "Delete"}
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
    </div>
  );
}

// A removable "In trip X" / "In album X" filter, from the palette's search-within hand-off.
function ScopeChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-muted px-2 py-0.5 text-xs text-ink">
      {label}
      <button type="button" onClick={onRemove} aria-label={`Remove filter: ${label}`} className="text-sm leading-none text-muted hover:text-ink">
        ×
      </button>
    </span>
  );
}
