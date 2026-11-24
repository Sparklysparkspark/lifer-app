import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import type { RegionSummary } from "@lifer/shared";
import { taxonDisplayLabel } from "@lifer/shared";
import { api, type ApiResponse } from "../api/client";
import { errorMessage } from "../lib/errorMessage";
import i18n from "../i18n";
import { Spinner } from "../components/LoadingScreen";
import PacksMap from "../components/PacksMap";
import { countryBoundariesResource } from "../lib/countryBoundaries";
import RegionPicker from "../components/RegionPicker";
import DownloadedPacksList from "../components/DownloadedPacksList";
import { useAddedSpeciesRows } from "../components/AddedSpeciesList";
import ShowForAWhile from "../components/ShowForAWhile";
import FormMessage from "../components/FormMessage";
import { usePackDownloadJob } from "../hooks/usePackDownloadStatus";
import PackProgress from "../components/PackProgress";
import { useRegions } from "../hooks/useRegions";
import { useSettings } from "../hooks/useSettings";
import { formatBytes } from "../lib/format";
import FreeSpaceNote from "../components/FreeSpaceNote";
import { useConnection, usePackIndex } from "../lib/packIndex";
import ConnectionNote, { ListLoadingNote } from "../components/ConnectionNote";
import { markPackDownloadStarted } from "../lib/packDownloadStore";
import ProvinceManager from "./offlinePacks/ProvinceManager";
import TaxonPicker from "./offlinePacks/TaxonPicker";
import PackVariantControl from "./offlinePacks/PackVariantControl";
import { useOfflinePackSelection } from "./offlinePacks/useOfflinePackSelection";
import { ignore } from "../lib/ignore";
import Panel from "../components/Panel";
import EmptyState from "../components/EmptyState";
import Button from "../components/Button";
import { useTooltip } from "../components/Tooltip";

type Recommendation = ApiResponse<"/offline-packs/recommend", "post">;

// Map, continent pills, country search, and one taxon selection applied across every selected
// country (see useOfflinePackSelection).

// A region pill's look by how much of it is downloaded: solid for all, tinted for some groups,
// plain for none. Selecting adds a ring (or the ink fill when nothing is downloaded yet).
function coveragePillClass(coverage: "full" | "partial" | "none", selected: boolean, idleText: string): string {
  const ring = selected ? " ring-2 ring-accent/40" : "";
  if (coverage === "full") return `border-accent bg-accent text-accent-fg${ring}`;
  if (coverage === "partial") return `border-accent bg-accent/15 text-ink${ring}`;
  return selected ? "border-ink bg-ink text-canvas" : `border-line bg-surface-muted ${idleText} hover:bg-line`;
}

