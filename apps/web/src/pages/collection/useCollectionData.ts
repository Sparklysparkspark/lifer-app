import { useCallback, useEffect, useRef, useState } from "react";
import { useLatest } from "../../hooks/useLatest";
import type { CollectionItem, RegionSpeciesResponse, RegionSpeciesResult, RegionStats } from "@lifer/shared";
import { api, apiPath } from "../../api/client";
import { onAccountReset } from "../../lib/resource";
import { useUploadQueue } from "../../lib/uploadQueue";
import { usePackDownloadStatus } from "../../hooks/usePackDownloadStatus";
import type { SpeciesChange } from "../../components/SpeciesCard";
import type { TaxonFilter } from "./taxonLabels";
import type { PhotographedIn } from "./useCollectionDisplayPrefs";

type RegionMeta = RegionSpeciesResult["region"];

// Opening a species unmounts this page, so the last result per view is kept at module scope
// and a remount draws it at once while the fetch revalidates in the background.
interface CollectionCacheEntry {
  items: CollectionItem[];
  regionMeta: RegionMeta | null;
  regionStats: RegionStats | null;
}
const collectionCache = new Map<string, CollectionCacheEntry>();
onAccountReset(() => collectionCache.clear());

function cacheKey(
  regionId: string | null,
  taxonRaw: string,
  seaZoneIds: string[],
  includeLand: boolean,
  photographedIn: PhotographedIn,
): string {
  return JSON.stringify([
    regionId,
    taxonRaw.split(",").filter(Boolean).sort(),
    [...seaZoneIds].sort(),
    includeLand,
    photographedIn,
  ]);
}

/** The region last picked in the Collection (or an import), the app-wide default region. */
export function storedLastRegionId(): string | null {
  try {
    return localStorage.getItem("lifer:lastRegionId");
  } catch {
    return null;
  }
}

