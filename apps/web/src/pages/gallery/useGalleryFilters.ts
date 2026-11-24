import { useEffect, useMemo, useState } from "react";
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
import { SHOT_ACTIONS, SHOT_FRAMINGS, parseShotList } from "@lifer/shared";
import {
  NO_APPEARANCE_FILTER,
  appearanceFromParams,
  countActiveFilters,
  shotTypeForKind,
  shotTypeForSearch,
  shotTypeValues,
} from "./galleryHelpers";
import type { AppearanceFilter, AppearanceKind, GalleryQuery } from "./types";
import { ignore } from "../../lib/ignore";

type Scope = { id: string; name: string | null };

// A whole number from the URL, or null.
function intParam(params: URLSearchParams, name: string): number | null {
  const n = Number(params.get(name));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Where a page saves its browsing presets. */
export interface PresetKeys {
  rawFiles: string;
  editedRaw: string;
  media: string;
  sort: string;
}
const GALLERY_KEYS: PresetKeys = {
  rawFiles: GALLERY_RAW_FILES_KEY,
  editedRaw: GALLERY_EDITED_RAW_KEY,
  media: "galleryMediaFilter",
  sort: "gallerySortBy",
};

// A browsing preset the Gallery remembers. A seeded copy (the smart album rule builder) keeps its
// own, so editing rules never changes how the Gallery opens.
function usePreset<T>(key: string, fallback: T, seeded: T | undefined): [T, (value: T) => void] {
  const persisted = usePersistedState<T>(key, fallback);
  const local = useState<T>(seeded ?? fallback);
  return seeded === undefined ? persisted : local;
}

// The Gallery's search, filters and sort. Some arrive in the URL (?q=, ?tag=, ?missingDate=1,
// Stats' ?taxon=, ?action= and ?framing= (or an old link's ?shotKind=), ?tier= (with ?tierRegionId= and ?regionId= for a local tier),
// and the palette's ?tripId= / ?inAlbum= scopes); the search is kept in ?q= so back restores it.
// With `seed` (a smart album's rules) it starts from those instead. Album and trip pages share it
// with their own saved presets (`keys`) and without the ?q= search (`search: false`).
export function useGalleryFilters(
  searchParams: URLSearchParams,
  setSearchParams: SetURLSearchParams,
  seed?: Omit<GalleryQuery, "sortBy">,
  {
    keys = GALLERY_KEYS,
    search = true,
    alsoClear = [],
  }: { keys?: PresetKeys; search?: boolean; alsoClear?: readonly string[] } = {},
) {
  // Every filter is in the URL too, so Back returns to exactly this view.
  const fromUrl = !seed;
  const [ratingMin, setRatingMin] = useState<number | null>(() =>
    fromUrl ? intParam(searchParams, "ratingMin") : seed.ratingMin,
  );
  const [ratingMax, setRatingMax] = useState<number | null>(() =>
    fromUrl ? intParam(searchParams, "ratingMax") : seed.ratingMax,
  );
  const [unrated, setUnrated] = useState(() => (fromUrl ? searchParams.get("unrated") === "1" : seed.unrated));
  const [animalsMin, setAnimalsMin] = useState<number | null>(() =>
    fromUrl ? intParam(searchParams, "animalsMin") : seed.animalsMin,
  );
  const [animalsMax, setAnimalsMax] = useState<number | null>(() =>
    fromUrl ? intParam(searchParams, "animalsMax") : seed.animalsMax,
  );
  const [onlyHidden, setOnlyHidden] = useState(() => (fromUrl ? searchParams.get("hidden") === "1" : seed.onlyHidden));
  const [onlyFeatured, setOnlyFeatured] = useState(() =>
    fromUrl ? searchParams.get("onlyFeatured") === "1" : seed.onlyFeatured,
  );
  const [notOnInat, setNotOnInat] = useState(() => (fromUrl ? searchParams.get("notOnInat") === "1" : seed.notOnInat));
  // From Stats' "Missing date" row too. Fixing a date drops the item locally, not by refetching.
  const [missingDate, setMissingDateState] = useState(
    () => seed?.missingDate ?? searchParams.get("missingDate") === "1",
  );
  const [missingCoordinates, setMissingCoordinatesState] = useState(
    () => seed?.missingCoordinates ?? searchParams.get("missingCoordinates") === "1",
  );
  // ?taxa=a,b, or Stats' single ?taxon=. Not ?taxon= itself: a trip's or album's species view owns that.
  const [selectedTaxa, setSelectedTaxa] = useState<Set<string>>(() => {
    if (seed) return seed.selectedTaxa;
    const taxa = (searchParams.get("taxa") ?? searchParams.get("taxon") ?? "").split(",").filter(Boolean);
    return new Set(taxa);
  });
  // From the URL: the two axes, plus an old link's single ?shotKind=.
  const [urlShotType] = useState(() => {
    const legacy = shotTypeForKind(searchParams.get("shotKind"));
    return {
      actions: new Set([...parseShotList(searchParams.get("action"), SHOT_ACTIONS), ...legacy.actions]),
      framings: new Set([...parseShotList(searchParams.get("framing"), SHOT_FRAMINGS), ...legacy.framings]),
    };
  });
  const [shotActions, setShotActions] = useState<ReadonlySet<string>>(() => seed?.shotActions ?? urlShotType.actions);
  const [shotFramings, setShotFramings] = useState<ReadonlySet<string>>(
    () => seed?.shotFramings ?? urlShotType.framings,
  );
  const [tiers, setTiers] = useState<readonly string[]>(() => (seed ? seed.tiers : searchParams.getAll("tier")));
  const [tierRegionId, setTierRegionId] = useState<string | null>(() =>
    seed ? seed.tierRegionId : searchParams.get("tierRegionId"),
  );
  // Persisted browsing presets: every photo, RAW-only ones included, and no videos is the default.
  // Only a user's own pick is stored, so a saved "hide" stays and counts as an active filter.
  const [rawFiles, setRawFiles] = usePreset<RawFilesFilter>(keys.rawFiles, DEFAULT_RAW_FILES, seed?.rawFiles);
  const [editedRaw, setEditedRaw] = usePreset<EditedRawFilter>(keys.editedRaw, "any", seed?.editedRaw);
  const [mediaFilter, setMediaFilter] = usePreset<MediaFilter>(keys.media, "photos", seed?.mediaFilter);
  // YYYY-MM-DD; the server treats dateTo as inclusive.
  const [dateFrom, setDateFrom] = useState(() => (fromUrl ? (searchParams.get("dateFrom") ?? "") : seed.dateFrom));
  const [dateTo, setDateTo] = useState(() => (fromUrl ? (searchParams.get("dateTo") ?? "") : seed.dateTo));
  const [dateRangeOpen, setDateRangeOpen] = useState(() => !!(dateFrom || dateTo));
  // Each takes several values, repeated in the URL (?regionId=a&regionId=b): any one matches.
  const [regionIds, setRegionIdsState] = useState<readonly string[]>(() =>
    seed ? seed.regionIds : searchParams.getAll("regionId"),
  );
  // Seeded from ?tag=X (e.g. Manage tags' photo counts).
  const [tags, setTagsState] = useState<readonly string[]>(() => (seed ? seed.tags : searchParams.getAll("tag")));
  // Seeded from ?place=X (Settings > Library > Places), or picked in the Filters panel.
  const [places, setPlacesState] = useState<readonly string[]>(() =>
    seed ? seed.places : searchParams.getAll("place"),
  );
  // ?lifeStage=, ?sex=, ?plumage= and ?morph=, each repeated for several values.
  const [appearance, setAppearanceState] = useState<AppearanceFilter>(() =>
    seed ? seed.appearance : appearanceFromParams(searchParams),
  );
  // From a point clicked on the map view: ?bbox=west,south,east,north.
  const [bbox, setBboxState] = useState<string | null>(() => (seed ? (seed.bbox ?? null) : searchParams.get("bbox")));
  // From the palette's "search this trip/album": ?tripId= or ?inAlbum= (albumId is the add-photos picker).
  const [scopeTrip, setScopeTrip] = useState<Scope | null>(() => {
    const id = seed ? seed.scopeTripId : searchParams.get("tripId");
    return id ? { id, name: null } : null;
  });
  const [scopeAlbum, setScopeAlbum] = useState<Scope | null>(() => {
    const id = seed ? seed.scopeAlbumId : searchParams.get("inAlbum");
    return id ? { id, name: null } : null;
  });
  const scopeTripId = scopeTrip?.id ?? null;
  const scopeAlbumId = scopeAlbum?.id ?? null;
  // Read from the URL each render: "Similar photos" is a link, which can arrive while the page is open.
  const similarTo = seed ? null : searchParams.get("similarTo");
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
  // Stats' filters arrive in the URL, so setting or clearing one writes it there too. One call
  // per change: setSearchParams' updater sees the render's params, so a second call would undo the first.
  function writeParams(values: Record<string, string | readonly string[] | null>) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [name, value] of Object.entries(values)) {
          next.delete(name);
          if (typeof value === "string") {
            if (value) next.set(name, value);
          } else for (const v of value ?? []) next.append(name, v);
        }
        return next;
      },
      { replace: true },
    );
  }
  // The new fields are written from now on; an old ?shotKind= goes with the first change.
  function changeShotType(axis: "action" | "framing", next: ReadonlySet<string>) {
    if (axis === "action") setShotActions(next);
    else setShotFramings(next);
    const values = shotTypeValues(next, axis === "action" ? SHOT_ACTIONS : SHOT_FRAMINGS);
    writeParams({ [axis]: values.join(",") || null, shotKind: null });
  }
  // A local tier (tierRegionId) stays while switching tiers; clearing the tiers drops both.
  function changeTiers(value: readonly string[]) {
    setTiers(value);
    if (value.length === 0) setTierRegionId(null);
    writeParams(value.length > 0 ? { tier: value } : { tier: null, tierRegionId: null });
  }
  function setRegionIds(value: readonly string[]) {
    setRegionIdsState(value);
    writeParams({ regionId: value });
  }
  function setTags(value: readonly string[]) {
    setTagsState(value);
    writeParams({ tag: value });
  }
  function setMissingDate(value: boolean) {
    setMissingDateState(value);
    writeParams({ missingDate: value ? "1" : null });
  }
  function setMissingCoordinates(value: boolean) {
    setMissingCoordinatesState(value);
    writeParams({ missingCoordinates: value ? "1" : null });
  }
  function clearScope(kind: "trip" | "album" | "similar") {
    if (kind === "similar") {
      // A new history entry, so Back returns to the group.
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete("similarTo");
        return next;
      });
      return;
    }
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
  // One setter, so Unrated never combines with a range and a 5 or too-low maximum means no cap.
  function setRating(min: number | null, max: number | null, onlyUnrated = false) {
    setUnrated(onlyUnrated);
    setRatingMin(onlyUnrated ? null : min);
    setRatingMax(onlyUnrated || max === null || max === 5 || (min !== null && max < min) ? null : max);
  }
  // "Exactly" sets both ends; "at least" only the minimum.
  function setAnimals(min: number | null, exact: boolean) {
    setAnimalsMin(min);
    setAnimalsMax(exact ? min : null);
  }
  // The filters kept as plain state, mirrored into the URL after each change so Back restores
  // them. One write per commit: two writes in one click would each start from the same params.
  const urlValues: Record<string, string | null> = {
    ratingMin: ratingMin ? String(ratingMin) : null,
    ratingMax: ratingMax ? String(ratingMax) : null,
    unrated: unrated ? "1" : null,
    animalsMin: animalsMin ? String(animalsMin) : null,
    animalsMax: animalsMax ? String(animalsMax) : null,
    hidden: onlyHidden ? "1" : null,
    onlyFeatured: onlyFeatured ? "1" : null,
    notOnInat: notOnInat ? "1" : null,
    taxa: [...selectedTaxa].join(",") || null,
    dateFrom: dateFrom || null,
    dateTo: dateTo || null,
  };
  const urlKey = JSON.stringify(urlValues);
  useEffect(() => {
    if (seed) return;
    const values: Record<string, string | null> = JSON.parse(urlKey);
    const stale = Object.entries(values).some(([name, value]) => searchParams.get(name) !== value);
    // In the Gallery, Stats' one-off ?taxon= gives way to ?taxa=; elsewhere ?taxon= is the species view's.
    if (stale) writeParams(search ? { ...values, taxon: null } : values);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mirrors these filters only; other params change the other way
  }, [urlKey]);
  function setPlaces(value: readonly string[]) {
    setPlacesState(value);
    writeParams({ place: value });
  }
  function setAppearance(kind: AppearanceKind, value: readonly string[]) {
    setAppearanceState((prev) => ({ ...prev, [kind]: value }));
    writeParams({ [kind]: value });
  }
  // `alsoWrite`: other params changed in the same step (the map view closing as it opens an area).
  function setBbox(value: string | null, alsoWrite: Record<string, string | null> = {}) {
    setBboxState(value);
    writeParams({ bbox: value, ...alsoWrite });
  }
  const [sortBy, setSortBy] = usePersistedState<PhotoSort>(keys.sort, "newest");
  // The query lives in ?q= so back navigation restores it.
  const urlQuery = search ? (searchParams.get("q") ?? "") : "";
  const [searchInput, setSearchInput] = useState(() => seed?.searchQuery ?? urlQuery);
  // Debounced copy of searchInput that is actually sent.
  const [searchQuery, setSearchQuery] = useState(() => {
    const q = (seed?.searchQuery ?? urlQuery).trim();
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
    if (!search || (searchParams.get("q") ?? "") === searchQuery) return;
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

  // "flight" on its own is the Shot type filter, not a picture search (shotTypeForSearch).
  const typedShotType = useMemo(() => shotTypeForSearch(searchQuery), [searchQuery]);
  const query: GalleryQuery = {
    searchQuery: typedShotType || similarTo ? "" : searchQuery,
    onlyHidden,
    ratingMin,
    ratingMax,
    unrated,
    animalsMin,
    animalsMax,
    onlyFeatured,
    notOnInat,
    missingDate,
    missingCoordinates,
    // A chosen axis wins over the typed one.
    shotActions: shotActions.size > 0 || !typedShotType ? shotActions : typedShotType.actions,
    shotFramings: shotFramings.size > 0 || !typedShotType ? shotFramings : typedShotType.framings,
    tiers,
    tierRegionId,
    selectedTaxa,
    rawFiles,
    editedRaw,
    mediaFilter,
    dateFrom,
    dateTo,
    regionIds,
    tags,
    places,
    appearance,
    bbox,
    similarTo,
    scopeTripId,
    scopeAlbumId,
    sortBy,
  };
  // The typed kind is the search, not a filter, so it doesn't count toward the Filters badge.
  const activeFilterCount = countActiveFilters({ ...query, shotActions, shotFramings });

  function clearFilters() {
    // With nothing but the presets active, "clear" means show everything.
    const onlyPresets = activeFilterCount === 0 && !searchQuery;
    setRating(null, null);
    setAnimals(null, false);
    setOnlyHidden(false);
    setOnlyFeatured(false);
    setNotOnInat(false);
    setMediaFilter(onlyPresets ? "both" : "photos");
    setRawFiles(DEFAULT_RAW_FILES);
    setEditedRaw("any");
    setSelectedTaxa(new Set());
    setDateFrom("");
    setDateTo("");
    setDateRangeOpen(false);
    setRegionIdsState([]);
    setTagsState([]);
    setPlacesState([]);
    setAppearanceState(NO_APPEARANCE_FILTER);
    setBboxState(null);
    setMissingDateState(false);
    setMissingCoordinatesState(false);
    setShotActions(new Set());
    setShotFramings(new Set());
    setTiers([]);
    setTierRegionId(null);
    setScopeTrip(null);
    setScopeAlbum(null);
    writeParams({
      missingDate: null,
      missingCoordinates: null,
      shotKind: null,
      action: null,
      framing: null,
      tier: null,
      tierRegionId: null,
      tripId: null,
      inAlbum: null,
      regionId: null,
      tag: null,
      place: null,
      lifeStage: null,
      sex: null,
      plumage: null,
      morph: null,
      bbox: null,
      // A page's own filters kept in the URL (a trip's species), cleared in the same write.
      ...Object.fromEntries(alsoClear.map((name) => [name, null])),
    });
    setSearchInput("");
    setSearchQuery("");
  }

  // Replaces every filter with a saved set (a pinned filter): one URL write, as clearFilters does.
  function applyQuery(q: Omit<GalleryQuery, "sortBy">) {
    setRating(q.ratingMin, q.ratingMax, q.unrated);
    setAnimalsMin(q.animalsMin);
    setAnimalsMax(q.animalsMax);
    setOnlyHidden(q.onlyHidden);
    setOnlyFeatured(q.onlyFeatured);
    setNotOnInat(q.notOnInat);
    setMediaFilter(q.mediaFilter);
    setRawFiles(q.rawFiles);
    setEditedRaw(q.editedRaw);
    setSelectedTaxa(new Set(q.selectedTaxa));
    setDateFrom(q.dateFrom);
    setDateTo(q.dateTo);
    setDateRangeOpen(!!(q.dateFrom || q.dateTo));
    setRegionIdsState(q.regionIds);
    setTagsState(q.tags);
    setPlacesState(q.places);
    setAppearanceState(q.appearance);
    setBboxState(q.bbox ?? null);
    setMissingDateState(q.missingDate);
    setMissingCoordinatesState(q.missingCoordinates);
    setShotActions(new Set(q.shotActions));
    setShotFramings(new Set(q.shotFramings));
    setTiers(q.tiers);
    setTierRegionId(q.tierRegionId ?? null);
    setScopeTrip(q.scopeTripId ? { id: q.scopeTripId, name: null } : null);
    setScopeAlbum(q.scopeAlbumId ? { id: q.scopeAlbumId, name: null } : null);
    setSearchInput(q.searchQuery);
    setSearchQuery(q.searchQuery.trim().length >= 3 ? q.searchQuery.trim() : "");
    writeParams({
      missingDate: q.missingDate ? "1" : null,
      missingCoordinates: q.missingCoordinates ? "1" : null,
      shotKind: null,
      action: shotTypeValues(q.shotActions, SHOT_ACTIONS).join(",") || null,
      framing: shotTypeValues(q.shotFramings, SHOT_FRAMINGS).join(",") || null,
      tier: q.tiers,
      tierRegionId: q.tierRegionId ?? null,
      tripId: q.scopeTripId,
      inAlbum: q.scopeAlbumId,
      regionId: q.regionIds,
      tag: q.tags,
      place: q.places,
      ...q.appearance,
      bbox: q.bbox ?? null,
    });
  }

  return {
    query,
    activeFilterCount,
    clearFilters,
    applyQuery,
    searchInput,
    setSearchInput,
    setRating,
    setAnimals,
    setOnlyHidden,
    setOnlyFeatured,
    setNotOnInat,
    setSelectedTaxa,
    setRawFiles,
    setEditedRaw,
    setMediaFilter,
    setDateFrom,
    setDateTo,
    dateRangeOpen,
    setDateRangeOpen,
    setRegionIds,
    setTags,
    setPlaces,
    setAppearance,
    setBbox,
    setSortBy,
    scopeTrip,
    scopeAlbum,
    clearScope,
    shotActions,
    shotFramings,
    setShotActions: (next: ReadonlySet<string>) => changeShotType("action", next),
    setShotFramings: (next: ReadonlySet<string>) => changeShotType("framing", next),
    setTiers: changeTiers,
    setMissingDate,
    setMissingCoordinates,
  };
}

export type GalleryFilters = ReturnType<typeof useGalleryFilters>;
