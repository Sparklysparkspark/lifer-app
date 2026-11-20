import { useMemo, useState } from "react";
import type { RegionSummary, TaxonClass } from "@lifer/shared";
import { downloadBytes, type DownloadVariant, type PackStatusEntry } from "../../lib/packIndex";
import { groupInto } from "../../lib/groupInto";
import { availableTaxaByRegion, continentIdForCountry, groupRegions, searchCountries } from "../../lib/regionGrouping";

export type { DownloadVariant } from "../../lib/packIndex";
export type Coverage = "full" | "partial" | "none";

function toggled<T>(set: Set<T>, value: T, on = !set.has(value)): Set<T> {
  const next = new Set(set);
  if (on) next.add(value);
  else next.delete(value);
  return next;
}

/** Selects every item, or clears them all when every one is already selected. */
function toggledAll<T>(set: Set<T>, values: T[]): Set<T> {
  const allSelected = values.length > 0 && values.every((v) => set.has(v));
  const next = new Set(set);
  for (const v of values) {
    if (allSelected) next.delete(v);
    else next.add(v);
  }
  return next;
}

// Offline packs' picker: countries (by map, continent pill or search), one taxon selection applied
// across all of them, and the variant. Pack ids are only resolved at download time (download-batch).
/** West, south, east, north. East past 180 carries on across the date line. */
type ContinentView = [number, number, number, number];
const CONTINENT_VIEWS: Array<[RegExp, ContinentView]> = [
  [/^Africa/, [-20, -36, 53, 38]],
  [/^Antarctica/, [-180, -80, 180, -60]],
  [/^Asia/, [26, -11, 146, 56]],
  // Iceland to the Urals: most of Russia is left off the edge.
  [/^Europe/, [-25, 34, 45, 71]],
  // Alaska to Greenland, which is listed here.
  [/^North America/, [-168, 7, -20, 76]],
  [/^Central America/, [-93, 7, -59, 24]],
  [/^South America/, [-82, -56, -34, 13]],
  [/^Oceania/, [110, -48, 190, 2]],
  [/^Seven seas/, [-180, -60, 180, 72]],
];
const continentView = (name: string) => CONTINENT_VIEWS.find(([re]) => re.test(name))?.[1];