export function useCollectionData({
  regionId,
  taxonRaw,
  singleTaxonFilter,
  seaZoneIds,
  includeLand,
  seaZonesRelevant,
  regionKnownHub,
  firstRunPrompt,
  ready,
  photographedIn = "anywhere",
}: {
  regionId: string | null;
  taxonRaw: string;
  singleTaxonFilter: TaxonFilter | undefined;
  seaZoneIds: string[];
  includeLand: boolean;
  seaZonesRelevant: boolean;
  regionKnownHub: boolean;
  firstRunPrompt: boolean;
  // False until the region list is in and the region to show is decided.
  ready: boolean;
  // Only a region's checklist has a country to scope to; the server maps it to the page's places.
  photographedIn?: PhotographedIn;
}) {
  // Arriving from the nav has no ?region= yet (it's restored after the first render), so the
  // cache is looked up by the region about to be restored.
  const [initial] = useState(() =>
    collectionCache.get(cacheKey(regionId ?? storedLastRegionId(), taxonRaw, seaZoneIds, includeLand, photographedIn)),
  );
  const [items, setItemsState] = useState<CollectionItem[] | null>(initial?.items ?? null);
  const [regionMeta, setRegionMeta] = useState<RegionMeta | null>(initial?.regionMeta ?? null);
  const [regionStats, setRegionStats] = useState<RegionStats | null>(initial?.regionStats ?? null);
  // The region has no downloaded pack yet; the server never computes a checklist live, so the
  // list holds only what's yours there (photographed or added by hand).
  const [needsPackFor, setNeedsPackFor] = useState<{ id: string; name: string } | null>(null);
  // Some pack is here, just not the filtered taxon's.
  const [taxonPackMissingFor, setTaxonPackMissingFor] = useState<{
    id: string;
    name: string;
    taxon: TaxonFilter;
  } | null>(null);
  // For a hub: which downloaded countries it aggregated, to tell "none downloaded" from "no match".
  const [downloadedHubCountryNames, setDownloadedHubCountryNames] = useState<string[]>([]);
  // What the last load threw; null once one succeeds.
  const [loadError, setLoadError] = useState<unknown>(null);

  const itemsRef = useRef(items);
  const currentKey = cacheKey(regionId, taxonRaw, seaZoneIds, includeLand, photographedIn);
  const currentKeyRef = useLatest(currentKey);

  const replaceItems = useCallback(
    (next: CollectionItem[] | null, meta: RegionMeta | null, stats: RegionStats | null, key?: string) => {
      itemsRef.current = next;
      setItemsState(next);
      setRegionMeta(meta);
      setRegionStats(stats);
      if (next && key) collectionCache.set(key, { items: next, regionMeta: meta, regionStats: stats });
    },
    [],
  );

  // Only sent when relevant, so a stale seaZones param can't silently filter a birds-only view.
  const seaZoneQuery = seaZonesRelevant && seaZoneIds.length > 0 ? `seaZoneIds=${seaZoneIds.join(",")}` : "";
  const includeLandQuery = seaZoneQuery && !includeLand ? "includeLand=0" : "";
  const taxonQuery = taxonRaw ? `taxon=${taxonRaw.split(",").filter(Boolean).join(",")}` : "";
  const photographedInQuery =
    regionId && !regionKnownHub && photographedIn !== "anywhere" ? `photographedIn=${photographedIn}` : "";

  // Clears what the previous list showed before a new one loads. A hub's bar and map are cleared
  // too, so the previous region's don't linger until the list arrives.
  const resetForLoad = useCallback(() => {
    setLoadError(null);
    setNeedsPackFor(null);
    setTaxonPackMissingFor(null);
    if (regionId && regionKnownHub) {
      setRegionMeta(null);
      setRegionStats(null);
    }
  }, [regionId, regionKnownHub]);

  // Guards against a slower, older response overwriting a newer one.
  const loadGeneration = useRef(0);
  const fetchList = useCallback(() => {
    const generation = ++loadGeneration.current;
    const current = () => generation === loadGeneration.current;
    const key = cacheKey(regionId, taxonRaw, seaZoneIds, includeLand, photographedIn);
    // Offline or unreachable: this list as last loaded beats an error, if it was ever loaded.
    const failed = (err: unknown) => {
      if (!current()) return;
      const cached = collectionCache.get(key);
      if (cached) replaceItems(cached.items, cached.regionMeta, cached.regionStats);
      else setLoadError(err ?? new Error("load failed"));
    };

    if (regionId && regionKnownHub) {
      // A hub aggregates the checklists of its downloaded countries.
      api
        .get<{ items: CollectionItem[]; downloadedCountryNames: string[] }>(
          `/regions/${regionId}/aggregate-species?${taxonQuery}`,
        )
        .then((res) => {
          if (!current()) return;
          replaceItems(res.items, null, null, key);
          setDownloadedHubCountryNames(res.downloadedCountryNames);
        })
        .catch(failed);
    } else if (regionId) {
      const query = `${taxonQuery}&${seaZoneQuery}&${includeLandQuery}&${photographedInQuery}`;
      // Lands well before the full list, so the header follows a new scope or filter at once.
      api
        .get(apiPath("/regions/{id}/species/count", { id: regionId }, new URLSearchParams(query)))
        .then((res) => {
          if (current()) setRegionStats(res);
        })
        .catch((err) => console.error("Couldn't load species counts", err));
      api
        .get<RegionSpeciesResponse>(`/regions/${regionId}/species?filter=all&${query}`)
        .then((res) => {
          if (!current()) return;
          replaceItems(res.items, res.region, res.stats, key);
          if (res.needsPack) setNeedsPackFor({ id: res.region.id, name: res.region.name });
          else if (res.taxonPackMissing && singleTaxonFilter) {
            setTaxonPackMissingFor({ id: res.region.id, name: res.region.name, taxon: singleTaxonFilter });
          }
        })
        .catch(failed);
    } else if (!firstRunPrompt) {
      const query = taxonQuery ? `?${taxonQuery}` : "";
      api
        .get<{ items: CollectionItem[] }>(`/collection${query}`)
        .then((res) => {
          if (current()) replaceItems(res.items, null, null, key);
        })
        .catch(failed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- taxonRaw, seaZoneIds, includeLand and photographedIn reach the request through the query strings; the cache key follows them
  }, [
    regionId,
    taxonQuery,
    seaZoneQuery,
    includeLandQuery,
    photographedInQuery,
    firstRunPrompt,
    regionKnownHub,
    singleTaxonFilter,
    replaceItems,
  ]);

  const load = useCallback(() => {
    resetForLoad();
    fetchList();
  }, [resetForLoad, fetchList]);

  // A new list (or the page becoming ready) clears the old one's state in the same render, rather
  // than from the effect after it, and the effect only starts the requests.
  // The key covers the same inputs as fetchList's dependencies.
  const requestKey = ready
    ? JSON.stringify([
        regionId,
        taxonQuery,
        seaZoneQuery,
        includeLandQuery,
        photographedInQuery,
        firstRunPrompt,
        regionKnownHub,
        singleTaxonFilter ?? null,
      ])
    : null;
  const [fetchedFor, setFetchedFor] = useState<string | null>(null);
  if (fetchedFor !== requestKey) {
    setFetchedFor(requestKey);
    if (requestKey) resetForLoad();
  }
  useEffect(() => {
    if (ready) fetchList();
  }, [fetchList, ready]);

  // The import screen hands back here while photos are still uploading. Each finished upload
  // reloads quietly, at most every 1.5s so a big batch doesn't reload once per photo.
  const { jobs: uploadJobs, removals } = useUploadQueue();
  // An undo after the upload removes photos again: also a change worth a reload.
  const finishedUploads = uploadJobs.filter((j) => j.done && !j.error && !j.skipped).length + removals;
  const latestLoad = useLatest(load);
  const uploadReloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (finishedUploads === 0 || !ready || uploadReloadTimer.current) return;
    uploadReloadTimer.current = setTimeout(() => {
      uploadReloadTimer.current = null;
      latestLoad.current();
    }, 1500);
  }, [finishedUploads, ready, latestLoad]);
  useEffect(
    () => () => {
      if (uploadReloadTimer.current) clearTimeout(uploadReloadTimer.current);
    },
    [],
  );

  // Packs set up in the background (onboarding lets the user in after the first) bring species
  // and photos: reload as each lands.
  const lanes = usePackDownloadStatus()?.lanes;
  const packsLanded = (lanes?.setup.processed ?? 0) + (lanes?.photos.processed ?? 0);
  const lastPacksLanded = useRef(packsLanded);
  useEffect(() => {
    const grew = packsLanded > lastPacksLanded.current;
    lastPacksLanded.current = packsLanded;
    if (grew && ready) latestLoad.current();
  }, [packsLanded, ready, latestLoad]);

  // A card or bulk action changed some rows: patch them (and the header counts) in place
  // instead of refetching the whole checklist.
  const applyChange = useCallback(
    (speciesIds: string | string[], change: SpeciesChange) => {
      if (change === "reload") {
        latestLoad.current();
        return;
      }
      const prev = itemsRef.current;
      if (!prev) return;
      const ids = new Set(Array.isArray(speciesIds) ? speciesIds : [speciesIds]);
      let total = 0;
      let collected = 0;
      let seen = 0;
      let next: CollectionItem[];
      if (change === "removed") {
        next = prev.filter((i) => {
          if (!ids.has(i.speciesId)) return true;
          total--;
          if (i.state === "collected") collected--;
          if (i.state === "seen") seen--;
          return false;
        });
      } else {
        next = prev.map((i) => {
          if (!ids.has(i.speciesId)) return i;
          const patched = { ...i, ...change };
          if (i.state !== patched.state) {
            if (i.state === "seen") seen--;
            if (patched.state === "seen") seen++;
            if (i.state === "collected") collected--;
            if (patched.state === "collected") collected++;
          }
          return patched;
        });
      }
      itemsRef.current = next;
      setItemsState(next);
      setRegionStats((s) =>
        s ? { total: s.total + total, collected: s.collected + collected, seen: s.seen + seen } : s,
      );
      const cached = collectionCache.get(currentKeyRef.current);
      if (cached) {
        collectionCache.set(currentKeyRef.current, {
          ...cached,
          items: next,
          regionStats: cached.regionStats
            ? {
                total: cached.regionStats.total + total,
                collected: cached.regionStats.collected + collected,
                seen: cached.regionStats.seen + seen,
              }
            : null,
        });
      }
    },
    [latestLoad, currentKeyRef],
  );

  return {
    items,
    regionMeta,
    regionStats,
    needsPackFor,
    taxonPackMissingFor,
    downloadedHubCountryNames,
    loadError,
    // Which list this is (region, taxon, sea zones): the same key loading again is the same list.
    listKey: currentKey,
    load,
    applyChange,
  };
}
