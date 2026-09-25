import { useEffect, useMemo, useRef, useState } from "react";
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
import { usePhotoGridSize } from "../hooks/usePhotoGridSize";
import { useSelectMode } from "../hooks/useSelectMode";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { isTauri } from "../lib/tauri";
import { useEnterToConfirm } from "../hooks/useEnterToConfirm";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import { useDeploymentMode, useIsTauri } from "../hooks/useDeploymentMode";
import { useShowLabels } from "../hooks/useShowLabels";
import { shotDataLine, estimateShotDataWrapExtraPx } from "../lib/shotData";
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

// Must match the backend's own UNCATEGORIZED_REGION_ID sentinel (apps/api/src/gallery/routes.ts)
// — not a real region id, just a marker for "captures with no region set at all".
const UNCATEGORIZED_REGION_ID = "uncategorized";

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

// Every photo taken, across all species, as one browsable gallery — separate from the
// per-species detail view. Uses the same MasonryGrid (natural aspect ratio, no forced
// square, uneven column endings are fine), the same size slider (the same localStorage key
// as SpeciesDetailPage's own-photo grid — see usePhotoGridSize), and the same thumb->display
// progressive upgrade instead of settling for a permanently low-res thumbnail. There's no
// info toggle inside the lightbox here; instead a "Camera info" toggle on the grid itself
// shows the same shotDataLine caption under each thumbnail that SpeciesDetailPage uses.
interface SearchInterpretation {
  species: string[];
  groups: string[];
  places: string[];
  dates: string[];
  description: string | null;
}

// "ducks · Washington · 2024 · looks like “swimming”". Null when the search found nothing to
// read beyond the words themselves, where it would only repeat the query.
function describeSearchReading(i: SearchInterpretation | undefined): string | null {
  if (!i) return null;
  const subject = [...i.species.slice(0, 3), ...(i.species.length > 3 ? [`+${i.species.length - 3} more`] : []), ...i.groups];
  const parts = [subject.join(", "), ...i.places, ...i.dates].filter(Boolean);
  if (parts.length === 0) return null;
  if (i.description) parts.push(`looks like “${i.description}”`);
  return parts.join(" · ");
}