export function useOfflinePackSelection(regions: RegionSummary[] | null, packs: PackStatusEntry[] | null) {
  const [selectedCountryIds, setSelectedCountryIds] = useState<Set<string>>(new Set());
  // Only continents opened by their own pill widen the map. A map click also opens the group
  // (to show territories) but shouldn't zoom out from the country clicked.
  const [mapWidenedContinentIds, setMapWidenedContinentIds] = useState<Set<string>>(new Set());
  const [openContinentIds, setOpenContinentIds] = useState<Set<string>>(new Set());
  const [selectedTaxa, setSelectedTaxa] = useState<Set<TaxonClass>>(new Set());
  // "full" bundles every reference photo; "small" ships only the featured photo (plus embeddings)
  // and fetches the rest when online. Applies to the whole selection.
  const [downloadVariant, setDownloadVariant] = useState<DownloadVariant>("full");
  const [openTaxonGroups, setOpenTaxonGroups] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState("");

  const grouping = useMemo(() => groupRegions(regions ?? []), [regions]);
  const { continents, countriesByContinent } = grouping;
  const countryById = useMemo(() => new Map((regions ?? []).map((r) => [r.id, r])), [regions]);
  // Taxa the selection could offer, from the pack catalog, not local taxon presence (which only
  // knows taxa already downloaded).
  const taxaByRegion = useMemo(() => availableTaxaByRegion(packs ?? [], regions ?? []), [packs, regions]);

  // Opening a continent group never selects its countries.
  const openContinents = useMemo(
    () => continents.filter((c) => openContinentIds.has(c.id)),
    [continents, openContinentIds],
  );

  // Countries of map-widened continents, outlined (not selected) on the map.
  const openCountryIds = useMemo(() => {
    const set = new Set<string>();
    for (const continentId of mapWidenedContinentIds) {
      for (const c of countriesByContinent.get(continentId) ?? []) set.add(c.id);
    }
    return set;
  }, [mapWidenedContinentIds, countriesByContinent]);

  // What the map fits to: the selected countries, or with none selected, the widened
  // continents. A new array (only when the inputs change) is what triggers PacksMap's fit.
  const focusCountryIds = useMemo(() => {
    if (selectedCountryIds.size > 0) return [...selectedCountryIds];
    return openCountryIds.size > 0 ? [...openCountryIds] : undefined;
  }, [openCountryIds, selectedCountryIds]);

  // An opened continent shows a set view: fitting its countries takes in all of Russia for
  // Europe, the whole globe for Oceania (it straddles the date line), and nothing at all for
  // Antarctica.
  const focusBounds = useMemo(() => {
    if (selectedCountryIds.size > 0 || mapWidenedContinentIds.size === 0) return undefined;
    const views = continents.filter((c) => mapWidenedContinentIds.has(c.id)).map((c) => continentView(c.name));
    if (views.some((v) => !v)) return undefined;
    const vs = views as ContinentView[];
    return [
      Math.min(...vs.map((v) => v[0])),
      Math.min(...vs.map((v) => v[1])),
      Math.max(...vs.map((v) => v[2])),
      Math.max(...vs.map((v) => v[3])),
    ] as ContinentView;
  }, [continents, mapWidenedContinentIds, selectedCountryIds]);

  const searchResults = useMemo(
    () => searchCountries(regions ?? [], continents, searchTerm),
    [searchTerm, regions, continents],
  );

  const availableTaxaForSelection = useMemo(() => {
    const set = new Set<TaxonClass>();
    for (const id of selectedCountryIds) for (const t of taxaByRegion[id] ?? []) set.add(t);
    return [...set];
  }, [selectedCountryIds, taxaByRegion]);

  function openContinentOf(region: RegionSummary | undefined) {
    const continentId = region && continentIdForCountry(region);
    if (continentId) setOpenContinentIds((prev) => new Set(prev).add(continentId));
  }

  function toggleCountry(id: string) {
    const willSelect = !selectedCountryIds.has(id);
    setSelectedCountryIds((prev) => toggled(prev, id));
    // Opens the country's group so its pill and territories are visible, without scrolling away
    // from the map.
    if (willSelect) openContinentOf(countryById.get(id));
  }

  function toggleContinent(continentId: string) {
    const willOpen = !openContinentIds.has(continentId);
    setOpenContinentIds((prev) => toggled(prev, continentId, willOpen));
    // Only an explicit continent click widens the map.
    setMapWidenedContinentIds((prev) => toggled(prev, continentId, willOpen));
    if (!willOpen) {
      // Closing a continent deselects its countries so nothing stays selected out of sight.
      const countryIdsInContinent = (countriesByContinent.get(continentId) ?? []).map((c) => c.id);
      setSelectedCountryIds((prev) => {
        const next = new Set(prev);
        for (const id of countryIdsInContinent) next.delete(id);
        return next;
      });
    }
  }

  /** Select all / deselect all for a row of countries or territories. */
  function toggleAllCountries(countries: RegionSummary[]) {
    setSelectedCountryIds((prev) =>
      toggledAll(
        prev,
        countries.map((c) => c.id),
      ),
    );
  }

  function selectSearchResult(region: RegionSummary) {
    setSelectedCountryIds((prev) => new Set(prev).add(region.id));
    setSearchTerm("");
    openContinentOf(region);
  }

  /** Adds the regions with these names (a pack recommendation's) to the selection. */
  function selectRegionsByName(names: string[]) {
    const matching = (regions ?? []).filter((r) => names.includes(r.name));
    setSelectedCountryIds((prev) => {
      const next = new Set(prev);
      for (const r of matching) next.add(r.id);
      return next;
    });
  }

  function toggleTaxon(taxon: TaxonClass) {
    setSelectedTaxa((prev) => toggled(prev, taxon));
  }

  function toggleAllTaxa(taxa: TaxonClass[]) {
    setSelectedTaxa((prev) => toggledAll(prev, taxa));
  }

  function toggleTaxonGroup(key: string) {
    setOpenTaxonGroups((prev) => toggled(prev, key));
  }

  function clearSelection() {
    setSelectedCountryIds(new Set());
    setSelectedTaxa(new Set());
  }

  // Full and small cover the same species; this counts only the chosen variant.
  const packsByRegion = useMemo(() => packsByRegionFor(packs ?? [], downloadVariant), [packs, downloadVariant]);

  // An all-taxa pack (taxon null) means full coverage; only taxon-specific packs means partial.
  function countryCoverage(countryName: string): Coverage {
    return coverageOf(packsByRegion.get(countryName) ?? []);
  }

  const selectedCountryNames = useMemo(
    () => [...selectedCountryIds].map((id) => countryById.get(id)?.name).filter((n): n is string => !!n),
    [selectedCountryIds, countryById],
  );

  const packsById = useMemo(() => new Map((packs ?? []).map((p) => [p.id, p])), [packs]);
  const selectionSizeBytes = useMemo(
    () => selectionBytes(packsByRegion, selectedCountryNames, selectedTaxa, packsById),
    [packsByRegion, selectedCountryNames, selectedTaxa, packsById],
  );
  // The same size for the other variant, previewed next to the toggle.
  const otherVariantSizeBytes = useMemo(
    () =>
      selectionBytes(
        packsByRegionFor(packs ?? [], downloadVariant === "full" ? "small" : "full"),
        selectedCountryNames,
        selectedTaxa,
        packsById,
      ),
    [packs, downloadVariant, selectedCountryNames, selectedTaxa, packsById],
  );

  return {
    focusBounds,
    ...grouping,
    selectedCountryIds,
    setSelectedCountryIds,
    selectedCountryNames,
    selectedTaxa,
    setSelectedTaxa,
    downloadVariant,
    setDownloadVariant,
    openTaxonGroups,
    searchTerm,
    setSearchTerm,
    searchResults,
    openContinentIds,
    openContinents,
    openCountryIds,
    focusCountryIds,
    availableTaxaForSelection,
    toggleCountry,
    toggleContinent,
    toggleAllCountries,
    selectSearchResult,
    selectRegionsByName,
    toggleTaxon,
    toggleAllTaxa,
    toggleTaxonGroup,
    clearSelection,
    countryCoverage,
    selectionSizeBytes,
    otherVariantSizeBytes,
  };
}