export default function OfflinePacksPage() {
  const { t } = useTranslation();
  const { regions, error: regionsError } = useRegions();
  const { settings } = useSettings();
  const boundaries = countryBoundariesResource.use();
  // On a failure the page still opens, with an empty map and the error above it.
  const countryBoundaries = boundaries.data ?? (boundaries.error ? [] : null);
  const boundariesError = boundaries.error ? errorMessage(boundaries.error, t("offlinePacks.mapLoadFailed")) : null;
  const {
    packs,
    freeBytes,
    indexUnavailable,
    listProgress,
    sizesPending,
    error: packsError,
    refresh: refreshPackIndex,
  } = usePackIndex();
  const connection = useConnection();
  const indexError = packsError ? errorMessage(packsError, t("offlinePacks.indexLoadFailed")) : null;
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  // "Added 3 regions to the queue", after a selection joined a running download.
  const [queuedNote, setQueuedNote] = useState<{ count: number; at: number } | null>(null);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [recommendationError, setRecommendationError] = useState<string | null>(null);
  const [provinceManagerPackId, setProvinceManagerPackId] = useState<string | null>(null);
  // "States", "Regions" or "Provinces", from the country's own admin-1 data on the server.
  const [subdivisionLabel, setSubdivisionLabel] = useState(() => t("offlinePacks.provinces"));
  // Taxon labels follow the naming preference (and cover Other Taxa's raw iconic names).
  const namingStyles = settings?.speciesNamingStyles ?? [];
  const addedRows = useAddedSpeciesRows(namingStyles);
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
    downloadVariant,
    setDownloadVariant,
    openContinentIds,
    openContinents,
    countryCoverage,
    toggleCountry,
  } = selection;

  function refreshPacks() {
    refreshPackIndex().catch(ignore("Couldn't refresh the pack index"));
  }

  useEffect(() => {
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
      .catch((err) => setRecommendationError(errorMessage(err, i18n.t("offlinePacks.recommend.failed"))));
  }, []);

  // The pack index refreshes itself when a download finishes (lib/packIndex.ts).
  const downloadJob = usePackDownloadJob();
  const status = downloadJob.status;

  // A first pack is what makes the Collection page useful, so once it's in, go there.
  const navigate = useNavigate();
  // The finishedAt of the run before the first pack's, so that older run's status isn't taken for it.
  const firstPackAfter = useRef<number | null>(null);
  useEffect(() => {
    const after = firstPackAfter.current;
    if (after === null || !status || status.running || !status.finishedAt || status.finishedAt <= after) return;
    firstPackAfter.current = null;
    if (!status.error && !status.cancelled && (status.result?.packsApplied ?? 0) > 0) navigate("/");
  }, [status, navigate]);

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
      const res = await api.post("/offline-packs/download-batch", {
        regionNames: selection.selectedCountryNames,
        taxa: selectedTaxa.size > 0 ? [...selectedTaxa] : "all",
        variant: downloadVariant,
      });
      if (res.queued != null) setQueuedNote({ count: res.queued, at: Date.now() });
      else firstPackAfter.current = downloadedPacks.length === 0 ? (status?.finishedAt ?? 0) : null;
      selection.clearSelection();
      // A run that ends before the next poll still refreshes the downloaded list.
      markPackDownloadStarted();
      void downloadJob.refresh();
    } catch (err) {
      setStartError(errorMessage(err, t("offlinePacks.downloaded.downloadStartFailed")));
    } finally {
      setStarting(false);
    }
  }

  function cancelDownload(downloadsOnly: boolean) {
    void downloadJob.cancel("/offline-packs/download/cancel", downloadsOnly ? { downloadsOnly } : undefined);
  }

  const downloadedPacks = (packs ?? []).filter((p) => p.downloaded);
  const coverageTitle = (coverage: string) =>
    coverage === "full"
      ? t("offlinePacks.coverage.full")
      : coverage === "partial"
        ? t("offlinePacks.coverage.partial")
        : undefined;

  return (
    // Settings > Species and import > Species downloads (RegionsSettings), inside the settings panel.
    <section className="space-y-section">
      <div>
        <h2 className="text-title-3 font-semibold text-ink">{t("settings.groups.regions")}</h2>
        <p className="mt-1 text-callout text-muted">{t("offlinePacks.intro")}</p>
        {indexUnavailable && connection !== "offline" ? (
          <ListLoadingNote progress={listProgress} className="mt-2" />
        ) : (
          <ConnectionNote state={connection} className="mt-2" />
        )}
      </div>
      <FormMessage error={indexError} />
      <FormMessage error={recommendationError} />
      <FormMessage error={boundariesError} />
      {!regions && !!regionsError && <FormMessage error={t("offlinePacks.regionsLoadFailed")} />}

      {recommendation && (
        <Panel>
          {recommendation.recommended.length === 0 ? (
            <EmptyState compact title={t("offlinePacks.recommend.none")} />
          ) : (
            <>
              <p className="text-callout text-ink">{t("offlinePacks.recommend.intro")}</p>
              <ul className="mt-2 space-y-1 text-callout text-muted">
                {recommendation.recommended.map((p) => (
                  <li key={p.id}>
                    {t("offlinePacks.recommend.covers", {
                      name: p.taxon
                        ? t("offlinePacks.downloaded.nameWithTaxon", {
                            name: p.region ?? p.seaZone,
                            taxon: taxonDisplayLabel(p.taxon, namingStyles),
                          })
                        : (p.region ?? p.seaZone),
                      count: p.covers,
                      size: formatBytes(p.sizeBytes),
                    })}
                  </li>
                ))}
              </ul>
              {recommendation.uncovered.length > 0 && (
                <p className="mt-2 text-footnote text-muted">
                  {t("offlinePacks.recommend.uncovered", { count: recommendation.uncovered.length })}
                </p>
              )}
              <Button
                variant="secondary"
                onClick={() =>
                  selection.selectRegionsByName(
                    recommendation.recommended.map((p) => p.region ?? p.seaZone).filter((n): n is string => !!n),
                  )
                }
                className="mt-3"
              >
                {t("offlinePacks.recommend.select")}
              </Button>
            </>
          )}
        </Panel>
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
            focusBounds={selection.focusBounds}
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
              placeholder: t("offlinePacks.searchPlaceholder"),
            }}
          />

          {openContinents.length > 0 && (
            <Panel className="space-y-item">
              {openContinents.map((continent) => {
                const countries = countriesByContinent.get(continent.id) ?? [];
                return (
                  <div key={continent.id}>
                    <div className="mb-1.5 flex items-center justify-between">
                      {openContinents.length > 1 && (
                        <p className="text-callout font-semibold text-ink">{continent.name}</p>
                      )}
                      <Button
                        variant="link"
                        size="sm"
                        onClick={() => selection.toggleAllCountries(countries)}
                        className="ml-auto"
                      >
                        {countries.length > 0 && countries.every((c) => selectedCountryIds.has(c.id))
                          ? t("offlinePacks.downloaded.deselectAll")
                          : t("offlinePacks.downloaded.selectAll")}
                      </Button>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {countries.map((country) => {
                        const coverage = countryCoverage(country.name);
                        const isSelected = selectedCountryIds.has(country.id);
                        const territories = territoriesByCountryId.get(country.id);
                        return (
                          <div key={country.id} className="contents">
                            <CoveragePill
                              tooltip={coverageTitle(coverage)}
                              buttonRef={(el) => {
                                if (el) countryRowRefs.current.set(country.id, el);
                                else countryRowRefs.current.delete(country.id);
                              }}
                              onClick={() => toggleCountry(country.id)}
                              className={`px-2.5 py-1 ${coveragePillClass(coverage, isSelected, "text-ink")}`}
                            >
                              {country.name}
                            </CoveragePill>
                            {isSelected && territories && territories.length > 0 && (
                              <div className="mt-1 flex w-full flex-wrap items-center gap-1.5 pl-3">
                                <span className="text-footnote text-muted">{t("offlinePacks.territories")}</span>
                                <Button
                                  variant="link"
                                  size="sm"
                                  onClick={() => selection.toggleAllCountries(territories)}
                                >
                                  {territories.every((tr) => selectedCountryIds.has(tr.id))
                                    ? t("offlinePacks.downloaded.deselectAll")
                                    : t("offlinePacks.downloaded.selectAll")}
                                </Button>
                                {territories.map((territory) => {
                                  const territoryCoverage = countryCoverage(territory.name);
                                  const territorySelected = selectedCountryIds.has(territory.id);
                                  return (
                                    <CoveragePill
                                      key={territory.id}
                                      tooltip={coverageTitle(territoryCoverage)}
                                      onClick={() => toggleCountry(territory.id)}
                                      className={`px-2 py-0.5 ${coveragePillClass(territoryCoverage, territorySelected, "text-muted")}`}
                                    >
                                      {territory.name}
                                    </CoveragePill>
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
                      const allOtherSelected = otherTerritories.every((tr) => selectedCountryIds.has(tr.id));
                      return (
                        <div className="mt-2 border-t border-line pt-2">
                          <div className="mb-1.5 flex items-center justify-between">
                            <p className="text-footnote text-muted">{t("offlinePacks.otherTerritories")}</p>
                            <Button
                              variant="link"
                              size="sm"
                              onClick={() => selection.toggleAllCountries(otherTerritories)}
                            >
                              {allOtherSelected
                                ? t("offlinePacks.downloaded.deselectAll")
                                : t("offlinePacks.downloaded.selectAll")}
                            </Button>
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {otherTerritories.map((territory) => {
                              const coverage = countryCoverage(territory.name);
                              const isSelected = selectedCountryIds.has(territory.id);
                              return (
                                <CoveragePill
                                  key={territory.id}
                                  tooltip={coverageTitle(coverage)}
                                  onClick={() => toggleCountry(territory.id)}
                                  className={`px-2.5 py-1 ${coveragePillClass(coverage, isSelected, "text-muted")}`}
                                >
                                  {territory.name}
                                </CoveragePill>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                );
              })}
            </Panel>
          )}

          {selectedCountryIds.size > 0 && <TaxonPicker selection={selection} namingStyles={namingStyles} />}

          {(downloadedPacks.length > 0 || addedRows.length > 0) && (
            <DownloadedPacksList
              packs={packs ?? []}
              addedRows={addedRows}
              onRefresh={refreshPacks}
              showJobProgress={false}
              renderPackExtra={(p) =>
                p.type === "region" ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-expanded={provinceManagerPackId === p.id}
                    onClick={() => setProvinceManagerPackId((open) => (open === p.id ? null : p.id))}
                  >
                    {provinceManagerPackId === p.id ? subdivisionLabel : t("offlinePacks.provinces")}
                  </Button>
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

      {/* Pinned to the bottom of the window, so a download's progress shows where it was started
            from, however far down the list that was. */}
      <Panel className="sticky bottom-4 space-y-3 shadow-sm">
        {status?.running && (
          <PackProgress status={status} onCancel={cancelDownload} cancelling={downloadJob.cancelling} />
        )}
        {status && !status.running && status.finishedAt && (
          <ShowForAWhile key={status.finishedAt} since={status.finishedAt} forMs={15000}>
            {status.error ? (
              <FormMessage error={t("offlinePacks.status.failed", { error: status.error })} />
            ) : (
              <p className="text-callout text-ink">
                {status.cancelled
                  ? t("offlinePacks.status.cancelled", { count: status.processed ?? 0 })
                  : t("offlinePacks.status.done", { count: status.result?.packsApplied ?? status.processed ?? 0 })}
              </p>
            )}
          </ShowForAWhile>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <PackVariantControl value={downloadVariant} onChange={setDownloadVariant} />
          <p className="min-w-0 flex-1 text-callout text-muted">
            {selectedCountryIds.size === 0
              ? t("offlinePacks.selection.none")
              : selectedTaxa.size === 0 && selection.availableTaxaForSelection.length > 0
                ? t("offlinePacks.selection.chooseGroups")
                : sizesPending
                  ? t("offlinePacks.selection.summaryNoSize", {
                      regions: selectedCountryIds.size,
                      groups: selectedTaxa.size,
                    })
                  : t("offlinePacks.selection.summary", {
                      regions: selectedCountryIds.size,
                      groups: selectedTaxa.size,
                      size: formatBytes(selection.selectionSizeBytes),
                    })}
            {selectedCountryIds.size > 0 && !sizesPending && (
              <span className="ml-2 text-footnote">
                {t(downloadVariant === "full" ? "offlinePacks.variant.smallSize" : "offlinePacks.variant.fullSize", {
                  size: formatBytes(selection.otherVariantSizeBytes),
                })}
              </span>
            )}
            {selectedCountryIds.size > 0 && !sizesPending && (
              <FreeSpaceNote needed={selection.selectionSizeBytes} free={freeBytes} />
            )}
          </p>
          {queuedNote && (
            <ShowForAWhile key={queuedNote.at} since={queuedNote.at} forMs={5000}>
              <p role="status" className="text-callout text-ink">
                {t("offlinePacks.selection.queued", { count: queuedNote.count })}
              </p>
            </ShowForAWhile>
          )}
          {startError && <FormMessage error={startError} className="py-1" />}
          {/* While a download runs, the selection joins its queue instead of waiting for it. */}
          <Button
            onClick={startDownload}
            disabled={
              connection === "offline" ||
              selectedCountryIds.size === 0 ||
              starting ||
              (selectedTaxa.size === 0 && selection.availableTaxaForSelection.length > 0)
            }
          >
            {starting
              ? t(status?.running ? "offlinePacks.selection.adding" : "offlinePacks.selection.starting")
              : t(status?.running ? "offlinePacks.selection.addToQueue" : "offlinePacks.selection.download")}
          </Button>
        </div>
      </Panel>
    </section>
  );
}

/** A country or territory toggle, coloured by how much of it is downloaded, which says so on hover. */
function CoveragePill({
  tooltip,
  buttonRef,
  onClick,
  className,
  children,
}: {
  tooltip: string | undefined;
  buttonRef?: (el: HTMLButtonElement | null) => void;
  onClick: () => void;
  className: string;
  children: ReactNode;
}) {
  const tip = useTooltip(tooltip ? { label: tooltip } : undefined);
  const tipRef = tip.props.ref as ((el: HTMLElement | null) => void) | undefined;
  return (
    <>
      {/* raw-control: a toggle coloured by download coverage, which Pill has no look for */}
      <button
        type="button"
        {...tip.props}
        ref={(el) => {
          tipRef?.(el);
          buttonRef?.(el);
        }}
        onClick={onClick}
        className={`rounded-control border text-footnote transition-colors ${className}`}
      >
        {children}
      </button>
      {tip.node}
    </>
  );
}
