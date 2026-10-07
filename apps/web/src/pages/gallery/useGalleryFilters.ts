import { useEffect, useState } from "react";
import type { SetURLSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { usePersistedState } from "../../hooks/usePersistedState";
import type { MediaFilter, PhotoSort, RawFilter } from "../../lib/photoListFilters";
import { countActiveFilters } from "./galleryHelpers";
import type { GalleryQuery } from "./types";

type Scope = { id: string; name: string | null };

// The Gallery's search, filters and sort. Some arrive in the URL (?q=, ?tag=, ?missingDate=1,
// and the palette's ?tripId= / ?inAlbum= scopes); the search is kept in ?q= so back restores it.
export function useGalleryFilters(searchParams: URLSearchParams, setSearchParams: SetURLSearchParams) {
  const [onlyTopRated, setOnlyTopRated] = useState(false);
  const [onlyHidden, setOnlyHidden] = useState(false);
  const [onlyFeatured, setOnlyFeatured] = useState(false);
  // From Stats' "Missing date" row. Read once: fixing a date drops the item locally.
  const [missingDate] = useState(() => searchParams.get("missingDate") === "1");
  const [selectedTaxa, setSelectedTaxa] = useState<Set<string>>(new Set());
  // Persisted browsing presets; "without RAW, photos only" is the neutral default.
  const [rawFilter, setRawFilter] = usePersistedState<RawFilter>("galleryRawFilter", "without");
  const [mediaFilter, setMediaFilter] = usePersistedState<MediaFilter>("galleryMediaFilter", "photos");
  // YYYY-MM-DD; the server treats dateTo as inclusive.
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [dateRangeOpen, setDateRangeOpen] = useState(false);
  const [regionId, setRegionId] = useState<string | null>(null);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  const query: GalleryQuery = {
    searchQuery,
    onlyHidden,
    onlyTopRated,
    onlyFeatured,
    missingDate,
    selectedTaxa,
    rawFilter,
    mediaFilter,
    dateFrom,
    dateTo,
    regionId,
    tag,
    scopeTripId,
    scopeAlbumId,
    sortBy,
  };
  const activeFilterCount = countActiveFilters(query);

  function clearFilters() {
    // With nothing but the presets active, "clear" means show everything.
    const onlyPresets = activeFilterCount === 0 && !searchQuery;
    setOnlyTopRated(false);
    setOnlyHidden(false);
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
    setRawFilter,
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
  };
}

export type GalleryFilters = ReturnType<typeof useGalleryFilters>;
