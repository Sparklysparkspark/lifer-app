import { useCallback, useMemo } from "react";
import type { RegionSummary } from "@lifer/shared";
import { useRegions } from "../../hooks/useRegions";
import { downloadedTaxaByCountry, usePackIndex } from "../../lib/packIndex";
import { countryAncestorOf, regionsReachableFrom } from "../../lib/regionGrouping";
import { ignore } from "../../lib/ignore";

const EMPTY: RegionSummary[] = [];
const EMPTY_NAMES: readonly string[] = [];

// The region list plus what's downloaded, and everything the page derives from the two.
// `fallbackCountryNames`: downloaded countries the Collection's own data named (a hub's
// aggregate answer), used only when the pack list fails.
export function useRegionTree(regionId: string | null, fallbackCountryNames: readonly string[] = EMPTY_NAMES) {
  const { regions, error: regionsError, refresh: refreshRegions } = useRegions();
  const allRegions = regions ?? EMPTY;
  const regionsLoaded = regions !== null || regionsError != null;
  const regionById = useMemo(() => new Map(allRegions.map((r) => [r.id, r])), [allRegions]);

  // Country packs are keyed by region name (region ids differ between installs). Per country,
  // which taxa have a pack; null in the set means an all-taxa pack. null until the index arrives,
  // and empty if it can't be loaded (the server lists installed packs even offline, so an error
  // here means the server itself didn't answer).
  const { packs, error: packsError, refresh: refreshPacks } = usePackIndex();
  const downloadedRegionTaxons = useMemo(
    () => (packs ? downloadedTaxaByCountry(packs) : packsError ? new Map<string, Set<string | null>>() : null),
    [packs, packsError],
  );
  // On an error, the countries the Collection's data named; else unknown (null), never "none".
  const fallbackKey = fallbackCountryNames.join("\n");
  const downloadedCountryNames = useMemo(
    () =>
      packs && downloadedRegionTaxons
        ? new Set(downloadedRegionTaxons.keys())
        : packsError && fallbackKey
          ? new Set(fallbackKey.split("\n"))
          : null,
    [packs, downloadedRegionTaxons, packsError, fallbackKey],
  );
  const loadDownloadedPacks = useCallback(() => {
    refreshPacks().catch(ignore("Couldn't refresh the pack index"));
  }, [refreshPacks]);

  const countryAncestorFor = useCallback((id: string) => countryAncestorOf(regionById, id), [regionById]);
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
  // ancestors). null means not known yet: nothing is offered then, never every region.
  const availableRegionIds = useMemo(
    () => (downloadedCountryNames ? regionsReachableFrom(allRegions, downloadedCountryNames) : null),
    [allRegions, downloadedCountryNames],
  );

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
    () => (availableRegionIds ? allChildren.filter((r) => availableRegionIds.has(r.id)) : EMPTY),
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
    packsError,
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
