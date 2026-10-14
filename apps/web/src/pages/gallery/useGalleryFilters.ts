import { useEffect, useState } from "react";
import type { SetURLSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { usePersistedState } from "../../hooks/usePersistedState";
import { GALLERY_EDITED_RAW_KEY, GALLERY_RAW_FILES_KEY } from "../../lib/search/palette";
import {
  DEFAULT_RAW_FILES,
  type EditedRawFilter,
  type MediaFilter,
  type PhotoSort,
  type RawFilesFilter,
} from "../../lib/photoListFilters";
import { countActiveFilters, shotKindForSearch } from "./galleryHelpers";
import type { GalleryQuery } from "./types";
import { ignore } from "../../lib/ignore";

type Scope = { id: string; name: string | null };

// The Gallery's search, filters and sort. Some arrive in the URL (?q=, ?tag=, ?missingDate=1,
// Stats' ?taxon=, ?shotKind=, ?tier= (with ?tierRegionId= and ?regionId= for a local tier),
// and the palette's ?tripId= / ?inAlbum= scopes); the search is kept in ?q= so back restores it.
export function useGalleryFilters(searchParams: URLSearchParams, setSearchParams: SetURLSearchParams) {
  const [onlyTopRated, setOnlyTopRated] = useState(false);
  const [onlyHidden, setOnlyHidden] = useState(false);
  const [onlyFeatured, setOnlyFeatured] = useState(false);
  // From Stats' "Missing date" row. Read once: fixing a date drops the item locally.
  const [missingDate] = useState(() => searchParams.get("missingDate") === "1");
  const [selectedTaxa, setSelectedTaxa] = useState<Set<string>>(() => {
    const taxon = searchParams.get("taxon");
    return new Set(taxon ? [taxon] : []);
  });
  const [shotKind, setShotKind] = useState<string | null>(() => searchParams.get("shotKind"));
  const [tier, setTier] = useState<string | null>(() => searchParams.get("tier"));
  const [tierRegionId, setTierRegionId] = useState<string | null>(() => searchParams.get("tierRegionId"));
  // Persisted browsing presets: edited photos with no RAW-only ones, photos only, is the default.
  const [rawFiles, setRawFiles] = usePersistedState<RawFilesFilter>(GALLERY_RAW_FILES_KEY, DEFAULT_RAW_FILES);
  const [editedRaw, setEditedRaw] = usePersistedState<EditedRawFilter>(GALLERY_EDITED_RAW_KEY, "any");
  const [mediaFilter, setMediaFilter] = usePersistedState<MediaFilter>("galleryMediaFilter", "photos");
  // YYYY-MM-DD; the server treats dateTo as inclusive.
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [dateRangeOpen, setDateRangeOpen] = useState(false);
  const [regionId, setRegionId] = useState<string | null>(() => searchParams.get("regionId"));
  // Seeded from ?tag=X (e.g. Manage tags' photo counts).
  const [tag, setTag] = useState<string | null>(() => searchParams.get("tag"));
  // From the palette's "search this trip/album": ?tripId= or ?inAlbum= (albumId is the add-photos picker).
  const [scopeTrip, setScopeTrip] = useState<Scope | null>(() => {
    const id = searchParams.get("tripId");
    return id ? { id, name: null } : null;
  });
  const [scopeAlbum, setScopeAlbum] = useState<Scope | null>(() => {
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
      .catch(ignore("Couldn't load the trip name"));
  }, [scopeTripId]);
  useEffect(() => {
    if (!scopeAlbumId) return;
    api
      .get<{ name: string }>(`/albums/${scopeAlbumId}`)
      .then((res) => setScopeAlbum((prev) => (prev?.id === scopeAlbumId ? { ...prev, name: res.name } : prev)))
      .catch(ignore("Couldn't load the album name"));
  }, [scopeAlbumId]);
  // Stats' filters arrive in the URL, so clearing one drops it there too.
  function dropParam(name: string) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(name);
        return next;
      },
      { replace: true },
    );
  }
  function clearShotKind() {
    setShotKind(null);
    dropParam("shotKind");
  }
  function clearTier() {
    setTier(null);
    setTierRegionId(null);
    dropParam("tier");
    dropParam("tierRegionId");
  }
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
  const [sortBy, setSortBy] = usePersistedState<PhotoSort>("gallerySortBy", "newest");
  // The query lives in ?q= so back navigation restores it.
  const [searchInput, setSearchInput] = useState(() => searchParams.get("q") ?? "");
  // Debounced copy of searchInput that is actually sent.
  const [searchQuery, setSearchQuery] = useState(() => {
    const q = (searchParams.get("q") ?? "").trim();
    return q.length >= 3 ? q : "";
  });

  // 80ms debounce: the quick pass answers in milliseconds. Under three characters there's
  // nothing meaningful to match, so the whole gallery stays.
  useEffect(() => {
    const typed = searchInput.trim();
    const timer = setTimeout(() => setSearchQuery(typed.length >= 3 ? typed : ""), 80);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // The search palette hands off with /gallery?q=, which can arrive while this page is open. Our
  // own write below always carries the current searchQuery, so it changes nothing here.
  const urlQuery = searchParams.get("q") ?? "";
  const [seenUrlQuery, setSeenUrlQuery] = useState(urlQuery);
  if (seenUrlQuery !== urlQuery) {
    setSeenUrlQuery(urlQuery);
    const q = urlQuery.trim();
    const effective = q.length >= 3 ? q : "";
    if (effective !== searchQuery) {
      setSearchInput(urlQuery);
      setSearchQuery(effective);
    }
  }

  useEffect(() => {
    if ((searchParams.get("q") ?? "") === searchQuery) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (searchQuery) next.set("q", searchQuery);
        else next.delete("q");
        return next;
      },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mirrors only a committed search into the URL; other param changes come the other way
  }, [searchQuery]);

  // "flight" on its own is Stats' Flight shots, not a picture search (shotKindForSearch).
  const typedShotKind = shotKindForSearch(searchQuery);
  const query: GalleryQuery = {
    searchQuery: typedShotKind ? "" : searchQuery,
    onlyHidden,
    onlyTopRated,
    onlyFeatured,
    missingDate,
    shotKind: shotKind ?? typedShotKind,
    tier,
    tierRegionId,
    selectedTaxa,
    rawFiles,
    editedRaw,
    mediaFilter,
    dateFrom,
    dateTo,
    regionId,
    tag,
    scopeTripId,
    scopeAlbumId,
    sortBy,
  };
  // The typed kind is the search, not a filter, so it doesn't count toward the Filters badge.
  const activeFilterCount = countActiveFilters({ ...query, shotKind });

  function clearFilters() {
    // With nothing but the presets active, "clear" means show everything.
    const onlyPresets = activeFilterCount === 0 && !searchQuery;
    setOnlyTopRated(false);
    setOnlyHidden(false);
    setOnlyFeatured(false);
    setMediaFilter(onlyPresets ? "both" : "photos");
    setRawFiles(onlyPresets ? "show" : DEFAULT_RAW_FILES);
    setEditedRaw("any");
    setSelectedTaxa(new Set());
    setDateFrom("");
    setDateTo("");
    setDateRangeOpen(false);
    setRegionId(null);
    setTag(null);
    clearShotKind();
    clearTier();
    if (scopeTripId) clearScope("trip");
    if (scopeAlbumId) clearScope("album");
    setSearchInput("");
    setSearchQuery("");
  }

  return {
    query,
    activeFilterCount,
    clearFilters,
    searchInput,
    setSearchInput,
    setOnlyTopRated,
    setOnlyHidden,
    setOnlyFeatured,
    setSelectedTaxa,
    setRawFiles,
    setEditedRaw,
    setMediaFilter,
    setDateFrom,
    setDateTo,
    dateRangeOpen,
    setDateRangeOpen,
    setRegionId,
    setTag,
    setSortBy,
    scopeTrip,
    scopeAlbum,
    clearScope,
    shotKind,
    clearShotKind,
    clearTier,
  };
}

export type GalleryFilters = ReturnType<typeof useGalleryFilters>;
