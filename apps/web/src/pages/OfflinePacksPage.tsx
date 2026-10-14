import { useEffect, useRef, useState } from "react";
import type { RegionSummary } from "@lifer/shared";
import { TAXON_GROUPS, GROUPED_TAXON_CLASSES, taxonDisplayLabel } from "@lifer/shared";
import { api, ApiError, type ApiResponse } from "../api/client";
import { Spinner } from "../components/LoadingScreen";
import Pill from "../components/Pill";
import PageHeader from "../components/PageHeader";
import SegmentedControl from "../components/SegmentedControl";
import InfoTip from "../components/InfoTip";
import PacksMap, { type CountryBoundary } from "../components/PacksMap";
import RegionPicker from "../components/RegionPicker";
import DownloadedPacksList from "../components/DownloadedPacksList";
import ShowForAWhile from "../components/ShowForAWhile";
import JobProgress from "../components/JobProgress";
import FormMessage from "../components/FormMessage";
import { usePackDownloadJob, packProgressDetail, PACK_DOWNLOAD_PHASES } from "../hooks/usePackDownloadStatus";
import { useRegions } from "../hooks/useRegions";
import { useSettings } from "../hooks/useSettings";
import { formatBytes } from "../lib/format";
import { usePackIndex } from "../lib/packIndex";
import { pluralize } from "../lib/pluralize";
import ProvinceManager from "./offlinePacks/ProvinceManager";
import { useOfflinePackSelection } from "./offlinePacks/useOfflinePackSelection";
import { ignore } from "../lib/ignore";
import { PANEL } from "../lib/layout";

const PACKS_INFO_PARAGRAPHS = [
  '"Update available" means the pack\'s checklist data (which species occur there, and how often) has changed since you downloaded it. Re-downloading refreshes that.',
];

type Recommendation = ApiResponse<"/offline-packs/recommend", "post">;

