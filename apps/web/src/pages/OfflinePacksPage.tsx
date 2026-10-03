import { useEffect, useMemo, useRef, useState } from "react";
import type { RegionSummary, TaxonClass } from "@lifer/shared";
import { TAXON_CLASS_LABEL, TAXON_GROUPS, GROUPED_TAXON_CLASSES, taxonDisplayLabel } from "@lifer/shared";
import { api, ApiError } from "../api/client";
import { Spinner } from "../components/LoadingScreen";
import Pill from "../components/Pill";
import PageHeader from "../components/PageHeader";
import InfoTip from "../components/InfoTip";
import PacksMap, { type CountryBoundary } from "../components/PacksMap";
import RegionPicker from "../components/RegionPicker";
import DownloadedPacksList, { type PackEntry } from "../components/DownloadedPacksList";
import JobProgress from "../components/JobProgress";
import FormMessage from "../components/FormMessage";
import { usePackDownloadJob, packProgressDetail, PACK_DOWNLOAD_PHASES } from "../hooks/usePackDownloadStatus";
import { useRegions } from "../hooks/useRegions";
import { useSettings } from "../hooks/useSettings";
import { nextPackDownloadFinish } from "../lib/waitForPackDownload";
import { formatBytes } from "../lib/formatBytes";
import { pluralize } from "../lib/pluralize";

const PACKS_INFO_PARAGRAPHS = [
  '"Update available" means the pack\'s checklist data (which species occur there, and how often) has changed since you downloaded it. Re-downloading refreshes that.',
];

// Natural Earth puts these under North America; a frontend-only pseudo-continent groups them for browsing.
const CENTRAL_AMERICA_COUNTRY_NAMES = new Set([
  "Guatemala",
  "Belize",
  "Honduras",
  "El Salvador",
  "Nicaragua",
  "Costa Rica",
  "Panama",
]);
const CENTRAL_AMERICA_CONTINENT_ID = "central-america";
// Which continent group a country displays under, shared by the grouping and search.
function continentIdForCountry(country: RegionSummary): string | null {
  if (CENTRAL_AMERICA_COUNTRY_NAMES.has(country.name)) return CENTRAL_AMERICA_CONTINENT_ID;
  return country.parentId;
}
const CENTRAL_AMERICA_CONTINENT: RegionSummary = {
  id: CENTRAL_AMERICA_CONTINENT_ID,
  name: "Central America",
  parentId: null,
  ebirdRegionCode: null,
  boundaryGeoJson: null,
  hasChildren: false,
  hasScopedChecklist: false,
  sovereigntyGroup: null,
  isSovereignDependency: false,
};


interface RecommendedPack {
  id: string;
  region?: string;
  seaZone?: string;
  taxon: TaxonClass | null;
  sizeBytes: number;
  covers: number;
}

interface Recommendation {
  recommended: RecommendedPack[];
  uncovered: string[];
}

interface ProvinceEntry {
  id: string;
  name: string;
  applied: boolean;
}