export default function GalleryPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<GalleryItem[] | null>(null);
  // How the server read the current search ("ducks · Washington · 2024 · swimming"), shown next
  // to the result count so it's clear why these photos came back.
  const [searchReading, setSearchReading] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [thumbSizePx, updateThumbSize] = usePhotoGridSize();
  // At small grid sizes, a fixed 8px gap/6px corner radius eats a much bigger proportion of a
  // tiny thumbnail than a large one — scaling both down with size keeps that proportion roughly
  // constant instead of the chrome visually dominating small thumbnails. Clamped so a huge
  // thumbnail doesn't get an absurdly large gap/radius either.
  const gridGapPx = Math.round(Math.min(8, Math.max(3, thumbSizePx / 30)));
  const gridCornerRadiusPx = Math.round(Math.min(8, Math.max(2, thumbSizePx / 40)));
  // Layout/display preferences — persisted site-wide (survive leaving Gallery, even a restart),
  // same as showLabels/thumbSizePx below, since these are "how I like to browse," not "what I
  // was looking for five minutes ago."
  const [showCameraInfo, setShowCameraInfo] = usePersistedState("galleryShowCameraInfo", false);
  const [showLabels, setShowLabels] = useShowLabels();
  const [showRatings, setShowRatings] = usePersistedState("galleryShowRatings", false);
  // Client-side grouping (like GroupedSpeciesGrid's own taxon grouping) — a photo with no
  // region_id set (never chosen at import time) lands in its own "Unknown region" bucket rather
  // than being silently dropped from the grouped view.
  const [groupByRegion, setGroupByRegion] = usePersistedState("galleryGroupByRegion", false);
  // Rough per-line height each optional row adds below the photo — MasonryGrid's row-span
  // estimate only ever budgets for the image itself, so without this, turning one of these on
  // pushes every tile taller than its reserved row-span and it overlaps the row below (each
  // number is that row's own text size * a normal line-height, plus its own margin/gap).
  // Camera info is handled separately, below, via extraHeightPxFor — unlike labels/ratings,
  // whether it wraps to a second line varies per photo (a long camera+lens string), so a flat
  // number here would either overlap the photos that wrap or waste space on the ones that don't.
  const CAMERA_INFO_LINE_HEIGHT_PX = 13;
  const extraHeightPx = (showLabels ? 19 : 0) + (showRatings ? 18 : 0) + (showCameraInfo ? CAMERA_INFO_LINE_HEIGHT_PX : 0);
  // Independent toggles per the ask: a photo can be BOTH 5-star and featured, and each filter
  // combines with the other (AND), same as the existing Labels/Camera-info checkboxes above.
  const [onlyTopRated, setOnlyTopRated] = useState(false);
  const [onlyFeatured, setOnlyFeatured] = useState(false);
  // Drill-down from the Stats page's Archive health "Missing date" row (?missingDate=1) — a
  // fixed, URL-driven filter rather than a toggle in the filters panel, since arriving here IS
  // the action (there's no reason to browse into this view any other way). Read once on mount:
  // fixing a date removes that item from `items` locally (see setDate below), so re-deriving
  // this from the URL on every render would just re-show items already fixed this session.
  const [searchParams] = useSearchParams();
  const [missingDate] = useState(() => searchParams.get("missingDate") === "1");
  // Reached from "Add photos" on an album (or right after creating one) with ?select=1 — same
  // Gallery, same real filters, just already in select mode with its own "Add to album" control
  // ready to go, instead of maintaining a separate simplified picker page that would drift out
  // of parity with this one over time.
  const startInSelectMode = searchParams.get("select") === "1";
  // When set, this whole page is a dedicated "add photos to THIS album" picker, not general
  // browsing — a known target, so AddToAlbumButton's own "which album?" dropdown would be a
  // redundant extra step, and there's no reason to offer ID-correction or expose the
  // Gallery/Search chrome that belongs to actual browsing, not a one-shot picker.
  const targetAlbumId = searchParams.get("albumId");
  const [targetAlbumName, setTargetAlbumName] = useState<string | null>(null);
  useEffect(() => {
    if (!targetAlbumId) return;
    api.get<{ name: string }>(`/albums/${targetAlbumId}`).then((res) => setTargetAlbumName(res.name)).catch(() => {});
  }, [targetAlbumId]);
  const [selectedTaxa, setSelectedTaxa] = useState<Set<string>>(new Set());
  // One 3-way control instead of two independent checkboxes: "with" shows only captures that
  // have a RAW file attached, "without" shows only ones that don't, "any" applies no filter.
  // A persisted layout preference, not a one-off content filter — "photos only, no RAW
  // backlog" is how someone wants to browse every time, not something they'd forget was on and
  // find confusing later. Defaults to "without": a plain photo library is the common case.
  const [rawFilter, setRawFilter] = usePersistedState<"any" | "with" | "without">("galleryRawFilter", "without");
  const excludeHasRaw = rawFilter === "without";
  const onlyHasRaw = rawFilter === "with";
  // Only ever shown if the user actually has at least one video (see /gallery/has-video) — same
  // "don't offer a filter for something that can't exist here" reasoning as SpeciesDetailPage's
  // own Video segment, which only appears once videoCount > 0. Persisted the same way as
  // rawFilter above — defaults to "photos" so opening Gallery shows plain photos by default.
  const [mediaFilter, setMediaFilter] = usePersistedState<"both" | "photos" | "videos">("galleryMediaFilter", "photos");
  const onlyVideo = mediaFilter === "videos";
  const excludeVideo = mediaFilter === "photos";
  const [hasVideoInLibrary, setHasVideoInLibrary] = useState(false);
  useEffect(() => {
    api.get<{ hasVideo: boolean }>("/gallery/has-video").then((res) => setHasVideoInLibrary(res.hasVideo)).catch(() => {});
  }, []);
  // Same "don't offer a filter for something that can't exist here" reasoning as the video
  // toggle above — ALL_TAXON_CLASSES lists every taxon group the app knows about, most of which
  // a given user has never actually photographed, so checking one of those would always yield
  // zero results.
  const [availableTaxa, setAvailableTaxa] = useState<Set<string> | null>(null);
  useEffect(() => {
    api.get<{ taxa: string[] }>("/gallery/taxa").then((res) => setAvailableTaxa(new Set(res.taxa))).catch(() => {});
  }, []);
  // /gallery/taxa's `taxa` list already includes any Other Taxa species' raw taxon_class value
  // (e.g. "insecta") alongside the 18 built-in classes — otherTaxaClasses pulls those extras out
  // so they can render as their own checkboxes (same per-iconic-taxon breakdown Collection
  // already has), instead of only ever being filterable via the 18-class ALL_TAXON_CLASSES loop
  // below, which silently ignored them.
  const otherTaxaClasses = useMemo(
    () => [...(availableTaxa ?? [])].filter((tc) => !(ALL_TAXON_CLASSES as string[]).includes(tc)).sort(),
    [availableTaxa],
  );
  const [namingStyles, setNamingStyles] = useState<string[]>([]);
  useEffect(() => {
    api.get<{ speciesNamingStyles: string[] }>("/settings").then((res) => setNamingStyles(res.speciesNamingStyles)).catch(() => {});
  }, []);
  // The region filter should only ever offer regions the library actually has photos tagged in
  // (e.g. no Oceania option at all if there are zero Oceania photos) — RegionBrowser's own
  // `allowAnyRegion` mode otherwise shows literally every region in the taxonomy.
  const [regionsWithPhotos, setRegionsWithPhotos] = useState<Set<string> | null>(null);
  useEffect(() => {
    api.get<{ regionIds: string[] }>("/gallery/regions-with-photos").then((res) => setRegionsWithPhotos(new Set(res.regionIds))).catch(() => {});
  }, []);
  // Plain YYYY-MM-DD strings straight from native <input type="date"> — sent as-is to the
  // server, which treats dateTo as inclusive of that whole day (see gallery/routes.ts).
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  // Collapsed by default — expands into the two date inputs only once the user actually wants
  // to set a range, instead of taking up two always-visible input rows for a filter most
  // browsing sessions never touch.
  const [dateRangeOpen, setDateRangeOpen] = useState(false);
  // Only surfaces captures that already have a region_id set (chosen at import time) — same
  // caveat as location_label filtering elsewhere; no backfill attempted for older captures.
  const [regionId, setRegionId] = useState<string | null>(null);
  // Set from ?tag=X when arriving via a link (e.g. ManageTagsPage's own "N photos" count) —
  // otherwise an ordinary filter the user sets from the panel below like any other.
  const [tag, setTag] = useState<string | null>(() => searchParams.get("tag"));
  // A layout preference, persisted site-wide — "how I like to browse," unlike the content
  // filters above, which reset on every mount.
  const [sortBy, setSortBy] = usePersistedState<"newest" | "oldest" | "ratingHigh" | "ratingLow">("gallerySortBy", "newest");
  // rawFilter/mediaFilter are persisted (see above), but still count toward the badge when
  // they're off their own default preset ("photos"/"without") — the point of the badge is "why
  // am I seeing fewer photos than I expect," which is just as true for a standing preference as
  // for a one-off filter. Only the PRESET itself (photos, without RAW) is the neutral baseline.
  const activeFilterCount =
    (onlyTopRated ? 1 : 0) +
    (onlyFeatured ? 1 : 0) +
    (mediaFilter !== "photos" ? 1 : 0) +
    (rawFilter !== "without" ? 1 : 0) +
    (selectedTaxa.size > 0 ? 1 : 0) +
    (dateFrom || dateTo ? 1 : 0) +
    (regionId ? 1 : 0) +
    (tag ? 1 : 0);
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState(""); // debounced copy of searchInput actually sent to the server
  const [searching, setSearching] = useState(false);
  const searchAbortRef = useRef<AbortController | null>(null);
  // Hover-revealed "⋯" menu (same pattern as SpeciesDetailPage's own photo-grid menu) —
  // replaces an always-visible star badge, since "is this featured" is already answerable via
  // the Featured filter above rather than needing permanent on-card real estate.
  const { openKey: openMenuKey, setOpenKey: setOpenMenuKey, ref: openMenuRef } = useDropdownMenu<string>();
  // Right-click opened menu, separate from the "⋯" button — but still gated behind openMenuKey
  // (only one tile's menu open at a time), so it's automatically cleared by useDropdownMenu's
  // own outside-click handling the moment openMenuKey goes null, with no extra cleanup needed
  // here.
  const [contextMenuAnchor, setContextMenuAnchor] = useState<{ photoId: string; x: number; y: number } | null>(null);
  const [confirmingDeleteKey, setConfirmingDeleteKey] = useState<string | null>(null);
  const [addingToAlbumCaptureId, setAddingToAlbumCaptureId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Multi-select delete — same pattern as SpeciesDetailPage's own select mode: a "Select"
  // toggle, a toolbar showing the count + Delete selected, and one shared confirmation dialog
  // for both the single-photo and batch paths (confirmingDeleteKey covers both: batch delete
  // sets selectedCaptureIds to the full selection and reuses the same modal).
  const {
    selectMode,
    setSelectMode,
    selectedIds: selectedCaptureIds,
    setSelectedIds: setSelectedCaptureIds,
    toggle: toggleSelected,
    selectAll,
    dragPreviewIds,
    dragProps,
    exit: exitSelectModeBase,
  } = useSelectMode(items, (item) => item.captureId, startInSelectMode);
  const [confirmingBatchDelete, setConfirmingBatchDelete] = useState(false);
  const [deleteRawToo, setDeleteRawToo] = useState(false);
  // These take Escape before the select-mode shortcut below (it skips handled events).
  useEnterToConfirm(() => confirmingDeleteKey && void confirmDelete(confirmingDeleteKey), !!confirmingDeleteKey && !deleting);
  useEscapeToClose(() => setConfirmingDeleteKey(null), !!confirmingDeleteKey);
  useEnterToConfirm(() => void confirmDeleteSelected(), confirmingBatchDelete && !deleting);
  useEscapeToClose(() => {
    setConfirmingBatchDelete(false);
    setDeleteRawToo(false);
  }, confirmingBatchDelete);
  // Reveal runs on the API's machine, so it only makes sense for the desktop app's own local API.
  const inTauriShell = useIsTauri();
  const deploymentMode = useDeploymentMode();
  const canRevealInFinder = inTauriShell && deploymentMode === "desktop";
  // "Correct the ID" — same reassign-in-place pattern as SpeciesDetailPage: no batch endpoint,
  // just a Promise.allSettled loop over PATCH /captures/:id/reassign per selected photo.
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

  function load() {
    // Cancel whatever search request is still in flight before starting a new one — otherwise a
    // slow older response can resolve AFTER a newer one and overwrite it with stale results.
    searchAbortRef.current?.abort();

    if (searchQuery) {
      const params = new URLSearchParams({ q: searchQuery });
      if (onlyTopRated) params.set("onlyTopRated", "1");
      if (onlyFeatured) params.set("onlyFeatured", "1");
      if (selectedTaxa.size > 0) params.set("taxa", [...selectedTaxa].join(","));
      if (excludeHasRaw) params.set("excludeHasRaw", "1");
      if (onlyHasRaw) params.set("onlyHasRaw", "1");
      if (onlyVideo) params.set("onlyVideo", "1");
      if (excludeVideo) params.set("excludeVideo", "1");
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      if (regionId) params.set("regionId", regionId);
      const controller = new AbortController();
      searchAbortRef.current = controller;
      setSearching(true);
      api
        .get<{ items: GalleryItem[]; interpretation?: SearchInterpretation }>(`/gallery/search?${params}`, { signal: controller.signal })
        .then((res) => {
          setItems(res.items);
          setSearchReading(describeSearchReading(res.interpretation));
        })
        .catch((err) => {
          if (err instanceof Error && err.name === "AbortError") return;
          throw err;
        })
        .finally(() => setSearching(false));
      return;
    }

    const params = new URLSearchParams();
    if (onlyTopRated) params.set("onlyTopRated", "1");
    if (onlyFeatured) params.set("onlyFeatured", "1");
    if (missingDate) params.set("missingDate", "1");
    if (sortBy !== "newest") params.set("sort", sortBy);
    if (selectedTaxa.size > 0) params.set("taxa", [...selectedTaxa].join(","));
    if (excludeHasRaw) params.set("excludeHasRaw", "1");
    if (onlyHasRaw) params.set("onlyHasRaw", "1");
    if (onlyVideo) params.set("onlyVideo", "1");
    if (excludeVideo) params.set("excludeVideo", "1");
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    if (regionId) params.set("regionId", regionId);
    if (tag) params.set("tag", tag);
    api.get<{ items: GalleryItem[] }>(`/gallery?${params}`).then((res) => setItems(res.items));
  }

  useEffect(load, [onlyTopRated, onlyFeatured, missingDate, searchQuery, selectedTaxa, rawFilter, mediaFilter, dateFrom, dateTo, regionId, tag, sortBy]);

  const [savingDateCaptureId, setSavingDateCaptureId] = useState<string | null>(null);
  async function setTakenAt(captureId: string, takenAt: string) {
    setSavingDateCaptureId(captureId);
    try {
      await api.patch(`/captures/${captureId}/taken-at`, { takenAt: new Date(takenAt).toISOString() });
      // This view IS the "still missing a date" list — once fixed, the item no longer belongs
      // in it, so drop it locally instead of re-fetching the whole (now one-shorter) list.
      setItems((prev) => prev?.filter((it) => it.captureId !== captureId) ?? prev);
    } finally {
      setSavingDateCaptureId(null);
    }
  }

  // Debounce: only actually fire a search 200ms after the user stops typing, so every keystroke
  // doesn't cost its own CLIP text-encoder inference pass + DB scan.
  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(searchInput.trim()), 200);
    return () => clearTimeout(timer);
  }, [searchInput]);

  async function rateCapture(captureId: string, rating: number | null) {
    await api.patch(`/captures/${captureId}/rating`, { rating });
    load();
  }

  async function tagCapture(captureId: string, tags: string[]) {
    setItems((prev) => prev?.map((it) => (it.captureId === captureId ? { ...it, tags } : it)) ?? prev);
    setTagOptions((prev) => [...new Set([...prev, ...tags])].sort());
    await api.patch(`/captures/${captureId}/tags`, { tags });
  }

  async function toggleFeatured(item: GalleryItem) {
    await api.patch(`/species/${item.speciesId}/cover`, { photoId: item.isFeatured ? null : item.photoId });
    load();
  }

  // Same action/endpoint SpeciesDetailPage's own photo menu already uses — duplicated here for
  // now rather than shared, since these two pages don't yet have a common photo-card component
  // to hang it off of (a real follow-up: extract one, since this is exactly the kind of
  // "recreated in two places" the componentization ask is about).
  async function revealInFinder(path: string) {
    setOpenMenuKey(null);
    await api.post("/originals/reveal", { path }).catch(() => alert("Couldn't reveal that file. It may be unavailable."));
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

  // Shift-click range-select and click-and-drag range-select both live in useSelectMode now —
  // this page's own extra behavior on top of the shared hook is just where "exit" navigates to
  // when this Gallery is a dedicated "add photos to this album" picker (see targetAlbumId).
  function exitSelectMode() {
    setBulkTags([]);
    setBulkTagError(null);
    if (targetAlbumId) {
      navigate(`/albums/${targetAlbumId}`);
      return;
    }
    exitSelectModeBase();
  }

  // Disabled while the lightbox is open — its own Escape/←/→ handler owns the keyboard then,
  // and select-mode shortcuts have no meaning while it's up anyway (opening the lightbox and
  // being in select mode are mutually exclusive here — see PhotoTile's onClick).
  useKeyboardShortcuts(
    {
      escape: () => {
        if (selectMode) exitSelectMode();
      },
      "mod+a": (e) => {
        e.preventDefault();
        selectAll();
      },
      delete: () => {
        if (selectMode && selectedCaptureIds.size > 0) setConfirmingBatchDelete(true);
      },
      s: () => setSelectMode((v) => !v),
    },
    { enabled: lightboxIndex === null },
  );

  // Desktop-only: the native Edit menu's "Delete" item (see build_menu in lib.rs) fires this
  // same event Tauri-side — one action, two triggers, matching the DOM `delete` key above. A
  // plain browser tab / Docker deployment has no menu bar at all, so isTauri() gates the whole
  // dynamic import away in that context rather than failing to resolve the module.
  useEffect(() => {
    if (!isTauri() || lightboxIndex !== null) return;
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen("menu:delete-selected", () => {
        if (selectMode && selectedCaptureIds.size > 0) setConfirmingBatchDelete(true);
      }).then((fn) => {
        unlisten = fn;
      });
    });
    return () => unlisten?.();
  }, [lightboxIndex, selectMode, selectedCaptureIds]);

  const [addingToTargetAlbum, setAddingToTargetAlbum] = useState(false);
  async function addSelectedToTargetAlbum() {
    if (!targetAlbumId) return;
    setAddingToTargetAlbum(true);
    try {
      await api.post(`/albums/${targetAlbumId}/captures`, { captureIds: [...selectedCaptureIds] });
      navigate(`/albums/${targetAlbumId}`);
    } finally {
      setAddingToTargetAlbum(false);
    }
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
        videoUrl: i.kind === "video" ? `/api/photos/${i.photoId}/video` : null,
        caption: `${i.commonName ?? i.scientificName}${i.takenAt ? " · " + new Date(i.takenAt).toLocaleDateString() : ""}`,
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
    [items],
  );

  // Each entry keeps the item's index into the FLAT `items` array (not a per-bucket index) —
  // onOpen/toggleSelected/drag-select all index against that flat array (and so does `slides`
  // above), so a grouped tile's lightbox/select behavior stays identical to the ungrouped view.
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

  // One MasonryGrid instance per call — grouping renders several of these stacked under their
  // own region-name header (mirroring GroupedSpeciesGrid's own per-group sections), rather than
  // one grid with headers spliced in (which a masonry column layout can't do without breaking
  // column alignment across the header boundary). `i` in each entry is always the item's index
  // in the FLAT `items` array, so lightbox/select/drag behavior is identical either way.
  function renderGrid(entries: { item: GalleryItem; i: number }[]) {
    return (
      <MasonryGrid
        items={entries}
        columnWidth={thumbSizePx}
        gap={gridGapPx}
        extraHeightPx={extraHeightPx}
        extraHeightPxFor={
          showCameraInfo
            ? ({ item }, columnWidthPx) =>
                estimateShotDataWrapExtraPx(
                  shotDataLine({
                    camera_model: item.cameraModel,
                    lens: item.lens,
                    focal_length_mm: item.focalLengthMm,
                    aperture: item.aperture,
                    shutter: item.shutter,
                    iso: item.iso,
                  }),
                  columnWidthPx,
                  CAMERA_INFO_LINE_HEIGHT_PX,
                )
            : undefined
        }
        keyFor={({ item }) => item.photoId}
        aspectRatioFor={({ item }) => (item.width && item.height ? item.width / item.height : null)}
        renderItem={({ item, i }, aspectRatio) => (
          <PhotoTile
            key={item.photoId}
            photoId={item.photoId}
            alt={item.commonName ?? item.scientificName}
            kind={item.kind}
            durationSeconds={item.durationSeconds}
            onOpen={() => setLightboxIndex(i)}
            selectMode={selectMode}
            selected={selectedCaptureIds.has(item.captureId) || (dragPreviewIds?.has(item.captureId) ?? false)}
            onToggleSelect={(shiftKey) => toggleSelected(item.captureId, i, shiftKey)}
            onDragSelectStart={() => dragProps.onDragSelectStart(i)}
            onDragSelectEnter={() => dragProps.onDragSelectEnter(i)}
            aspectRatio={aspectRatio}
            cornerRadiusPx={gridCornerRadiusPx}
            menuOpen={openMenuKey === item.photoId && contextMenuAnchor?.photoId !== item.photoId}
            onToggleMenu={() => {
              setContextMenuAnchor(null);
              setOpenMenuKey(openMenuKey === item.photoId ? null : item.photoId);
            }}
            menuRef={openMenuRef}
            onOpenContextMenu={(point) => {
              setOpenMenuKey(item.photoId);
              setContextMenuAnchor({ photoId: item.photoId, ...point });
            }}
            contextMenuOpen={openMenuKey === item.photoId && contextMenuAnchor?.photoId === item.photoId}
            contextMenuAnchor={contextMenuAnchor?.photoId === item.photoId ? contextMenuAnchor : null}
            menuContent={
              <div
                className={`absolute right-0 top-full z-10 mt-1 rounded-md border border-line bg-surface py-1 shadow-lg ${
                  reassigningCaptureId === item.captureId || editingTagsCaptureId === item.captureId ? "w-56" : "w-44"
                }`}
              >
                <Link
                  to={`/species/${item.speciesId}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenMenuKey(null);
                  }}
                  className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted"
                >
                  View species
                </Link>
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
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setAddingToAlbumCaptureId(item.captureId);
                    setOpenMenuKey(null);
                  }}
                  className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted"
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
                    className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted"
                  >
                    Edit tags…
                  </button>
                )}
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
                {/* Hidden when the only original on file IS the RAW (originalKind === "raw") —
                    "Download RAW" right below already covers that file; showing both just
                    offered two buttons for the exact same download. */}
                {item.originalRef && item.originalKind !== "raw" && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenMenuKey(null);
                      downloadFile(`/api/photos/${item.photoId}/original?download=1`, "original.jpg");
                    }}
                    className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted"
                  >
                    Download original
                  </button>
                )}
                {item.hasRawOriginal && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenMenuKey(null);
                      downloadFile(`/api/photos/${item.photoId}/original-raw?download=1`, "original.raw");
                    }}
                    className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted"
                  >
                    Download RAW
                  </button>
                )}
                {canRevealInFinder && item.originalRef && !item.originalManaged && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      revealInFinder(item.originalRef!);
                    }}
                    className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted"
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
                  className="block w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-surface-muted"
                >
                  Delete {item.kind === "video" ? "Video" : "Photo"}
                </button>
              </div>
            }
            label={
              <>
                {showLabels && (
                  <p className="mt-1 truncate text-[11px] text-muted">{item.commonName ?? item.scientificName}</p>
                )}
                {showRatings && (
                  // Its own gap from the photo when it's the first line under it (names hidden),
                  // matching the species page; tighter under a name so the two read as one caption.
                  <div className={showLabels ? "mt-0.5" : "mt-1"}>
                    <StarRating rating={item.qualityRating} onRate={(rating) => rateCapture(item.captureId, rating)} />
                  </div>
                )}
                {showCameraInfo &&
                  shotDataLine({
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
                {missingDate && (
                  <input
                    type="date"
                    disabled={savingDateCaptureId === item.captureId}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => e.target.value && setTakenAt(item.captureId, e.target.value)}
                    className="mt-1 w-full rounded border border-line bg-surface px-1.5 py-0.5 text-[11px] text-ink disabled:opacity-50"
                  />
                )}
              </>
            }
          />
        )}
      />
    );
  }

  return (
    <div className="min-h-screen bg-canvas">
      {targetAlbumId ? (
        // A dedicated picker, not a page you browsed INTO — no back link (Cancel below already
        // exits it) and no "Gallery" title, which would both be misleading here. Uses a real
        // <header className="page-header"> (not a plain <div>) so TitleBarDragRegion can find
        // it and size the title-bar gradient/drag overlay to this header's real height, same as
        // every other page — a plain div here left it invisible to that lookup, falling back to
        // a fixed-size overlay that didn't match this header's actual bottom edge.
        <header className="page-header border-b border-line bg-surface px-6 py-4">
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
            {searching && <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line border-t-accent" aria-label="Searching…" />}

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
                    Top Rated
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
                        onClick={() =>
                          setSelectedTaxa((prev) => {
                            const next = new Set(prev);
                            if (next.has(tc)) next.delete(tc);
                            else next.add(tc);
                            return next;
                          })
                        }
                      >
                        {taxonDisplayLabel(tc, namingStyles)}
                      </Pill>
                    ))}
                    {otherTaxaClasses.map((tc) => (
                      <Pill
                        key={tc}
                        size="sm"
                        active={selectedTaxa.has(tc)}
                        onClick={() =>
                          setSelectedTaxa((prev) => {
                            const next = new Set(prev);
                            if (next.has(tc)) next.delete(tc);
                            else next.add(tc);
                            return next;
                          })
                        }
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
            {items.length > 0 && (
              <SelectModeToggle active={selectMode} onEnter={() => setSelectMode(true)} onExit={exitSelectMode} />
            )}
          </div>
        )
        }
      >
        {items && (
          <p className="text-xs text-muted">
            {missingDate
              ? `${items.length} photo${items.length === 1 ? "" : "s"} missing a date. Pick one below to fix it`
              : `${items.length} photos${searchQuery ? ` matching "${searchQuery}"` : ""}${searchQuery && searchReading ? `: ${searchReading}` : ""}`}
          </p>
        )}
      </PageHeader>
      )}

      {selectMode && (
        <div className="flex items-center gap-3 border-b border-line bg-surface-muted px-6 py-2 text-xs">
          <span className="shrink-0 text-muted">{selectedCaptureIds.size} selected</span>
          {/* Always present (even with nothing to show) so it acts as a constant flex spacer —
             without it, this row's remaining controls visibly shift around depending on
             whether anything's selected, since they're the only other children left. */}
          <div className="flex min-w-0 flex-1 items-center gap-6">
            {/* ID correction doesn't apply in the "add photos to this album" picker — the point
               of this view is choosing which photos go in, not re-identifying them. */}
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
                        // Only the newly-added tag(s) get sent — bulkTags is just this toolbar's
                        // own running "what have I added this session" list, not a set that gets
                        // re-applied wholesale on every change (that would also re-apply, harmlessly
                        // but redundantly, tags already sent by an earlier keystroke in this batch).
                        const added = tags.filter((t) => !bulkTags.includes(t));
                        setBulkTags(tags);
                        setBulkTagError(null);
                        if (added.length > 0) {
                          api
                            .patch("/captures/tags", { captureIds: [...selectedCaptureIds], tags: added })
                            .then(() => setTagOptions((prev) => [...new Set([...prev, ...added])].sort()))
                            .catch((err) => {
                              // Drop the chip again so a failed tag doesn't read as applied.
                              console.error(err);
                              setBulkTags((prev) => prev.filter((t) => !added.includes(t)));
                              setBulkTagError(errorMessage(err, "Couldn't add that tag"));
                            });
                        }
                      }}
                    />
                  </div>
                </div>
                {bulkTags.length > 0 && (
                  <button onClick={exitSelectMode} className="shrink-0 rounded-md bg-accent px-3 py-1 text-xs font-medium text-accent-fg">
                    Done
                  </button>
                )}
              </>
            )}
          </div>
          {targetAlbumId ? (
            <button
              onClick={addSelectedToTargetAlbum}
              disabled={selectedCaptureIds.size === 0 || addingToTargetAlbum}
              className="shrink-0 rounded-md bg-accent px-3 py-1 text-xs font-medium text-accent-fg disabled:opacity-40"
            >
              {addingToTargetAlbum ? "Adding…" : `Add ${selectedCaptureIds.size || ""} to album`}
            </button>
          ) : (
            <AddToAlbumButton captureIds={[...selectedCaptureIds]} onAdded={exitSelectMode} />
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
      {bulkTagError && <p className="border-b border-line bg-surface px-6 py-2 text-xs text-red-600">{bulkTagError}</p>}

      <main className="p-6">
        {!items ? (
          <Spinner />
        ) : items.length === 0 ? (
          missingDate || searchQuery || onlyTopRated || onlyFeatured ? (
            <p className="text-muted">
              {missingDate
                ? "Every photo has a date. Nothing to fix here."
                : searchQuery
                  ? `No photos match "${searchQuery}".`
                  : "No photos match the selected filters."}
            </p>
          ) : (
            <EmptyState
              icon={
                <svg viewBox="0 0 24 24" className="h-6 w-6 text-muted" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <circle cx="9" cy="11" r="2" />
                  <path d="m21 16-4.5-4.5L9 19" />
                </svg>
              }
              title="No photos yet"
              description="Upload one from a species page to get started."
            />
          )
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
          renderGrid(items.map((item, i) => ({ item, i })))
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

      {addingToAlbumCaptureId && (
        <AddToAlbumModal captureIds={[addingToAlbumCaptureId]} onClose={() => setAddingToAlbumCaptureId(null)} />
      )}

      {confirmingDeleteKey && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setConfirmingDeleteKey(null)}
        >
          <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-4 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-medium text-ink">
              Delete this {items?.find((it) => it.captureId === confirmingDeleteKey)?.kind === "video" ? "video" : "photo"}?
            </h3>
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
              {(() => {
                const selected = (items ?? []).filter((it) => selectedCaptureIds.has(it.captureId));
                const hasVideo = selected.some((it) => it.kind === "video");
                const hasPhoto = selected.some((it) => it.kind !== "video");
                const noun = hasVideo && hasPhoto ? "file" : hasVideo ? "video" : "photo";
                return `Delete ${selectedCaptureIds.size} ${noun}${selectedCaptureIds.size === 1 ? "" : "s"}?`;
              })()}
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