// Map, continent pills, country search, and one taxon selection applied across every selected
// country (see useOfflinePackSelection).
export default function OfflinePacksPage() {
  const { regions, error: regionsError } = useRegions();
  const { settings } = useSettings();
  const [countryBoundaries, setCountryBoundaries] = useState<CountryBoundary[] | null>(null);
  const [boundariesError, setBoundariesError] = useState<string | null>(null);
  const { packs, error: packsError, refresh: refreshPackIndex } = usePackIndex();
  const indexError = packsError
    ? packsError instanceof ApiError
      ? packsError.message
      : "Couldn't load available packs"
    : null;
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [recommendationError, setRecommendationError] = useState<string | null>(null);
  const [provinceManagerPackId, setProvinceManagerPackId] = useState<string | null>(null);
  // "States", "Regions" or "Provinces", from the country's own admin-1 data on the server.
  const [subdivisionLabel, setSubdivisionLabel] = useState("Provinces");
  // Taxon labels follow the naming preference (and cover Other Taxa's raw iconic names).
  const namingStyles = settings?.speciesNamingStyles ?? [];
  const countryRowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const selection = useOfflinePackSelection(regions, packs);
  const {
    continents,
    countriesByContinent,
    territoriesByContinent,
    territoriesByCountryId,
    selectedCountryIds,
    setSelectedCountryIds,
    selectedTaxa,
    setSelectedTaxa,
    downloadVariant,
    setDownloadVariant,
    openTaxonGroups,
    openContinentIds,
    openContinents,
    countryCoverage,
    availableTaxaForSelection,
    toggleCountry,
    toggleTaxon,
  } = selection;

  function refreshPacks() {
    refreshPackIndex().catch(ignore("Couldn't refresh the pack index"));
  }

  useEffect(() => {
    api
      .get<{ regions: CountryBoundary[] }>("/regions/boundaries?level=country")
      .then((res) => setCountryBoundaries(res.regions))
      .catch((err) => {
        setBoundariesError(err instanceof ApiError ? err.message : "Couldn't load the country map");
        setCountryBoundaries([]);
      });
    // This is where downloads are managed, so it shouldn't open on a stale list.
    refreshPackIndex().catch(ignore("Couldn't refresh the pack index"));
  }, [refreshPackIndex]);

  // Arrived from the library reimport tool's "N species missing reference data" link
  // (SettingsPage.tsx) with the gap list in the URL: check which packs would cover it.
  useEffect(() => {
    const missing = new URLSearchParams(window.location.search).get("missing");
    if (!missing) return;
    const scientificNames = missing.split(",").filter(Boolean);
    if (scientificNames.length === 0) return;
    api
      .post("/offline-packs/recommend", { scientificNames })
      .then(setRecommendation)
      .catch((err) =>
        setRecommendationError(err instanceof ApiError ? err.message : "Couldn't compute pack recommendations"),
      );
  }, []);

  // The pack index refreshes itself when a download finishes (lib/packIndex.ts).
  const downloadJob = usePackDownloadJob();
  const status = downloadJob.status;

  function selectSearchResult(region: RegionSummary) {
    selection.selectSearchResult(region);
    // Next tick, once the row has rendered.
    setTimeout(
      () => countryRowRefs.current.get(region.id)?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
      0,
    );
  }

  async function startDownload() {
    setStartError(null);
    setStarting(true);
    try {
      await api.post("/offline-packs/download-batch", {
        regionNames: selection.selectedCountryNames,
        taxa: selectedTaxa.size > 0 ? [...selectedTaxa] : "all",
        variant: downloadVariant,
      });
      selection.clearSelection();
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

  const downloadedPacks = (packs ?? []).filter((p) => p.downloaded);

  return (
    <div className="flex-1 bg-canvas">
      <PageHeader
        sticky
        title="Offline packs"
        backFallbackTo="/settings"
        backLabel="Settings"
        titleAddon={<InfoTip paragraphs={PACKS_INFO_PARAGRAPHS} />}
      >
        <p className="mt-1 text-sm text-muted">
          Download reference photos and habitat info for a region so it's usable without an internet connection.
        </p>
      </PageHeader>

      <main className="mx-auto max-w-3xl space-y-section p-page">
        <FormMessage error={indexError} />
        <FormMessage error={recommendationError} />
        <FormMessage error={boundariesError} />
        {!regions && !!regionsError && <FormMessage error="Couldn't load the region list." />}

        {recommendation && (
          <div className={PANEL}>
            {recommendation.recommended.length === 0 ? (
              <p className="text-sm text-muted">
                None of the available packs cover the missing species from your library. They may not have offline packs
                yet.
              </p>
            ) : (
              <>
                <p className="text-sm text-ink">
                  These packs would restore reference data for the species your reimport found missing:
                </p>
                <ul className="mt-2 space-y-1 text-sm text-muted">
                  {recommendation.recommended.map((p) => (
                    <li key={p.id}>
                      {p.region ?? p.seaZone} {p.taxon ? `(${taxonDisplayLabel(p.taxon, namingStyles)})` : ""}: covers{" "}
                      {p.covers} species, {formatBytes(p.sizeBytes)}
                    </li>
                  ))}
                </ul>
                {recommendation.uncovered.length > 0 && (
                  <p className="mt-2 text-xs text-muted">
                    {recommendation.uncovered.length} species aren't covered by any available pack yet.
                  </p>
                )}
                <button
                  onClick={() =>
                    selection.selectRegionsByName(
                      recommendation.recommended.map((p) => p.region ?? p.seaZone).filter((n): n is string => !!n),
                    )
                  }
                  className="mt-3 rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-surface-muted"
                >
                  Select these regions
                </button>
              </>
            )}
          </div>
        )}

        {status?.running && (
          <div className={PANEL}>
            <JobProgress
              status={status}
              phases={PACK_DOWNLOAD_PHASES}
              detail={packProgressDetail(status)}
              onCancel={cancelDownload}
              cancelling={downloadJob.cancelling}
            />
          </div>
        )}
        {status && !status.running && status.finishedAt && (
          <ShowForAWhile key={status.finishedAt} since={status.finishedAt} forMs={15000}>
            {status.error ? (
              <FormMessage error={`Download failed: ${status.error}`} />
            ) : (
              <div className={PANEL}>
                <p className="text-sm text-ink">
                  {status.cancelled
                    ? `Cancelled. ${pluralize(status.processed ?? 0, "pack")} had already finished applying before you stopped it.`
                    : `Done, ${pluralize(status.result?.packsApplied ?? status.processed ?? 0, "pack")} applied.`}
                </p>
              </div>
            )}
          </ShowForAWhile>
        )}

        {!regions || !countryBoundaries || !packs ? (
          regionsError && !regions ? null : (
            <Spinner />
          )
        ) : (
          <>
            <PacksMap
              countries={countryBoundaries}
              selectedIds={selectedCountryIds}
              onToggleCountry={toggleCountry}
              focusCountryIds={selection.focusCountryIds}
              openCountryIds={selection.openCountryIds}
              onDeselectAll={() => setSelectedCountryIds(new Set())}
            />

            <RegionPicker
              mode="multi"
              items={continents.filter((c) => (countriesByContinent.get(c.id) ?? []).length > 0)}
              selectedIds={openContinentIds}
              onToggleItem={selection.toggleContinent}
            />

            <RegionPicker
              mode="multi"
              search={{
                term: selection.searchTerm,
                onTermChange: selection.setSearchTerm,
                results: selection.searchResults,
                onSelectResult: (item) => selectSearchResult(item as RegionSummary),
                placeholder: "Search for a country…",
              }}
            />

            {openContinents.length > 0 && (
              <div className={`space-y-item ${PANEL}`}>
                {openContinents.map((continent) => {
                  const countries = countriesByContinent.get(continent.id) ?? [];
                  return (
                    <div key={continent.id}>
                      <div className="mb-1.5 flex items-center justify-between">
                        {openContinents.length > 1 && (
                          <p className="text-sm font-semibold text-ink">{continent.name}</p>
                        )}
                        <button
                          type="button"
                          onClick={() => selection.toggleAllCountries(countries)}
                          className="ml-auto text-xs font-medium text-accent hover:underline"
                        >
                          {countries.length > 0 && countries.every((c) => selectedCountryIds.has(c.id))
                            ? "Deselect all"
                            : "Select all"}
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
                                title={
                                  coverage === "full"
                                    ? "Fully downloaded"
                                    : coverage === "partial"
                                      ? "Partially downloaded"
                                      : undefined
                                }
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
                                  <span className="text-xs text-muted">Territories:</span>
                                  <button
                                    type="button"
                                    onClick={() => selection.toggleAllCountries(territories)}
                                    className="text-xs font-medium text-accent hover:underline"
                                  >
                                    {territories.every((t) => selectedCountryIds.has(t.id))
                                      ? "Deselect all"
                                      : "Select all"}
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
                                        className={`flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs transition-colors ${
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
                                          <span
                                            aria-hidden
                                            className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-fg/70"
                                          />
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
                        const otherTerritories = territoriesByContinent.get(continent.id) ?? [];
                        if (otherTerritories.length === 0) return null;
                        // Fallback for finding a territory directly, not only under its country.
                        const allOtherSelected = otherTerritories.every((t) => selectedCountryIds.has(t.id));
                        return (
                          <div className="mt-2 border-t border-line pt-2">
                            <div className="mb-1.5 flex items-center justify-between">
                              <p className="text-xs text-muted">Other territories</p>
                              <button
                                type="button"
                                onClick={() => selection.toggleAllCountries(otherTerritories)}
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
                                    title={
                                      coverage === "full"
                                        ? "Fully downloaded"
                                        : coverage === "partial"
                                          ? "Partially downloaded"
                                          : undefined
                                    }
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
              <div className={PANEL}>
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-ink">
                    {pluralize(selectedCountryIds.size, "region")} selected. Choose taxon groups
                  </p>
                  {availableTaxaForSelection.length > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedTaxa(
                          availableTaxaForSelection.every((t) => selectedTaxa.has(t))
                            ? new Set()
                            : new Set(availableTaxaForSelection),
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
                      No taxon data available yet for the selected{" "}
                      {selectedCountryIds.size === 1 ? "region" : "regions"}.
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
                          onClick={() => selection.toggleTaxonGroup(group.key)}
                          className="flex flex-1 items-center justify-between text-xs font-medium text-ink"
                        >
                          <span>
                            {group.label} ({selectedCount}/{availableInGroup.length} selected)
                          </span>
                          <span className="text-muted">{isOpen ? "▾" : "▸"}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => selection.toggleAllTaxa(availableInGroup)}
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
                      onClick={() => setProvinceManagerPackId((open) => (open === p.id ? null : p.id))}
                      className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:bg-surface-muted"
                    >
                      {provinceManagerPackId === p.id ? subdivisionLabel : "Provinces"}
                    </button>
                  ) : null
                }
                renderPackPanel={(p) =>
                  provinceManagerPackId === p.id ? (
                    <ProvinceManager
                      key={p.id}
                      packId={p.id}
                      subdivisionLabel={subdivisionLabel}
                      onSubdivisionLabel={setSubdivisionLabel}
                      downloadJob={downloadJob}
                      onPacksChanged={refreshPacks}
                    />
                  ) : null
                }
              />
            )}
          </>
        )}

        <div className={`sticky bottom-4 space-y-3 shadow-sm ${PANEL}`}>
          <div className="flex items-center justify-between gap-3">
            <SegmentedControl
              value={downloadVariant}
              onChange={setDownloadVariant}
              options={[
                { value: "full", label: "Full" },
                { value: "small", label: "Small" },
              ]}
            />
            <p className="text-xs text-muted">
              {downloadVariant === "full"
                ? "Bundles every reference photo, fully usable offline."
                : "Only the featured photo per species; extra gallery photos load when you're online."}
              {selectedCountryIds.size > 0 &&
                ` Switching would make this ${formatBytes(selection.otherVariantSizeBytes)}.`}
            </p>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted">
              {selectedCountryIds.size === 0
                ? "Nothing selected"
                : `${pluralize(selectedCountryIds.size, "region")}, ${selectedTaxa.size === 0 ? "all taxa" : pluralize(selectedTaxa.size, "taxon group")}, ${formatBytes(selection.selectionSizeBytes)}`}
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