function packsByRegionFor(packs: PackStatusEntry[], variant: DownloadVariant): Map<string, PackStatusEntry[]> {
  const map = new Map<string, PackStatusEntry[]>();
  for (const p of packs) {
    const region = p.region ?? p.seaZone;
    if (!region || (p.variant ?? "full") !== variant) continue;
    groupInto(map, region, p);
  }
  return map;
}

export function coverageOf(entries: PackStatusEntry[]): Coverage {
  const downloaded = entries.filter((p) => p.downloaded);
  if (downloaded.length === 0) return "none";
  // A stale bundle, or one older than newer taxon splits in the catalog, isn't full coverage.
  if (downloaded.some((p) => p.updateAvailable)) return "partial";
  if (!downloaded.some((p) => p.taxon == null)) return "partial";
  return entries.some((p) => p.taxon != null && !p.downloaded) ? "partial" : "full";
}

// What downloading the selection would fetch: packs not yet installed (or stale), limited to the
// chosen taxa, with the sea zones they pull in; no chosen taxa means nothing.
export function selectionBytes(
  packsByRegion: Map<string, PackStatusEntry[]>,
  countryNames: string[],
  taxa: Set<TaxonClass>,
  packsById: Map<string, PackStatusEntry> = new Map(),
): number {
  if (taxa.size === 0) return 0;
  const chosen = countryNames.flatMap((name) =>
    (packsByRegion.get(name) ?? []).filter(
      (p) => !(p.taxon && !taxa.has(p.taxon)) && !(p.downloaded && !p.updateAvailable),
    ),
  );
  return downloadBytes(chosen, packsById);
}
