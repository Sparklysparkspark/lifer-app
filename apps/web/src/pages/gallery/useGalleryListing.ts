import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { useLatest } from "../../hooks/useLatest";
import { useToast } from "../../hooks/useToast";
import { errorMessage } from "../../lib/errorMessage";
import { appendNew, describeSearchReading, galleryParams } from "./galleryHelpers";
import type { GalleryItem, GalleryPageResponse, GalleryQuery, SearchResponse } from "./types";

// The plain listing loads in pages as you scroll; catch-up loads (select all, keep place on a
// reload) use the server's largest page.
const PAGE_SIZE = 200;
const CATCH_UP_PAGE_SIZE = 500;

function fetchPage(params: URLSearchParams, cursor: string, limit: number, signal: AbortSignal) {
  const pageParams = new URLSearchParams(params);
  pageParams.set("limit", String(limit));
  pageParams.set("cursor", cursor);
  return api.get<GalleryPageResponse>(`/gallery?${pageParams}`, { signal });
}

// The photos for the current query: the paged listing, or a search's two passes. A new query
// cancels whatever the last one still had in flight, so a slow old answer can't land on top.
export function useGalleryListing({
  query,
  groupByRegion,
  lightboxIndex,
}: {
  query: GalleryQuery;
  /** Re-checks the scroll sentinel, which moves when the grid regroups. */
  groupByRegion: boolean;
  /** Paging through the lightbox reaches the end of what's loaded before the grid does. */
  lightboxIndex: number | null;
}) {
  const toast = useToast();
  const {
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
  } = query;
  const [items, setItems] = useState<GalleryItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Null once the plain listing is fully loaded (and always for a search, which answers at once).
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  // Every photo the plain listing's filters match, loaded or not.
  const [total, setTotal] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  // Read by requests and the scroll observer, which outlive the render that started them.
  const itemsRef = useLatest(items);
  const nextCursorRef = useLatest(nextCursor);
  const loadingMoreRef = useRef(false);
  // The listing's filters and sort, resent unchanged with every cursor (the cursor encodes the sort).
  const listingParamsRef = useRef<URLSearchParams | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  // How the server read the current search, shown next to the result count.
  const [searchReading, setSearchReading] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const requestAbortRef = useRef<AbortController | null>(null);

  // What a new load clears before its requests go out: called while rendering when the filters
  // change (below), and by load() for a reload after an edit.
  function resetForLoad() {
    setLoadingMore(false);
    setLoadMoreError(false);
    setLoadError(null);
    if (searchQuery) {
      setNextCursor(null);
      setTotal(null);
      setSearching(true);
    } else {
      setSearching(false);
    }
  }

  // keepLoaded: a refresh after an edit reloads as many photos as were showing, so the grid
  // doesn't jump back to the first page.
  function fetchGallery(opts?: { keepLoaded?: boolean }) {
    const keepCount = opts?.keepLoaded ? (itemsRef.current?.length ?? 0) : 0;
    // Cancel the previous request (and any page still loading) so a slow older response can't
    // overwrite a newer one.
    requestAbortRef.current?.abort();
    const controller = new AbortController();
    requestAbortRef.current = controller;
    loadingMoreRef.current = false;

    const params = galleryParams(query);

    const fail = (err: unknown) => {
      if (controller.signal.aborted) return;
      setLoadError(errorMessage(err, searchQuery ? "Search failed" : "Couldn't load your photos"));
      setSearching(false);
    };

    if (searchQuery) {
      listingParamsRef.current = null;
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

  function load(opts?: { keepLoaded?: boolean }) {
    resetForLoad();
    fetchGallery(opts);
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
  const loadMoreRef = useLatest(loadMore);

  // Video and RAW capture ids from the last select all, for selected photos not loaded yet.
  const [selectAllMeta, setSelectAllMeta] = useState<{ video: Set<string>; raw: Set<string> } | null>(null);

  // Select all means every photo matching the filters. Unloaded pages are fetched as ids only:
  // loading and mounting every full item is what made this slow on large libraries.
  async function selectAll(select: (captureIds: Set<string>) => void) {
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
        setSelectAllMeta({ video: new Set(res.videoCaptureIds), raw: new Set(res.rawCaptureIds) });
        select(new Set(res.captureIds));
      } catch (err) {
        if (!controller.signal.aborted) toast.error(errorMessage(err, "Couldn't select every photo"));
      } finally {
        setSelectingAll(false);
      }
      return;
    }
    setSelectAllMeta(null);
    select(new Set((itemsRef.current ?? []).map((it) => it.captureId)));
  }
  const loadRef = useLatest(load);
  const fetchGalleryRef = useLatest(fetchGallery);

  // A filter change clears the old results' state in the same render; the effect then sends the
  // requests. Compared one by one like an effect's dependencies, so a new but equal Set counts.
  const filters = [
    onlyHidden,
    onlyTopRated,
    onlyFeatured,
    missingDate,
    searchQuery,
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
  ];
  const [loadedFilters, setLoadedFilters] = useState<unknown[] | null>(null);
  if (!loadedFilters || filters.some((value, i) => !Object.is(value, loadedFilters[i]))) {
    setLoadedFilters(filters);
    resetForLoad();
  }
  useEffect(
    () => fetchGalleryRef.current(),
    // The filters are what trigger a load; the latest fetchGallery reads them itself.
    [
      fetchGalleryRef,
      onlyHidden,
      onlyTopRated,
      onlyFeatured,
      missingDate,
      searchQuery,
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
    ],
  );
  useEffect(() => () => requestAbortRef.current?.abort(), []);

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
  }, [nextCursor, loadingMore, loadMoreError, itemCount, groupByRegion, loadMoreRef]);

  useEffect(() => {
    if (lightboxIndex !== null && nextCursor && lightboxIndex >= itemCount - 5) loadMoreRef.current();
  }, [lightboxIndex, itemCount, nextCursor, loadMoreRef]);

  return {
    items,
    setItems,
    setTotal,
    loadError,
    nextCursor,
    total,
    loadMoreError,
    searching,
    searchReading,
    selectingAll,
    sentinelRef,
    loadMoreRef,
    load,
    loadRef,
    selectAll,
    selectAllMeta,
  };
}
