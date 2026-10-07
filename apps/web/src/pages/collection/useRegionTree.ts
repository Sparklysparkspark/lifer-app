import { useCallback, useEffect, useMemo, useState } from "react";
import type { RegionSummary } from "@lifer/shared";
import { api } from "../../api/client";
import { useRegions } from "../../hooks/useRegions";

interface PackIndexRow {
  type: string;
  region: string | null;
  taxon: string | null;
  downloaded: boolean;
}

const EMPTY: RegionSummary[] = [];

// The region list plus what's downloaded, and everything the page derives from the two.
export function useRegionTree(regionId: string | null) {
  const { regions, error: regionsError, refresh: refreshRegions } = useRegions();
  const allRegions = regions ?? EMPTY;
  const regionsLoaded = regions !== null || regionsError != null;
  const regionById = useMemo(() => new Map(allRegions.map((r) => [r.id, r])), [allRegions]);

  // Country packs are keyed by region name (region ids differ between installs). Sea-zone
  // packs aren't part of the browse tree. null until the index arrives.
  const [downloadedCountryNames, setDownloadedCountryNames] = useState<Set<string> | null>(null);
  // Per country, which taxa have a pack; null in the set means an all-taxa pack.
  const [downloadedRegionTaxons, setDownloadedRegionTaxons] = useState<Map<string, Set<string | null>> | null>(null);
  const loadDownloadedPacks = useCallback(() => {
    api
      .get<{ packs: PackIndexRow[] }>("/offline-packs/index")
      .then((res) => {
        const names = new Set<string>();
        const taxonMap = new Map<string, Set<string | null>>();
        for (const p of res.packs) {
          if (p.type !== "region" || !p.region || !p.downloaded) continue;
          names.add(p.region);
          if (!taxonMap.has(p.region)) taxonMap.set(p.region, new Set());
          taxonMap.get(p.region)!.add(p.taxon ?? null);
        }
        setDownloadedCountryNames(names);
        setDownloadedRegionTaxons(taxonMap);
      })
      .catch(() => {
        setDownloadedCountryNames(new Set());
        setDownloadedRegionTaxons(new Map());
      });
  }, []);
  useEffect(loadDownloadedPacks, [loadDownloadedPacks]);

  // Walks up to the country row (the only rows with a sovereigntyGroup), mirroring the server's
  // resolvePackRegionName: packs are built per country, so a province resolves to its country.
  const countryAncestorFor = useCallback(
    (id: string): RegionSummary | null => {
      let region = regionById.get(id);
      while (region && region.sovereigntyGroup == null && region.parentId) {
        const parent = regionById.get(region.parentId);
        if (!parent) break;
        region = parent;
      }
      return region ?? null;
    },
    [regionById],
  );
  // null until regions load, which SpeciesCard treats as "no country to choose between".
  const countryAncestor = useMemo(() => {
    const region = regionId ? countryAncestorFor(regionId) : null;
    return region ? { id: region.id, name: region.name } : null;
  }, [regionId, countryAncestorFor]);

  const isTaxonPackDownloaded = useCallback(
    (id: string | null, taxonClass: string): boolean => {
      if (!id || !downloadedRegionTaxons) return false;
      const packRegionName = countryAncestorFor(id)?.name;
      if (!packRegionName) return false;
      const taxons = downloadedRegionTaxons.get(packRegionName);
      if (!taxons) return false;
      return taxons.has(null) || taxons.has(taxonClass);
    },
    [downloadedRegionTaxons, countryAncestorFor],
  );

  // Browsing only offers regions reachable from a downloaded country (its pack's regions and their
  // ancestors). null means packs aren't loaded yet, so don't filter.
  const availableRegionIds = useMemo(() => {
    if (!downloadedCountryNames) return null;
    const childrenOf = new Map<string, RegionSummary[]>();
    for (const r of allRegions) {
      if (r.parentId == null) continue;
      if (!childrenOf.has(r.parentId)) childrenOf.set(r.parentId, []);
      childrenOf.get(r.parentId)!.push(r);
    }
    const available = new Set<string>();
    for (const region of allRegions) {
      if (!downloadedCountryNames.has(region.name)) continue;
      available.add(region.id);
      let cursor: RegionSummary | undefined = region;
      while (cursor?.parentId) {
        available.add(cursor.parentId);
        cursor = regionById.get(cursor.parentId);
      }
      const stack = [...(childrenOf.get(region.id) ?? [])];
      while (stack.length) {
        const child = stack.pop()!;
        available.add(child.id);
        stack.push(...(childrenOf.get(child.id) ?? []));
      }
    }
    return available;
  }, [allRegions, regionById, downloadedCountryNames]);

  // World and continents have no checklist of their own; the page aggregates their downloaded
  // countries instead of fetching every species on Earth.
  const regionKnownHub = useMemo(() => {
    if (!regionId || !regionsLoaded) return false;
    const region = regionById.get(regionId);
    return !!region && !region.hasScopedChecklist;
  }, [regionId, regionsLoaded, regionById]);

  const worldRegion = useMemo(() => allRegions.find((r) => r.parentId === null && r.name === "World"), [allRegions]);
  // A country is a checklist region directly under a hub (not a province sharing its name).
  const downloadedCountries = useMemo(() => {
    if (!downloadedCountryNames) return [];
    const hubIds = new Set(allRegions.filter((r) => !r.hasScopedChecklist).map((r) => r.id));
    return allRegions
      .filter(
        (r) =>
          downloadedCountryNames.has(r.name) && r.hasScopedChecklist && r.parentId != null && hubIds.has(r.parentId),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [allRegions, downloadedCountryNames]);
  const allChildren = useMemo(() => allRegions.filter((r) => r.parentId === regionId), [allRegions, regionId]);
  const children = useMemo(
    () => (availableRegionIds ? allChildren.filter((r) => availableRegionIds.has(r.id)) : allChildren),
    [allChildren, availableRegionIds],
  );
  const breadcrumb = useMemo(() => {
    const trail: RegionSummary[] = [];
    let node = regionId ? regionById.get(regionId) : undefined;
    while (node) {
      trail.unshift(node);
      node = node.parentId ? regionById.get(node.parentId) : undefined;
    }
    return trail;
  }, [regionById, regionId]);

  return {
    allRegions,
    regionsLoaded,
    regionsError,
    refreshRegions,
    downloadedCountryNames,
    downloadedRegionTaxons,
    loadDownloadedPacks,
    countryAncestor,
    isTaxonPackDownloaded,
    availableRegionIds,
    regionKnownHub,
    worldRegion,
    downloadedCountries,
    allChildren,
    children,
    breadcrumb,
  };
}

export type RegionTree = ReturnType<typeof useRegionTree>;
