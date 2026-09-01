import { useEffect, useMemo, useRef, useState } from "react";
import type { RegionSummary, TaxonClass } from "@lifer/shared";
import { TAXON_CLASS_LABEL } from "@lifer/shared";
import { api, ApiError } from "../api/client";
import { Spinner } from "../components/LoadingScreen";
import BackToCollectionLink from "../components/BackToCollectionLink";
import InfoTip from "../components/InfoTip";
import PacksMap, { type CountryBoundary } from "../components/PacksMap";

const PACKS_INFO_PARAGRAPHS = [
  '"Update available" means the pack\'s checklist data (which species occur there, and how often) has changed since you downloaded it. Re-downloading refreshes that.',
];

interface PackEntry {
  id: string;
  type: "region" | "seaZone";
  region?: string;
  seaZone?: string;
  taxon?: TaxonClass | null;
  sizeBytes: number;
  speciesCount: number;
  downloaded: boolean;
  updateAvailable: boolean;
}

interface DownloadStatus {
  running: boolean;
  processed: number;
  total: number;
  currentPack: string | null;
  error: string | null;
  finishedAt: number | null;
}

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

interface DeletePreview {
  checklistRegionsAffectedCount: number;
  speciesToRemoveCount: number;
  speciesKeptCount: number;
  bytesToFree: number;
  isEstimate: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// Map + continent pills + country search + a taxon multi-select applied uniformly across every
// selected country, replacing the old per-pack-checkbox accordion — see this feature's own plan
// for why: items 3/5/6 need "selected countries" crossed with "selected taxa" as the primary
// state, with pack ids only resolved once, at download time (POST /offline-packs/download-batch),
// not one checkbox per country per taxon.
export default function OfflinePacksPage() {
  const [regions, setRegions] = useState<RegionSummary[] | null>(null);
  const [countryBoundaries, setCountryBoundaries] = useState<CountryBoundary[] | null>(null);
  const [packs, setPacks] = useState<PackEntry[] | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [selectedCountryIds, setSelectedCountryIds] = useState<Set<string>>(new Set());
  const [openContinentIds, setOpenContinentIds] = useState<Set<string>>(new Set());
  const [selectedTaxa, setSelectedTaxa] = useState<Set<TaxonClass>>(new Set());
  const [focusCountryIds, setFocusCountryIds] = useState<string[] | undefined>(undefined);
  const [searchTerm, setSearchTerm] = useState("");
  const [availableTaxaByRegion, setAvailableTaxaByRegion] = useState<Record<string, TaxonClass[]>>({});
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [status, setStatus] = useState<DownloadStatus | null>(null);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [recommendationError, setRecommendationError] = useState<string | null>(null);
  const [offloadTargets, setOffloadTargets] = useState<PackEntry[] | null>(null);
  const [deletePreview, setDeletePreview] = useState<DeletePreview | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [selectedOffloadIds, setSelectedOffloadIds] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [provinceManagerPackId, setProvinceManagerPackId] = useState<string | null>(null);
  const [provinceList, setProvinceList] = useState<ProvinceEntry[] | null>(null);
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
    api.get<{ regions: RegionSummary[] }>("/regions").then((res) => setRegions(res.regions));
    api
      .get<{ regions: CountryBoundary[] }>("/regions/boundaries?level=country")
      .then((res) => setCountryBoundaries(res.regions));
    refreshPacks();
  }, []);

  // Arrived from the library reimport tool's "N species missing reference data" link
  // (SettingsPage.tsx) with the gap list in the URL — check which packs would cover it.
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

  const wasRunning = useRef(false);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const res = await api.get<DownloadStatus>("/offline-packs/download/status");
        if (!cancelled) {
          setStatus(res);
          if (wasRunning.current && !res.running) refreshPacks();
          wasRunning.current = res.running;
        }
      } catch {
        // ignore — status just won't update this tick
      }
      if (!cancelled) timer = setTimeout(poll, 2000);
    }
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  // Which taxa this selection could even offer — unioned across every selected country so a
  // taxon present in only ONE of several selected countries still shows up (item 6's own
  // requirement), not just taxa common to all of them.
  useEffect(() => {
    if (selectedCountryIds.size === 0) return;
    const missing = [...selectedCountryIds].filter((id) => !(id in availableTaxaByRegion));
    if (missing.length === 0) return;
    api
      .get<Record<string, TaxonClass[]>>(`/regions/taxon-presence?regionIds=${missing.join(",")}`)
      .then((res) => setAvailableTaxaByRegion((prev) => ({ ...prev, ...res })));
  }, [selectedCountryIds, availableTaxaByRegion]);

  const world = regions?.find((r) => r.parentId === null);
  const continents = useMemo(() => (regions ?? []).filter((r) => r.parentId === world?.id), [regions, world]);
  const countriesByContinent = useMemo(() => {
    const map = new Map<string, RegionSummary[]>();
    for (const r of regions ?? []) {
      if (!r.parentId) continue;
      if (!map.has(r.parentId)) map.set(r.parentId, []);
      map.get(r.parentId)!.push(r);
    }
    return map;
  }, [regions]);
  const countryById = useMemo(() => new Map((regions ?? []).map((r) => [r.id, r])), [regions]);

  // Which continents currently have their country-pill group expanded — an explicit UI toggle,
  // separate from selection: clicking a continent pill only ever opens/closes its own group, it
  // never selects countries itself (that's what "Select all" and individual country pills are
  // for).
  const openContinents = useMemo(() => continents.filter((c) => openContinentIds.has(c.id)), [continents, openContinentIds]);

  // Every country belonging to any currently-open continent — passed to PacksMap so it can
  // outline them (a distinct, weaker visual than "selected") without implying they're selected.
  const openCountryIds = useMemo(() => {
    const set = new Set<string>();
    for (const continentId of openContinentIds) {
      for (const c of countriesByContinent.get(continentId) ?? []) set.add(c.id);
    }
    return set;
  }, [openContinentIds, countriesByContinent]);

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
    setSelectedCountryIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleContinent(continentId: string, countries: RegionSummary[]) {
    const willOpen = !openContinentIds.has(continentId);
    setOpenContinentIds((prev) => {
      const next = new Set(prev);
      if (willOpen) next.add(continentId);
      else next.delete(continentId);
      return next;
    });
    // Opening a continent's pill group focuses the map on it (an outline, not a selection —
    // see PacksMap's continentOpen paint state); closing it doesn't re-fit anywhere, it just
    // stops showing that outline.
    if (willOpen) setFocusCountryIds(countries.map((c) => c.id));
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
    setFocusCountryIds([region.id]);
    setSearchTerm("");
    if (region.parentId) setOpenContinentIds((prev) => new Set(prev).add(region.parentId!));
    // Scrolled to on the next tick, after the row actually renders (it may not exist yet this
    // render if this country's continent wasn't already open).
    setTimeout(() => countryRowRefs.current.get(region.id)?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 0);
  }

  // "info: PackEntry.taxon === null" means that pack covers every taxon for its region — a
  // country with any such pack downloaded reads as full coverage; one with only specific-taxon
  // packs downloaded reads as partial (per Fix 6's "bird icon if just birds are downloaded" ask,
  // implemented here as a text label rather than a new icon set, since none exists in this app).
  function countryCoverage(countryName: string): "full" | "partial" | "none" {
    const entries = packsByRegion.get(countryName) ?? [];
    const downloaded = entries.filter((p) => p.downloaded);
    if (downloaded.length === 0) return "none";
    return downloaded.some((p) => p.taxon == null) ? "full" : "partial";
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
      if (!map.has(region)) map.set(region, []);
      map.get(region)!.push(p);
    }
    return map;
  }, [packs]);

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

  async function startDownload() {
    setStartError(null);
    setStarting(true);
    try {
      const regionNames = [...selectedCountryIds].map((id) => countryById.get(id)?.name).filter((n): n is string => !!n);
      await api.post("/offline-packs/download-batch", {
        regionNames,
        taxa: selectedTaxa.size > 0 ? [...selectedTaxa] : "all",
      });
      setSelectedCountryIds(new Set());
      setSelectedTaxa(new Set());
    } catch (err) {
      setStartError(err instanceof ApiError ? err.message : "Couldn't start the download");
    } finally {
      setStarting(false);
    }
  }

  async function updatePacks(packIds: string[]) {
    setStartError(null);
    setStarting(true);
    try {
      await api.post("/offline-packs/download", { packIds });
      refreshPacks();
    } catch (err) {
      setStartError(err instanceof ApiError ? err.message : "Couldn't start the update");
    } finally {
      setStarting(false);
    }
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
      const res = await api.get<{ provinces: ProvinceEntry[] }>(`/offline-packs/${encodeURIComponent(packId)}/provinces`);
      setProvinceList(res.provinces);
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

  // Re-adding a province has no dedicated "apply just this one" path (see this pack's own
  // offload-route comment) — the whole archive gets re-downloaded (which restores every
  // province unconditionally), then everything still meant to stay excluded gets trimmed back
  // out in one follow-up call.
  async function reapplyProvince(packId: string, province: ProvinceEntry) {
    if (!provinceList) return;
    setProvinceBusyId(province.id);
    setProvinceError(null);
    try {
      await api.post("/offline-packs/download", { packIds: [packId], force: true });
      for (;;) {
        const jobStatus = await api.get<DownloadStatus>("/offline-packs/download/status");
        if (!jobStatus.running) {
          if (jobStatus.error) throw new Error(jobStatus.error);
          break;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      const stillExcluded = provinceList.filter((p) => !p.applied && p.id !== province.id).map((p) => p.id);
      if (stillExcluded.length > 0) {
        await api.post(`/offline-packs/${encodeURIComponent(packId)}/provinces/offload`, { regionIds: stillExcluded });
      }
      const res = await api.get<{ provinces: ProvinceEntry[] }>(`/offline-packs/${encodeURIComponent(packId)}/provinces`);
      setProvinceList(res.provinces);
      refreshPacks();
    } catch (err) {
      setProvinceError(err instanceof ApiError ? err.message : "Couldn't re-add this province");
    } finally {
      setProvinceBusyId(null);
    }
  }

  async function openOffloadConfirm(targets: PackEntry[]) {
    setOffloadTargets(targets);
    setDeletePreview(null);
    setDeleteError(null);
    try {
      const preview = await api.post<DeletePreview>("/offline-packs/offload-preview", { packIds: targets.map((p) => p.id) });
      setDeletePreview(preview);
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Couldn't check what offloading this would affect");
    }
  }

  async function confirmOffload() {
    if (!offloadTargets) return;
    setDeleting(true);
    try {
      await api.post("/offline-packs/offload-batch", { packIds: offloadTargets.map((p) => p.id) });
      setOffloadTargets(null);
      setDeletePreview(null);
      setSelectedOffloadIds(new Set());
      refreshPacks();
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Couldn't remove these packs");
    } finally {
      setDeleting(false);
    }
  }

  function toggleOffloadSelection(id: string) {
    setSelectedOffloadIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleGroupCollapsed(name: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  const downloadedPacks = (packs ?? []).filter((p) => p.downloaded);
  const downloadedGroups = useMemo(() => {
    const map = new Map<string, PackEntry[]>();
    for (const p of downloadedPacks) {
      const name = p.region ?? p.seaZone ?? "Other";
      if (!map.has(name)) map.set(name, []);
      map.get(name)!.push(p);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [downloadedPacks]);

  return (
    <div className="min-h-screen bg-canvas">
      <header className="page-header border-b border-line bg-surface px-6 py-4">
        <BackToCollectionLink fallbackTo="/settings" label="Settings" className="text-sm text-muted hover:underline" />
        <div className="mt-1 flex items-center gap-2">
          <h1 className="text-lg font-semibold text-ink">Offline packs</h1>
          <InfoTip paragraphs={PACKS_INFO_PARAGRAPHS} />
        </div>
        <p className="mt-1 text-sm text-muted">
          Download reference photos and habitat info for a region so it's usable without an internet connection.
        </p>
      </header>

      <main className="mx-auto max-w-3xl space-y-6 p-6">
        {indexError && <p className="text-sm text-red-600">{indexError}</p>}
        {recommendationError && <p className="text-sm text-red-600">{recommendationError}</p>}

        {recommendation && (
          <div className="rounded-xl border border-line bg-surface p-4">
            {recommendation.recommended.length === 0 ? (
              <p className="text-sm text-muted">
                None of the available packs cover the missing species from your library — they may not have offline packs yet.
              </p>
            ) : (
              <>
                <p className="text-sm text-ink">These packs would restore reference data for the species your reimport found missing:</p>
                <ul className="mt-2 space-y-1 text-sm text-muted">
                  {recommendation.recommended.map((p) => (
                    <li key={p.id}>
                      {p.region ?? p.seaZone} {p.taxon ? `(${TAXON_CLASS_LABEL[p.taxon]})` : ""} — covers {p.covers} species,{" "}
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
            <p className="text-sm text-ink">
              Downloading… {status.processed}/{status.total}
              {status.currentPack ? ` (${status.currentPack})` : ""}
            </p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-muted">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${status.total ? Math.round((status.processed / status.total) * 100) : 0}%` }}
              />
            </div>
          </div>
        )}
        {status && !status.running && status.finishedAt && Date.now() - status.finishedAt < 15000 && (
          <p className={`text-sm ${status.error ? "text-red-600" : "text-green-700"}`}>
            {status.error ? `Download failed: ${status.error}` : `Done — ${status.processed} pack(s) applied.`}
          </p>
        )}

        {!regions || !countryBoundaries || !packs ? (
          <Spinner />
        ) : (
          <>
            <PacksMap
              countries={countryBoundaries}
              selectedIds={selectedCountryIds}
              onToggleCountry={toggleCountry}
              focusCountryIds={focusCountryIds}
              openCountryIds={openCountryIds}
            />

            <div className="flex flex-wrap gap-2">
              {continents.map((continent) => {
                const countries = countriesByContinent.get(continent.id) ?? [];
                if (countries.length === 0) return null;
                const isOpen = openContinentIds.has(continent.id);
                return (
                  <button
                    key={continent.id}
                    type="button"
                    onClick={() => toggleContinent(continent.id, countries)}
                    className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                      isOpen ? "border-ink bg-ink text-canvas" : "border-line bg-surface-muted text-ink hover:bg-line"
                    }`}
                  >
                    {continent.name}
                  </button>
                );
              })}
            </div>

            <div className="relative">
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search for a country…"
                className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink"
              />
              {searchResults.length > 0 && (
                <ul className="absolute z-10 mt-1 w-full rounded-md border border-line bg-surface shadow-md">
                  {searchResults.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => selectSearchResult(r)}
                        className="block w-full px-3 py-2 text-left text-sm text-ink hover:bg-surface-muted"
                      >
                        {r.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

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
                          return (
                            <button
                              key={country.id}
                              type="button"
                              ref={(el) => {
                                if (el) countryRowRefs.current.set(country.id, el);
                                else countryRowRefs.current.delete(country.id);
                              }}
                              onClick={() => toggleCountry(country.id)}
                              title={coverage === "full" ? "Fully downloaded" : coverage === "partial" ? "Partially downloaded" : undefined}
                              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                                coverage === "full"
                                  ? isSelected
                                    ? "border-green-700 bg-green-700 text-white ring-2 ring-green-700/40"
                                    : "border-green-600 bg-green-600 text-white"
                                  : isSelected
                                    ? "border-ink bg-ink text-canvas"
                                    : "border-line bg-surface-muted text-ink hover:bg-line"
                              }`}
                            >
                              {coverage === "partial" && (
                                <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-600/50" />
                              )}
                              {country.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {selectedCountryIds.size > 0 && (
              <div className="rounded-xl border border-line bg-surface p-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-ink">
                    {selectedCountryIds.size} region(s) selected — choose taxon groups
                  </p>
                  {availableTaxaForSelection.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setSelectedTaxa(new Set(availableTaxaForSelection))}
                      className="text-xs text-accent hover:underline"
                    >
                      Select all
                    </button>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {availableTaxaForSelection.length === 0 && (
                    <p className="text-xs text-muted">No taxon data available yet for the selected region(s).</p>
                  )}
                  {availableTaxaForSelection.map((taxon) => {
                    const isSelected = selectedTaxa.has(taxon);
                    return (
                      <button
                        key={taxon}
                        type="button"
                        onClick={() => toggleTaxon(taxon)}
                        className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                          isSelected ? "border-ink bg-ink text-canvas" : "border-line text-muted hover:bg-surface-muted"
                        }`}
                      >
                        {TAXON_CLASS_LABEL[taxon]}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {downloadedPacks.length > 0 && (
              <div className="rounded-xl border border-line bg-surface p-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-ink">Downloaded</p>
                  <div className="flex gap-2">
                    {downloadedPacks.some((p) => p.updateAvailable) && (
                      <button
                        type="button"
                        disabled={starting}
                        onClick={() => updatePacks(downloadedPacks.filter((p) => p.updateAvailable).map((p) => p.id))}
                        className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-fg disabled:opacity-50"
                      >
                        Update all
                      </button>
                    )}
                    {selectedOffloadIds.size > 0 && (
                      <button
                        type="button"
                        onClick={() => openOffloadConfirm(downloadedPacks.filter((p) => selectedOffloadIds.has(p.id)))}
                        className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:bg-surface-muted"
                      >
                        Offload selected ({selectedOffloadIds.size})
                      </button>
                    )}
                  </div>
                </div>
                <div className="mt-2 divide-y divide-line">
                  {downloadedGroups.map(([groupName, groupPacks]) => {
                    const groupIds = groupPacks.map((p) => p.id);
                    const groupSelected = groupIds.every((id) => selectedOffloadIds.has(id));
                    const groupBytes = groupPacks.reduce((sum, p) => sum + p.sizeBytes, 0);
                    const collapsed = collapsedGroups.has(groupName);
                    return (
                      <div key={groupName} className="py-2">
                        <div className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={groupSelected}
                            onChange={() =>
                              setSelectedOffloadIds((prev) => {
                                const next = new Set(prev);
                                for (const id of groupIds) {
                                  if (groupSelected) next.delete(id);
                                  else next.add(id);
                                }
                                return next;
                              })
                            }
                            className="h-4 w-4"
                          />
                          <button
                            type="button"
                            onClick={() => toggleGroupCollapsed(groupName)}
                            className="flex flex-1 items-center justify-between text-left text-ink"
                          >
                            <span>
                              {groupName} <span className="text-xs text-muted">({groupPacks.length} pack{groupPacks.length === 1 ? "" : "s"})</span>
                            </span>
                            <span className="text-xs text-muted">
                              {formatBytes(groupBytes)} {collapsed ? "▸" : "▾"}
                            </span>
                          </button>
                        </div>
                        {!collapsed && (
                          <ul className="mt-1 ml-6 divide-y divide-line">
                            {groupPacks.map((p) => (
                              <li key={p.id} className="py-1.5">
                                <div className="flex items-center gap-2 text-sm">
                                  <input
                                    type="checkbox"
                                    checked={selectedOffloadIds.has(p.id)}
                                    onChange={() => toggleOffloadSelection(p.id)}
                                    className="h-4 w-4"
                                  />
                                  <span className="flex-1 text-ink">
                                    {p.taxon ? TAXON_CLASS_LABEL[p.taxon] : "All taxa"}
                                    {p.updateAvailable && <span className="ml-2 text-xs text-accent">update available</span>}
                                  </span>
                                  <span className="text-xs text-muted">{formatBytes(p.sizeBytes)}</span>
                                  {p.updateAvailable && (
                                    <button
                                      type="button"
                                      disabled={starting}
                                      onClick={() => updatePacks([p.id])}
                                      className="rounded-md border border-accent px-2 py-1 text-xs font-medium text-accent hover:bg-surface-muted disabled:opacity-50"
                                    >
                                      Update
                                    </button>
                                  )}
                                  {p.type === "region" && (
                                    <button
                                      type="button"
                                      onClick={() => openProvinceManager(p.id)}
                                      className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:bg-surface-muted"
                                    >
                                      Provinces
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => openOffloadConfirm([p])}
                                    className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:bg-surface-muted"
                                  >
                                    Offload
                                  </button>
                                </div>
                                {provinceManagerPackId === p.id && (
                                  <div className="mt-2 ml-6 rounded-md border border-line bg-surface-muted p-2">
                                    {provinceError && <p className="text-xs text-red-600">{provinceError}</p>}
                                    {!provinceList && !provinceError && <p className="text-xs text-muted">Loading provinces…</p>}
                                    {provinceList && provinceList.length === 0 && (
                                      <p className="text-xs text-muted">This pack has no provinces.</p>
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
                                                province.applied
                                                  ? offloadProvince(p.id, province)
                                                  : reapplyProvince(p.id, province)
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
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}

        <div className="sticky bottom-4 flex items-center justify-between rounded-xl border border-line bg-surface p-4 shadow-sm">
          <p className="text-sm text-muted">
            {selectedCountryIds.size === 0
              ? "Nothing selected"
              : `${selectedCountryIds.size} region(s), ${selectedTaxa.size === 0 ? "all taxa" : `${selectedTaxa.size} taxon group(s)`} — ${formatBytes(selectionSizeBytes)}`}
          </p>
          <div className="flex items-center gap-3">
            {startError && <span className="text-sm text-red-600">{startError}</span>}
            <button
              onClick={startDownload}
              disabled={selectedCountryIds.size === 0 || starting || status?.running}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
            >
              {starting ? "Starting…" : "Download selected"}
            </button>
          </div>
        </div>
      </main>

      {offloadTargets && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-line bg-surface p-5">
            <h2 className="text-base font-semibold text-ink">
              {offloadTargets.length === 1 ? (
                <>
                  Offload {offloadTargets[0].region ?? offloadTargets[0].seaZone}
                  {offloadTargets[0].taxon ? ` (${TAXON_CLASS_LABEL[offloadTargets[0].taxon]})` : ""}?
                </>
              ) : (
                <>Offload {offloadTargets.length} selected packs?</>
              )}
            </h2>
            {deleteError && <p className="mt-2 text-sm text-red-600">{deleteError}</p>}
            {!deletePreview && !deleteError && <p className="mt-3 text-sm text-muted">Checking what this would affect…</p>}
            {deletePreview && (
              <div className="mt-3 space-y-1 text-sm text-muted">
                <p>
                  {deletePreview.isEstimate ? (
                    <>This pack takes up about {formatBytes(deletePreview.bytesToFree)}. Offloading it will free that space.</>
                  ) : (
                    <>
                      {deletePreview.speciesToRemoveCount} species' reference photos would be removed, freeing{" "}
                      {formatBytes(deletePreview.bytesToFree)}.
                    </>
                  )}
                </p>
                {deletePreview.speciesKeptCount > 0 && (
                  <p>
                    {deletePreview.speciesKeptCount} species would keep their photos: you've photographed them yourself, or another
                    downloaded pack still needs them.
                  </p>
                )}
                {deletePreview.checklistRegionsAffectedCount > 0 && (
                  <p>
                    {deletePreview.checklistRegionsAffectedCount === 1
                      ? "This region's checklist"
                      : `${deletePreview.checklistRegionsAffectedCount} regions' checklists (including this one)`}{" "}
                    will no longer be available offline.
                  </p>
                )}
                <p className="text-xs text-muted">
                  This only affects downloaded reference photos and checklist data. Your own captures and Gallery photos are never
                  touched.
                </p>
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOffloadTargets(null)}
                className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-surface-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmOffload}
                disabled={!deletePreview || deleting}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {deleting ? "Removing…" : "Offload"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