// Map, continent pills, country search, and one taxon selection applied across every selected
// country. Pack ids are only resolved at download time (download-batch).
export default function OfflinePacksPage() {
  const { regions, error: regionsError } = useRegions();
  const { settings } = useSettings();
  const [countryBoundaries, setCountryBoundaries] = useState<CountryBoundary[] | null>(null);
  const [boundariesError, setBoundariesError] = useState<string | null>(null);
  const [packs, setPacks] = useState<PackEntry[] | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [selectedCountryIds, setSelectedCountryIds] = useState<Set<string>>(new Set());
  // Only continents opened by their own pill widen the map. A map click also opens the group
  // (to show territories) but shouldn't zoom out from the country clicked.
  const [mapWidenedContinentIds, setMapWidenedContinentIds] = useState<Set<string>>(new Set());
  const [openContinentIds, setOpenContinentIds] = useState<Set<string>>(new Set());
  const [selectedTaxa, setSelectedTaxa] = useState<Set<TaxonClass>>(new Set());
  // "full" bundles every reference photo; "small" ships only the featured photo (plus embeddings)
  // and fetches the rest when online. Applies to the whole selection.
  const [downloadVariant, setDownloadVariant] = useState<"full" | "small">("full");
  const [openTaxonGroups, setOpenTaxonGroups] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState("");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [recommendationError, setRecommendationError] = useState<string | null>(null);
  const [provinceManagerPackId, setProvinceManagerPackId] = useState<string | null>(null);
  const [provinceList, setProvinceList] = useState<ProvinceEntry[] | null>(null);
  // "States", "Regions" or "Provinces", from the country's own admin-1 data on the server.
  const [subdivisionLabel, setSubdivisionLabel] = useState("Provinces");
  // Taxon labels follow the naming preference (and cover Other Taxa's raw iconic names).
  const namingStyles = settings?.speciesNamingStyles ?? [];
  const [provinceError, setProvinceError] = useState<string | null>(null);
  const [provinceBusyId, setProvinceBusyId] = useState<string | null>(null);
  const countryRowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  function refreshPacks() {
    return api
      .get<{ packs: PackEntry[] }>("/offline-packs/index")
      .then((res) => setPacks(res.packs))
      .catch((err) => setIndexError(err instanceof ApiError ? err.message : "Couldn't load available packs"));
  }

  useEffect(() => {
    api
      .get<{ regions: CountryBoundary[] }>("/regions/boundaries?level=country")
      .then((res) => setCountryBoundaries(res.regions))
      .catch((err) => {
        setBoundariesError(err instanceof ApiError ? err.message : "Couldn't load the country map");
        setCountryBoundaries([]);
      });
    refreshPacks();
  }, []);

  // Arrived from the library reimport tool's "N species missing reference data" link
  // (SettingsPage.tsx) with the gap list in the URL: check which packs would cover it.
  useEffect(() => {
    const missing = new URLSearchParams(window.location.search).get("missing");
    if (!missing) return;
    const scientificNames = missing.split(",").filter(Boolean);
    if (scientificNames.length === 0) return;
    api
      .post<Recommendation>("/offline-packs/recommend", { scientificNames })
      .then(setRecommendation)
      .catch((err) => setRecommendationError(err instanceof ApiError ? err.message : "Couldn't compute pack recommendations"));
  }, []);

  const downloadJob = usePackDownloadJob({ onFinish: () => void refreshPacks() });
  const status = downloadJob.status;

  // Taxa the selection could offer, unioned across selected countries. From the pack catalog,
  // not local taxon presence, which only knows taxa already downloaded.
  const availableTaxaByRegion = useMemo(() => {
    const byRegionName = new Map<string, Set<TaxonClass>>();
    for (const p of packs ?? []) {
      if (p.type !== "region" || !p.region || !p.taxon) continue;
      if (!byRegionName.has(p.region)) byRegionName.set(p.region, new Set());
      byRegionName.get(p.region)!.add(p.taxon);
    }
    const byRegionId: Record<string, TaxonClass[]> = {};
    for (const r of regions ?? []) {
      const taxa = byRegionName.get(r.name);
      if (taxa) byRegionId[r.id] = [...taxa];
    }
    return byRegionId;
  }, [packs, regions]);

  const world = regions?.find((r) => r.parentId === null);
  const continents = useMemo(() => {
    const real = (regions ?? []).filter((r) => r.parentId === world?.id);
    const northAmericaIndex = real.findIndex((c) => c.name === "North America");
    if (northAmericaIndex === -1) return real;
    // Right after North America, since that's where these countries would otherwise be found.
    return [...real.slice(0, northAmericaIndex + 1), CENTRAL_AMERICA_CONTINENT, ...real.slice(northAmericaIndex + 1)];
  }, [regions, world]);
  // Primary countries make the main pill list; territories go to a per-continent "Other
  // territories" catch-all so they're findable without cluttering the list.
  const countriesByContinent = useMemo(() => {
    const map = new Map<string, RegionSummary[]>();
    for (const r of regions ?? []) {
      if (!r.parentId || r.isSovereignDependency) continue;
      const bucketId = continentIdForCountry(r);
      if (!bucketId) continue;
      if (!map.has(bucketId)) map.set(bucketId, []);
      map.get(bucketId)!.push(r);
    }
    return map;
  }, [regions]);
  const territoriesByContinent = useMemo(() => {
    const map = new Map<string, RegionSummary[]>();
    for (const r of regions ?? []) {
      if (!r.parentId || !r.isSovereignDependency) continue;
      if (!map.has(r.parentId)) map.set(r.parentId, []);
      map.get(r.parentId)!.push(r);
    }
    return map;
  }, [regions]);
  const countryById = useMemo(() => new Map((regions ?? []).map((r) => [r.id, r])), [regions]);

  // Country to its territories (same sovereignty group, e.g. the US and Puerto Rico), shown as a
  // "Territories" panel under the selected country in addition to their own continent.
  const territoriesByCountryId = useMemo(() => {
    const bySovereigntyGroup = new Map<string, RegionSummary[]>();
    for (const r of regions ?? []) {
      if (!r.sovereigntyGroup || !r.parentId) continue;
      if (!bySovereigntyGroup.has(r.sovereigntyGroup)) bySovereigntyGroup.set(r.sovereigntyGroup, []);
      bySovereigntyGroup.get(r.sovereigntyGroup)!.push(r);
    }
    const map = new Map<string, RegionSummary[]>();
    for (const group of bySovereigntyGroup.values()) {
      const dependencies = group.filter((g) => g.isSovereignDependency).sort((a, b) => a.name.localeCompare(b.name));
      if (dependencies.length === 0) continue;
      // Only the sovereign member gets the panel.
      for (const country of group) {
        if (!country.isSovereignDependency) map.set(country.id, dependencies);
      }
    }
    return map;
  }, [regions]);

  // Opening a continent group never selects its countries.
  const openContinents = useMemo(() => continents.filter((c) => openContinentIds.has(c.id)), [continents, openContinentIds]);

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

  const searchResults = useMemo(() => {
    if (searchTerm.trim().length < 2) return [];
    const term = searchTerm.trim().toLowerCase();
    const continentIds = new Set(continents.map((c) => c.id));
    return (regions ?? [])
      .filter((r) => r.parentId && continentIds.has(r.parentId))
      .filter((r) => r.name.toLowerCase().includes(term))
      .slice(0, 8);
  }, [searchTerm, regions, continents]);

  const availableTaxaForSelection = useMemo(() => {
    const set = new Set<TaxonClass>();
    for (const id of selectedCountryIds) for (const t of availableTaxaByRegion[id] ?? []) set.add(t);
    return [...set];
  }, [selectedCountryIds, availableTaxaByRegion]);

  function toggleCountry(id: string) {
    const willSelect = !selectedCountryIds.has(id);
    setSelectedCountryIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // Opens the country's group so its pill and territories are visible, without scrolling away
    // from the map.
    if (willSelect) {
      const region = countryById.get(id);
      const continentId = region && continentIdForCountry(region);
      if (continentId) setOpenContinentIds((prev) => new Set(prev).add(continentId));
    }
  }

  function toggleContinent(continentId: string) {
    const willOpen = !openContinentIds.has(continentId);
    setOpenContinentIds((prev) => {
      const next = new Set(prev);
      if (willOpen) next.add(continentId);
      else next.delete(continentId);
      return next;
    });
    // Only an explicit continent click widens the map.
    setMapWidenedContinentIds((prev) => {
      const next = new Set(prev);
      if (willOpen) next.add(continentId);
      else next.delete(continentId);
      return next;
    });
    if (!willOpen) {
      // Closing a continent deselects its countries so nothing stays selected out of sight.
      const countryIdsInContinent = new Set((countriesByContinent.get(continentId) ?? []).map((c) => c.id));
      setSelectedCountryIds((prev) => {
        const next = new Set(prev);
        for (const id of countryIdsInContinent) next.delete(id);
        return next;
      });
    }
  }

  function toggleAllInContinent(countries: RegionSummary[]) {
    const allSelected = countries.length > 0 && countries.every((c) => selectedCountryIds.has(c.id));
    setSelectedCountryIds((prev) => {
      const next = new Set(prev);
      for (const c of countries) {
        if (allSelected) next.delete(c.id);
        else next.add(c.id);
      }
      return next;
    });
  }

  function selectSearchResult(region: RegionSummary) {
    setSelectedCountryIds((prev) => new Set(prev).add(region.id));
    setSearchTerm("");
    const continentId = continentIdForCountry(region);
    if (continentId) setOpenContinentIds((prev) => new Set(prev).add(continentId));
    // Next tick, once the row has rendered.
    setTimeout(() => countryRowRefs.current.get(region.id)?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 0);
  }

  // An all-taxa pack (taxon null) means full coverage; only taxon-specific packs means partial.
  function countryCoverage(countryName: string): "full" | "partial" | "none" {
    const entries = packsByRegion.get(countryName) ?? [];
    const downloaded = entries.filter((p) => p.downloaded);
    if (downloaded.length === 0) return "none";
    // A stale bundle, or one older than newer taxon splits in the catalog, isn't full coverage.
    if (downloaded.some((p) => p.updateAvailable)) return "partial";
    const hasAllTaxaBundle = downloaded.some((p) => p.taxon == null);
    if (!hasAllTaxaBundle) return "partial";
    const hasUndownloadedTaxonPack = entries.some((p) => p.taxon != null && !p.downloaded);
    return hasUndownloadedTaxonPack ? "partial" : "full";
  }

  function toggleTaxon(taxon: TaxonClass) {
    setSelectedTaxa((prev) => {
      const next = new Set(prev);
      if (next.has(taxon)) next.delete(taxon);
      else next.add(taxon);
      return next;
    });
  }

  const packsByRegion = useMemo(() => {
    const map = new Map<string, PackEntry[]>();
    for (const p of packs ?? []) {
      const region = p.region ?? p.seaZone;
      if (!region) continue;
      // Full and small cover the same species; count only the chosen variant.
      if ((p.variant ?? "full") !== downloadVariant) continue;
      if (!map.has(region)) map.set(region, []);
      map.get(region)!.push(p);
    }
    return map;
  }, [packs, downloadVariant]);

  const selectionSizeBytes = useMemo(() => {
    let total = 0;
    for (const id of selectedCountryIds) {
      const name = countryById.get(id)?.name;
      if (!name) continue;
      for (const p of packsByRegion.get(name) ?? []) {
        if (selectedTaxa.size > 0 && p.taxon && !selectedTaxa.has(p.taxon)) continue;
        if (p.downloaded && !p.updateAvailable) continue;
        total += p.sizeBytes;
      }
    }
    return total;
  }, [selectedCountryIds, selectedTaxa, packsByRegion, countryById]);

  // The same size for the other variant, previewed next to the toggle.
  const otherVariantSizeBytes = useMemo(() => {
    const otherVariant = downloadVariant === "full" ? "small" : "full";
    let total = 0;
    for (const id of selectedCountryIds) {
      const name = countryById.get(id)?.name;
      if (!name) continue;
      for (const p of packs ?? []) {
        const region = p.region ?? p.seaZone;
        if (region !== name) continue;
        if ((p.variant ?? "full") !== otherVariant) continue;
        if (selectedTaxa.size > 0 && p.taxon && !selectedTaxa.has(p.taxon)) continue;
        if (p.downloaded && !p.updateAvailable) continue;
        total += p.sizeBytes;
      }
    }
    return total;
  }, [selectedCountryIds, selectedTaxa, packs, countryById, downloadVariant]);

  async function startDownload() {
    setStartError(null);
    setStarting(true);
    try {
      const regionNames = [...selectedCountryIds].map((id) => countryById.get(id)?.name).filter((n): n is string => !!n);
      await api.post("/offline-packs/download-batch", {
        regionNames,
        taxa: selectedTaxa.size > 0 ? [...selectedTaxa] : "all",
        variant: downloadVariant,
      });
      setSelectedCountryIds(new Set());
      setSelectedTaxa(new Set());
      void downloadJob.refresh();
    } catch (err) {
      setStartError(err instanceof ApiError ? err.message : "Couldn't start the download");
    } finally {
      setStarting(false);
    }
  }

  function cancelDownload() {
    void downloadJob.cancel("/offline-packs/download/cancel");
  }

  async function openProvinceManager(packId: string) {
    if (provinceManagerPackId === packId) {
      setProvinceManagerPackId(null);
      return;
    }
    setProvinceManagerPackId(packId);
    setProvinceList(null);
    setProvinceError(null);
    try {
      const res = await api.get<{ provinces: ProvinceEntry[]; subdivisionLabel: string }>(
        `/offline-packs/${encodeURIComponent(packId)}/provinces`,
      );
      setProvinceList(res.provinces);
      setSubdivisionLabel(res.subdivisionLabel);
    } catch (err) {
      setProvinceError(err instanceof ApiError ? err.message : "Couldn't load this pack's provinces");
    }
  }

  async function offloadProvince(packId: string, province: ProvinceEntry) {
    setProvinceBusyId(province.id);
    setProvinceError(null);
    try {
      await api.post(`/offline-packs/${encodeURIComponent(packId)}/provinces/offload`, { regionIds: [province.id] });
      setProvinceList((prev) => prev?.map((p) => (p.id === province.id ? { ...p, applied: false } : p)) ?? null);
    } catch (err) {
      setProvinceError(err instanceof ApiError ? err.message : "Couldn't offload this province");
    } finally {
      setProvinceBusyId(null);
    }
  }

  // There's no "apply one province" path: the whole pack is re-downloaded (restoring every
  // province), then the ones still meant to be excluded are trimmed back out.
  async function reapplyProvince(packId: string, province: ProvinceEntry) {
    if (!provinceList) return;
    setProvinceBusyId(province.id);
    setProvinceError(null);
    try {
      const wait = nextPackDownloadFinish([packId]);
      if (!(await downloadJob.start("/offline-packs/download", { packIds: [packId], force: true }))) {
        wait.cancel();
        throw new Error("Couldn't start the download");
      }
      const jobStatus = await wait.finished;
      if (jobStatus.error) throw new Error(jobStatus.error);
      if (jobStatus.cancelled) throw new Error("The download was cancelled");
      const stillExcluded = provinceList.filter((p) => !p.applied && p.id !== province.id).map((p) => p.id);
      if (stillExcluded.length > 0) {
        await api.post(`/offline-packs/${encodeURIComponent(packId)}/provinces/offload`, { regionIds: stillExcluded });
      }
      const res = await api.get<{ provinces: ProvinceEntry[] }>(`/offline-packs/${encodeURIComponent(packId)}/provinces`);
      setProvinceList(res.provinces);
      refreshPacks();
    } catch (err) {
      setProvinceError(err instanceof Error && err.message ? err.message : "Couldn't re-add this province");
    } finally {
      setProvinceBusyId(null);
    }
  }

  const downloadedPacks = (packs ?? []).filter((p) => p.downloaded);

  return (
    <div className="flex-1 bg-canvas">
      <PageHeader sticky
        title="Offline packs"
        backFallbackTo="/settings"
        backLabel="Settings"
        titleAddon={<InfoTip paragraphs={PACKS_INFO_PARAGRAPHS} />}
      >
        <p className="mt-1 text-sm text-muted">
          Download reference photos and habitat info for a region so it's usable without an internet connection.
        </p>
      </PageHeader>

      <main className="mx-auto max-w-3xl space-y-6 p-6">
        <FormMessage error={indexError} />
        <FormMessage error={recommendationError} />
        <FormMessage error={boundariesError} />
        {!regions && !!regionsError && <FormMessage error="Couldn't load the region list." />}

        {recommendation && (
          <div className="rounded-xl border border-line bg-surface p-4">
            {recommendation.recommended.length === 0 ? (
              <p className="text-sm text-muted">
                None of the available packs cover the missing species from your library. They may not have offline packs yet.
              </p>
            ) : (
              <>
                <p className="text-sm text-ink">These packs would restore reference data for the species your reimport found missing:</p>
                <ul className="mt-2 space-y-1 text-sm text-muted">
                  {recommendation.recommended.map((p) => (
                    <li key={p.id}>
                      {p.region ?? p.seaZone} {p.taxon ? `(${TAXON_CLASS_LABEL[p.taxon]})` : ""}: covers {p.covers} species,{" "}
                      {formatBytes(p.sizeBytes)}
                    </li>
                  ))}
                </ul>
                {recommendation.uncovered.length > 0 && (
                  <p className="mt-2 text-xs text-muted">
                    {recommendation.uncovered.length} species aren't covered by any available pack yet.
                  </p>
                )}
                <button
                  onClick={async () => {
                    const idsToNames = recommendation.recommended.map((p) => p.region ?? p.seaZone).filter((n): n is string => !!n);
                    const matching = (regions ?? []).filter((r) => idsToNames.includes(r.name));
                    setSelectedCountryIds((prev) => {
                      const next = new Set(prev);
                      for (const r of matching) next.add(r.id);
                      return next;
                    });
                  }}
                  className="mt-3 rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-surface-muted"
                >
                  Select these regions
                </button>
              </>
            )}
          </div>
        )}

        {status?.running && (
          <div className="rounded-xl border border-line bg-surface p-4">
            <JobProgress
              status={status}
              phases={PACK_DOWNLOAD_PHASES}
              detail={packProgressDetail(status)}
              onCancel={cancelDownload}
              cancelling={downloadJob.cancelling}
            />
          </div>
        )}
        {status && !status.running && status.finishedAt && Date.now() - status.finishedAt < 15000 &&
          (status.error ? (
            <FormMessage error={`Download failed: ${status.error}`} />
          ) : (
            <div className="rounded-xl border border-line bg-surface p-4">
              <p className="text-sm text-ink">
                {status.cancelled
                  ? `Cancelled. ${pluralize(status.processed ?? 0, "pack")} had already finished applying before you stopped it.`
                  : `Done, ${pluralize(status.result?.packsApplied ?? status.processed ?? 0, "pack")} applied.`}
              </p>
            </div>
          ))}

        {!regions || !countryBoundaries || !packs ? (
          regionsError && !regions ? null : <Spinner />
        ) : (
          <>
            <PacksMap
              countries={countryBoundaries}
              selectedIds={selectedCountryIds}
              onToggleCountry={toggleCountry}
              focusCountryIds={focusCountryIds}
              openCountryIds={openCountryIds}
              onDeselectAll={() => setSelectedCountryIds(new Set())}
            />

            <RegionPicker
              mode="multi"
              items={continents.filter((c) => (countriesByContinent.get(c.id) ?? []).length > 0)}
              selectedIds={openContinentIds}
              onToggleItem={toggleContinent}
            />

            <RegionPicker
              mode="multi"
              search={{
                term: searchTerm,
                onTermChange: setSearchTerm,
                results: searchResults,
                onSelectResult: (item) => selectSearchResult(item as RegionSummary),
                placeholder: "Search for a country…",
              }}
            />

            {openContinents.length > 0 && (
              <div className="space-y-4 rounded-xl border border-line bg-surface p-4">
                {openContinents.map((continent) => {
                  const countries = [...(countriesByContinent.get(continent.id) ?? [])].sort((a, b) => a.name.localeCompare(b.name));
                  return (
                    <div key={continent.id}>
                      <div className="mb-1.5 flex items-center justify-between">
                        {openContinents.length > 1 && (
                          <p className="text-xs font-semibold uppercase tracking-wide text-muted">{continent.name}</p>
                        )}
                        <button
                          type="button"
                          onClick={() => toggleAllInContinent(countries)}
                          className="ml-auto text-xs font-medium text-accent hover:underline"
                        >
                          {countries.length > 0 && countries.every((c) => selectedCountryIds.has(c.id)) ? "Deselect all" : "Select all"}
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {countries.map((country) => {
                          const coverage = countryCoverage(country.name);
                          const isSelected = selectedCountryIds.has(country.id);
                          const territories = territoriesByCountryId.get(country.id);
                          return (
                            <div key={country.id} className="contents">
                              <button
                                type="button"
                                ref={(el) => {
                                  if (el) countryRowRefs.current.set(country.id, el);
                                  else countryRowRefs.current.delete(country.id);
                                }}
                                onClick={() => toggleCountry(country.id)}
                                title={coverage === "full" ? "Fully downloaded" : coverage === "partial" ? "Partially downloaded" : undefined}
                                className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors ${
                                  coverage !== "none"
                                    ? isSelected
                                      ? "border-accent bg-accent text-accent-fg ring-2 ring-accent/40"
                                      : "border-accent bg-accent text-accent-fg"
                                    : isSelected
                                      ? "border-ink bg-ink text-canvas"
                                      : "border-line bg-surface-muted text-ink hover:bg-line"
                                }`}
                              >
                                {coverage === "partial" && (
                                  <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-fg/70" />
                                )}
                                {country.name}
                              </button>
                              {isSelected && territories && territories.length > 0 && (
                                <div className="mt-1 flex w-full flex-wrap items-center gap-1.5 pl-3">
                                  <span className="text-[11px] text-muted">Territories:</span>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setSelectedCountryIds((prev) => {
                                        const next = new Set(prev);
                                        const allSelected = territories.every((t) => next.has(t.id));
                                        for (const t of territories) {
                                          if (allSelected) next.delete(t.id);
                                          else next.add(t.id);
                                        }
                                        return next;
                                      })
                                    }
                                    className="text-[11px] font-medium text-accent hover:underline"
                                  >
                                    {territories.every((t) => selectedCountryIds.has(t.id)) ? "Deselect all" : "Select all"}
                                  </button>
                                  {territories.map((territory) => {
                                    const territoryCoverage = countryCoverage(territory.name);
                                    const territorySelected = selectedCountryIds.has(territory.id);
                                    return (
                                      <button
                                        key={territory.id}
                                        type="button"
                                        onClick={() => toggleCountry(territory.id)}
                                        title={
                                          territoryCoverage === "full"
                                            ? "Fully downloaded"
                                            : territoryCoverage === "partial"
                                              ? "Partially downloaded"
                                              : undefined
                                        }
                                        className={`flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
                                          territoryCoverage !== "none"
                                            ? territorySelected
                                              ? "border-accent bg-accent text-accent-fg ring-2 ring-accent/40"
                                              : "border-accent bg-accent text-accent-fg"
                                            : territorySelected
                                              ? "border-ink bg-ink text-canvas"
                                              : "border-line bg-surface-muted text-muted hover:bg-line"
                                        }`}
                                      >
                                        {territoryCoverage === "partial" && (
                                          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-fg/70" />
                                        )}
                                        {territory.name}
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      {(() => {
                        const otherTerritories = [...(territoriesByContinent.get(continent.id) ?? [])].sort((a, b) =>
                          a.name.localeCompare(b.name),
                        );
                        if (otherTerritories.length === 0) return null;
                        // Fallback for finding a territory directly, not only under its country.
                        const allOtherSelected = otherTerritories.every((t) => selectedCountryIds.has(t.id));
                        return (
                          <div className="mt-2 border-t border-line pt-2">
                            <div className="mb-1.5 flex items-center justify-between">
                              <p className="text-xs text-muted">Other territories</p>
                              <button
                                type="button"
                                onClick={() =>
                                  setSelectedCountryIds((prev) => {
                                    const next = new Set(prev);
                                    for (const t of otherTerritories) {
                                      if (allOtherSelected) next.delete(t.id);
                                      else next.add(t.id);
                                    }
                                    return next;
                                  })
                                }
                                className="text-xs font-medium text-accent hover:underline"
                              >
                                {allOtherSelected ? "Deselect all" : "Select all"}
                              </button>
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {otherTerritories.map((territory) => {
                                const coverage = countryCoverage(territory.name);
                                const isSelected = selectedCountryIds.has(territory.id);
                                return (
                                  <button
                                    key={territory.id}
                                    type="button"
                                    onClick={() => toggleCountry(territory.id)}
                                    title={coverage === "full" ? "Fully downloaded" : coverage === "partial" ? "Partially downloaded" : undefined}
                                    className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors ${
                                      coverage === "full"
                                        ? isSelected
                                          ? "border-accent bg-accent text-accent-fg ring-2 ring-accent/40"
                                          : "border-accent bg-accent text-accent-fg"
                                        : isSelected
                                          ? "border-ink bg-ink text-canvas"
                                          : "border-line bg-surface-muted text-muted hover:bg-line"
                                    }`}
                                  >
                                    {coverage === "partial" && (
                                      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent/50" />
                                    )}
                                    {territory.name}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  );
                })}
              </div>
            )}

            {selectedCountryIds.size > 0 && (
              <div className="rounded-xl border border-line bg-surface p-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-ink">
                    {pluralize(selectedCountryIds.size, "region")} selected. Choose taxon groups
                  </p>
                  {availableTaxaForSelection.length > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedTaxa(
                          availableTaxaForSelection.every((t) => selectedTaxa.has(t)) ? new Set() : new Set(availableTaxaForSelection),
                        )
                      }
                      className="text-xs text-accent hover:underline"
                    >
                      {availableTaxaForSelection.every((t) => selectedTaxa.has(t)) ? "Deselect all" : "Select all"}
                    </button>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {availableTaxaForSelection.length === 0 && (
                    <p className="text-xs text-muted">
                      No taxon data available yet for the selected {selectedCountryIds.size === 1 ? "region" : "regions"}.
                    </p>
                  )}
                  {availableTaxaForSelection
                    .filter((taxon) => !GROUPED_TAXON_CLASSES.has(taxon))
                    .map((taxon) => {
                      const isSelected = selectedTaxa.has(taxon);
                      return (
                        <Pill key={taxon} active={isSelected} onClick={() => toggleTaxon(taxon)}>
                          {taxonDisplayLabel(taxon, namingStyles)}
                        </Pill>
                      );
                    })}
                </div>
                {/* A group is only a disclosure: each audience (shells, molluscs, ...) picks its own taxa. */}
                {TAXON_GROUPS.map((group) => {
                  const availableInGroup = group.taxa.filter((t) => availableTaxaForSelection.includes(t));
                  if (availableInGroup.length === 0) return null;
                  const selectedCount = availableInGroup.filter((t) => selectedTaxa.has(t)).length;
                  const isOpen = openTaxonGroups.has(group.key);
                  const allInGroupSelected = availableInGroup.every((t) => selectedTaxa.has(t));
                  return (
                    <div key={group.key} className="mt-2 border-t border-line pt-2">
                      <div className="flex w-full items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            setOpenTaxonGroups((prev) => {
                              const next = new Set(prev);
                              if (next.has(group.key)) next.delete(group.key);
                              else next.add(group.key);
                              return next;
                            })
                          }
                          className="flex flex-1 items-center justify-between text-xs font-medium text-ink"
                        >
                          <span>
                            {group.label} ({selectedCount}/{availableInGroup.length} selected)
                          </span>
                          <span className="text-muted">{isOpen ? "▾" : "▸"}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setSelectedTaxa((prev) => {
                              const next = new Set(prev);
                              for (const t of availableInGroup) {
                                if (allInGroupSelected) next.delete(t);
                                else next.add(t);
                              }
                              return next;
                            })
                          }
                          className="shrink-0 text-xs text-accent hover:underline"
                        >
                          {allInGroupSelected ? "Deselect all" : "Select all"}
                        </button>
                      </div>
                      {isOpen && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {availableInGroup.map((taxon) => {
                            const isSelected = selectedTaxa.has(taxon);
                            return (
                              <Pill key={taxon} active={isSelected} onClick={() => toggleTaxon(taxon)}>
                                {taxonDisplayLabel(taxon, namingStyles)}
                              </Pill>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {downloadedPacks.length > 0 && (
              <DownloadedPacksList
                packs={packs ?? []}
                onRefresh={refreshPacks}
                showJobProgress={false}
                renderPackExtra={(p) =>
                  p.type === "region" ? (
                    <button
                      type="button"
                      onClick={() => openProvinceManager(p.id)}
                      className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:bg-surface-muted"
                    >
                      {provinceManagerPackId === p.id ? subdivisionLabel : "Provinces"}
                    </button>
                  ) : null
                }
                renderPackPanel={(p) =>
                  provinceManagerPackId === p.id ? (
                    <div className="mt-2 ml-6 rounded-md border border-line bg-surface-muted p-2">
                      <FormMessage error={provinceError} className="text-xs" />
                      {!provinceList && !provinceError && (
                        <p className="text-xs text-muted">Loading {subdivisionLabel.toLowerCase()}…</p>
                      )}
                      {provinceList && provinceList.length === 0 && (
                        <p className="text-xs text-muted">This pack has no {subdivisionLabel.toLowerCase()}.</p>
                      )}
                      {provinceList && provinceList.length > 0 && (
                        <ul className="max-h-64 space-y-1 overflow-y-auto">
                          {provinceList.map((province) => (
                            <li key={province.id} className="flex items-center gap-2 text-xs">
                              <input
                                type="checkbox"
                                checked={province.applied}
                                disabled={provinceBusyId === province.id}
                                onChange={() =>
                                  province.applied ? offloadProvince(p.id, province) : reapplyProvince(p.id, province)
                                }
                                className="h-3.5 w-3.5"
                              />
                              <span className="text-ink">{province.name}</span>
                              {provinceBusyId === province.id && <span className="text-muted">working…</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : null
                }
              />
            )}
          </>
        )}

        <div className="sticky bottom-4 space-y-3 rounded-xl border border-line bg-surface p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1 rounded-md border border-line p-0.5 text-sm">
              <button
                onClick={() => setDownloadVariant("full")}
                className={`rounded px-2.5 py-1 ${downloadVariant === "full" ? "bg-accent text-accent-fg" : "text-muted hover:text-ink"}`}
              >
                Full
              </button>
              <button
                onClick={() => setDownloadVariant("small")}
                className={`rounded px-2.5 py-1 ${downloadVariant === "small" ? "bg-accent text-accent-fg" : "text-muted hover:text-ink"}`}
              >
                Small
              </button>
            </div>
            <p className="text-xs text-muted">
              {downloadVariant === "full"
                ? "Bundles every reference photo, fully usable offline."
                : "Only the featured photo per species; extra gallery photos load when you're online."}
              {selectedCountryIds.size > 0 && ` Switching would make this ${formatBytes(otherVariantSizeBytes)}.`}
            </p>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted">
              {selectedCountryIds.size === 0
                ? "Nothing selected"
                : `${pluralize(selectedCountryIds.size, "region")}, ${selectedTaxa.size === 0 ? "all taxa" : pluralize(selectedTaxa.size, "taxon group")}, ${formatBytes(selectionSizeBytes)}`}
            </p>
            <div className="flex items-center gap-3">
              {startError && <FormMessage error={startError} className="py-1" />}
              <button
                onClick={startDownload}
                disabled={selectedCountryIds.size === 0 || starting || status?.running}
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
              >
                {starting ? "Starting…" : "Download selected"}
              </button>
            </div>
          </div>
        </div>
      </main>

    </div>
  );
}
