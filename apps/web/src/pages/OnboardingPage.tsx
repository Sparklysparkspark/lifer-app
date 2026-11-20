import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { SPECIES_DOWNLOADS_PATH } from "../lib/speciesDownloads";
import type { LoadProgress, RegionSummary, TaxonClass } from "@lifer/shared";
import { taxonDisplayLabel, TAXON_GROUPS, GROUPED_TAXON_CLASSES } from "@lifer/shared";
import { api } from "../api/client";
import { Logo } from "../components/Logo";
import Button from "../components/Button";
import RegionPicker from "../components/RegionPicker";
import PacksMap from "../components/PacksMap";
import { Spinner } from "../components/LoadingScreen";
import Pill from "../components/Pill";
import FormMessage from "../components/FormMessage";
import JobProgress from "../components/JobProgress";
import { usePackDownloadJob } from "../hooks/usePackDownloadStatus";
import PackProgress from "../components/PackProgress";
import ProgressBar from "../components/ProgressBar";
import SetupTips from "../components/SetupTips";
import { canContinueInBackground, packSetupState } from "../lib/packProgress";
import { timeLeftLabel } from "../lib/timeLeft";
import { useTimeLeft } from "../hooks/useTimeLeft";
import { useDeploymentMode } from "../hooks/useDeploymentMode";
import { useRegions } from "../hooks/useRegions";
import { useSettings } from "../hooks/useSettings";
import i18n from "../i18n";
import { errorMessage } from "../lib/errorMessage";
import { useConnection, usePackIndex } from "../lib/packIndex";
import ConnectionNote from "../components/ConnectionNote";
import { useJobPoll } from "../hooks/useJobPoll";
import type { JobStatus } from "@lifer/shared";
import { tauriInvoke } from "../lib/tauri";
import { availableChoice, availableTaxaByRegion, groupRegions, searchCountries } from "../lib/regionGrouping";
import { countryBoundariesResource } from "../lib/countryBoundaries";
import { ignore } from "../lib/ignore";
import Panel from "../components/Panel";
import { TOUR_STATE } from "../components/Tour";

// Pre-selected animal groups: what most people photograph. Anything else is one click away.

const REIMPORT_URL = "/library/reimport";
const CANCEL_URL = "/offline-packs/download/cancel";

type Step = "regions" | "groups" | "done";
const STEP_NUMBER: Record<Step, number> = { regions: 1, groups: 2, done: 3 };

/** The country this computer's language setting names ("en-CA" is Canada), if any. A bare
 *  language ("es") names none: guessing one would offer Spain to everyone who speaks Spanish. */
function suggestedCountry(regions: RegionSummary[]): RegionSummary | null {
  let code: string | undefined;
  try {
    code = new Intl.Locale(navigator.language).region;
  } catch {
    return null;
  }
  if (!code) return null;
  return regions.find((r) => r.ebirdRegionCode === code && r.hasScopedChecklist) ?? null;
}

// Remembered as the last region (as the collection and import do), so with several countries
// neither opens on an empty region choice.
function rememberLastRegion(id: string) {
  try {
    localStorage.setItem("lifer:lastRegionId", id);
  } catch {
    // Losing this preference is harmless.
  }
}

/** The species list's first load: "Loading…" until its pace is measured, then the time left. */
function CatalogProgress({ progress }: { progress: LoadProgress | null }) {
  const { t } = useTranslation();
  const left = timeLeftLabel(useTimeLeft(progress?.processed ?? null, progress?.total ?? null), t);
  const fraction = progress && progress.total > 0 ? progress.processed / progress.total : null;
  return (
    <Panel className="space-y-2">
      <p className="text-headline font-semibold text-ink">{t("onboarding.regions.catalogLoading")}</p>
      <ProgressBar
        value={fraction}
        determinate={fraction !== null}
        size="xs"
        label={t("onboarding.regions.catalogLoading")}
      />
      {/* Holds its line when the time drops away in the last seconds, so nothing jumps. */}
      <p className="text-callout text-muted tabular-nums">{left ?? "\u00a0"}</p>
    </Panel>
  );
}

function toggled<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

// Shown once, after the library is chosen (desktop) or the account is created (server). Three
// steps, each with a way back: where you photograph, which animals, and what to do first. The
// map and species recognition download by themselves meanwhile, with nothing to show.
export default function OnboardingPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const desktop = useDeploymentMode() === "desktop";
  const [step, setStep] = useState<Step>("regions");
  const [backError, setBackError] = useState<string | null>(null);
  // An earlier Lifer install's library in this folder: its countries and groups, offered back.
  const [existing, setExisting] = useState<{
    found: boolean;
    regions: string[];
    taxa: string[];
    checked: boolean;
  } | null>(null);
  const reimport = useJobPoll<JobStatus<{ imported?: number }>>(
    step === "done" && existing?.found ? "/library/reimport/status" : null,
  );
  // Pointing setup at an existing library means wanting it back: its photos come back by
  // themselves once its regions are in (the finish step), with the usual next steps beside them.
  const reimportStarted = useRef(false);
  const startReimport = reimport.start;
  useEffect(() => {
    if (step !== "done" || !existing?.found || reimportStarted.current) return;
    reimportStarted.current = true;
    void startReimport(REIMPORT_URL, {});
  }, [step, existing, startReimport]);

  const { regions, error: regionsError, refresh: refreshRegions } = useRegions();
  const { settings, error: settingsError, refresh: refreshSettings } = useSettings();
  const [selectedCountryIds, setSelectedCountryIds] = useState<Set<string>>(new Set());
  const [openContinentIds, setOpenContinentIds] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState("");
  const [focusCountryIds, setFocusCountryIds] = useState<string[] | undefined>(undefined);
  const boundariesState = countryBoundariesResource.use();
  // Without the outlines setup still works, from the search and the list.
  const boundaries = boundariesState.data ?? (boundariesState.error ? [] : null);
  const job = usePackDownloadJob();
  const status = job.status;
  // Last run's error is only ours to show once a download was started from this screen.
  const [startedHere, setStartedHere] = useState(false);

  const packIndex = usePackIndex(step !== "done");
  const connection = useConnection();
  const packsError = !packIndex.packs && !!packIndex.error;
  // null until the user touches a group: the defaults stand in until then.
  const [selectedTaxa, setSelectedTaxa] = useState<Set<TaxonClass> | null>(null);
  const [openTaxonGroups, setOpenTaxonGroups] = useState<Set<string>>(new Set());
  const namingStyles = settings?.speciesNamingStyles ?? [];
  const catalogLoading = settings?.catalogLoading ?? null;

  // Setup is for a library with no regions yet. One that has some (an existing folder, or Back
  // from the next page after finishing) goes to the collection, and so does one whose regions
  // are already downloading again from its recovery file (lib/collectionState.ts on the API).
  useEffect(() => {
    let cancelled = false;
    Promise.all([api.get("/offline-packs/index"), api.get("/offline-packs/download/status")])
      .then(([index, download]) => {
        const hasRegions = index.packs.some((p) => p.type === "region" && p.downloaded);
        if (!cancelled && (hasRegions || download.running)) navigate("/", { replace: true });
      })
      .catch(ignore("Couldn't check for downloaded regions"));
    api
      .get("/library/existing")
      .then((res) => {
        if (!cancelled) setExisting(res);
      })
      .catch(ignore("Couldn't check for an existing library"));
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  // A new server loads its catalog in the background after starting (minutes on a NAS), so this
  // step can open before any country exists. Keep checking until they show up.
  const hasCountries = (regions ?? []).some((r) => r.parentId !== null);
  useEffect(() => {
    if (step !== "regions" || hasCountries || catalogLoading === "failed") return;
    if (regions === null && !regionsError) return;
    // Every second while it loads, so its time left is measured from enough readings.
    const timer = setTimeout(
      () => {
        refreshRegions().catch(ignore("Couldn't reload the region list"));
        refreshSettings().catch(ignore("Couldn't reload settings"));
      },
      catalogLoading === "running" ? 1000 : 3000,
    );
    return () => clearTimeout(timer);
  }, [step, regions, regionsError, hasCountries, catalogLoading, refreshRegions, refreshSettings]);

  const { continents, countriesByContinent, territoriesByContinent } = useMemo(
    () => groupRegions(regions ?? []),
    [regions],
  );
  const pickableByContinent = useMemo(() => {
    const map = new Map<string, RegionSummary[]>();
    for (const c of continents) {
      const list = [...(countriesByContinent.get(c.id) ?? []), ...(territoriesByContinent.get(c.id) ?? [])];
      if (list.length > 0) map.set(c.id, list);
    }
    return map;
  }, [continents, countriesByContinent, territoriesByContinent]);
  const countryById = useMemo(() => new Map((regions ?? []).map((r) => [r.id, r])), [regions]);
  const suggestion = useMemo(() => suggestedCountry(regions ?? []), [regions]);
  const taxaByRegion = useMemo(
    () => availableTaxaByRegion(packIndex.packs ?? [], regions ?? []),
    [packIndex.packs, regions],
  );
  const availableTaxa = useMemo(() => {
    const set = new Set<TaxonClass>();
    for (const id of selectedCountryIds) for (const taxon of taxaByRegion[id] ?? []) set.add(taxon);
    return [...set];
  }, [selectedCountryIds, taxaByRegion]);
  // Nothing is chosen until the user clicks, except an existing library's own groups (none listed means it had every group).
  const restoredTaxa = useMemo(() => {
    if (!existing?.found || !existing.checked) return null;
    const had = existing.taxa.length === 0 ? availableTaxa : availableTaxa.filter((t) => existing.taxa.includes(t));
    return had.length > 0 ? new Set(had) : null;
  }, [existing, availableTaxa]);
  // A choice made before Back and other countries only keeps the groups these countries have.
  const taxa = useMemo(
    () => availableChoice(selectedTaxa ?? restoredTaxa ?? new Set<TaxonClass>(), availableTaxa),
    [selectedTaxa, restoredTaxa, availableTaxa],
  );
  const searchResults = useMemo(
    () => searchCountries(regions ?? [], continents, searchTerm),
    [searchTerm, regions, continents],
  );
  // Its countries are chosen once the region list is in; the user can add or remove any.
  const [preselected, setPreselected] = useState(false);
  if (!preselected && existing?.found && regions && existing.regions.length > 0) {
    setPreselected(true);
    const ids = regions.filter((r) => r.hasScopedChecklist && existing.regions.includes(r.name)).map((r) => r.id);
    if (ids.length > 0) {
      setSelectedCountryIds((prev) => new Set([...prev, ...ids]));
      setFocusCountryIds(ids);
    }
  }

  const selectedCountries = [...selectedCountryIds]
    .map((id) => countryById.get(id))
    .filter((c): c is RegionSummary => !!c);

  function toggleCountry(id: string) {
    setSelectedCountryIds((prev) => toggled(prev, id));
  }
  function addCountry(country: RegionSummary) {
    setSelectedCountryIds((prev) => new Set(prev).add(country.id));
    setFocusCountryIds([country.id]);
  }
  function setGroup(group: TaxonClass[], on: boolean) {
    const next = new Set(taxa);
    for (const taxon of group) {
      if (on) next.add(taxon);
      else next.delete(taxon);
    }
    setSelectedTaxa(next);
  }

  const setup = packSetupState(status, startedHere);
  // In once the first pack is set up; the rest carries on, with its progress in the StatusTray.
  if (step === "groups" && setup === "ready") setStep("done");
  const firstCountryId = selectedCountries[0]?.id;
  useEffect(() => {
    if (step === "done" && firstCountryId) rememberLastRegion(firstCountryId);
  }, [step, firstCountryId]);

  async function startDownload() {
    setStartedHere(true);
    const regionNames = selectedCountries.map((c) => c.name);
    await job.start("/offline-packs/download-batch", {
      regionNames,
      taxa: taxa.size > 0 && taxa.size < availableTaxa.length ? [...taxa] : "all",
    });
  }

  // Back from the first step: the desktop app's setup choice (on this Mac, or a server).
  async function backToSetup() {
    setBackError(null);
    const invoke = tauriInvoke();
    if (!invoke) return;
    try {
      const result = (await invoke("return_to_setup")) as { error?: string } | null;
      if (result?.error) setBackError(result.error);
    } catch (err) {
      setBackError(errorMessage(err, t("onboarding.backFailed")));
    }
  }

  const downloading = !!status?.running || job.starting;
  // A new collection opens on a country just downloaded: "All species" is empty until photos come in.
  const firstCountry = firstCountryId ? `/?region=${firstCountryId}` : "/";
  const back =
    step === "groups" ? () => setStep("regions") : step === "regions" && desktop && tauriInvoke() ? backToSetup : null;

  return (
    <div className="page-top min-h-screen bg-canvas px-page pb-16">
      <div className={`mx-auto w-full ${step === "regions" ? "max-w-4xl" : "max-w-2xl"}`}>
        <div className="flex min-h-10 items-center justify-between py-2">
          {back ? (
            <Button variant="ghost" onClick={back} disabled={downloading} className="-ml-3">
              <span aria-hidden="true">‹</span> {t("onboarding.back")}
            </Button>
          ) : (
            <Logo variant="wordmark" className="h-7 w-auto" />
          )}
          <span className="text-callout text-muted">
            {t("onboarding.stepOf", { step: STEP_NUMBER[step], total: 3 })}
          </span>
        </div>
        <FormMessage error={backError} />

        {step === "regions" && (
          <section className="mt-8 space-y-section" aria-labelledby="onboarding-title">
            <div>
              <h1 id="onboarding-title" className="text-large-title font-bold text-ink">
                {t("onboarding.regions.title")}
              </h1>
              <p className="mt-2 max-w-2xl text-title-3 text-muted">{t("onboarding.regions.description")}</p>
            </div>
            {existing?.found && (
              <div role="status" className="rounded-panel border border-accent/40 bg-accent/10 p-panel">
                <p className="text-headline font-semibold text-ink">{t("onboarding.existing.title")}</p>
                <p className="mt-1 text-callout text-muted">
                  {existing.regions.length > 0
                    ? t("onboarding.existing.withRegions")
                    : existing.checked
                      ? t("onboarding.existing.noRegions")
                      : t("onboarding.existing.notChecked")}
                </p>
              </div>
            )}

            {!regions && regionsError ? (
              <FormMessage error={t("onboarding.regions.regionsFailed")} />
            ) : !regions ? (
              <Spinner />
            ) : !hasCountries ? (
              settingsError && !settings ? (
                <Panel className="text-body text-ink">{t("onboarding.regions.catalogUnreachable")}</Panel>
              ) : catalogLoading === "failed" ? (
                <Panel className="text-body text-ink">{t("onboarding.regions.catalogFailed")}</Panel>
              ) : (
                <>
                  <CatalogProgress progress={settings?.catalogProgress ?? null} />
                  <SetupTips />
                </>
              )
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-64 flex-1">
                    <RegionPicker
                      mode="multi"
                      search={{
                        term: searchTerm,
                        onTermChange: setSearchTerm,
                        results: searchResults,
                        onSelectResult: (r) => {
                          addCountry(r as RegionSummary);
                          setSearchTerm("");
                        },
                        placeholder: t("onboarding.regions.searchPlaceholder"),
                      }}
                    />
                  </div>
                  {suggestion && !selectedCountryIds.has(suggestion.id) && (
                    <Button variant="secondary" onClick={() => addCountry(suggestion)}>
                      {t("onboarding.regions.addSuggestion", { name: suggestion.name })}
                    </Button>
                  )}
                </div>

                {boundaries === null ? (
                  <Spinner />
                ) : boundaries.length > 0 ? (
                  <>
                    <PacksMap
                      countries={boundaries}
                      selectedIds={selectedCountryIds}
                      onToggleCountry={toggleCountry}
                      focusCountryIds={focusCountryIds}
                    />
                    <p className="text-callout text-muted">{t("onboarding.regions.mapHint")}</p>
                  </>
                ) : null}

                {selectedCountries.length > 0 && (
                  <div>
                    <h2 className="text-headline font-semibold text-ink">
                      {t("onboarding.regions.chosen", { count: selectedCountries.length })}
                    </h2>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {selectedCountries.map((c) => (
                        <Pill key={c.id} active onClick={() => toggleCountry(c.id)}>
                          {c.name}
                        </Pill>
                      ))}
                    </div>
                  </div>
                )}

                <details className="group rounded-panel border border-line bg-surface">
                  <summary className="cursor-pointer list-none px-panel py-3 text-headline font-medium text-ink">
                    <span className="mr-2 inline-block transition-transform group-open:rotate-90" aria-hidden="true">
                      ›
                    </span>
                    {t("onboarding.regions.browse")}
                  </summary>
                  <div className="space-y-3 px-panel pb-panel">
                    <RegionPicker
                      mode="multi"
                      items={continents.filter((c) => pickableByContinent.has(c.id))}
                      selectedIds={openContinentIds}
                      onToggleItem={(id) => setOpenContinentIds((prev) => toggled(prev, id))}
                    />
                    {continents
                      .filter((c) => openContinentIds.has(c.id))
                      .map((continent) => (
                        <div key={continent.id} className="space-y-1">
                          <p className="text-callout font-semibold text-ink">{continent.name}</p>
                          <RegionPicker
                            mode="multi"
                            items={pickableByContinent.get(continent.id) ?? []}
                            selectedIds={selectedCountryIds}
                            onToggleItem={toggleCountry}
                          />
                        </div>
                      ))}
                  </div>
                </details>

                <div className="flex justify-end">
                  <Button size="lg" disabled={selectedCountryIds.size === 0} onClick={() => setStep("groups")}>
                    {t("onboarding.continue")}
                  </Button>
                </div>
              </>
            )}
          </section>
        )}

        {step === "groups" && (
          <section className="mt-8 space-y-section" aria-labelledby="onboarding-title">
            <div>
              <h1 id="onboarding-title" className="text-large-title font-bold text-ink">
                {downloading ? t("onboarding.setup.title") : t("onboarding.groups.title")}
              </h1>
              <p className="mt-2 text-title-3 text-muted">
                {downloading ? (
                  t("onboarding.setup.description", { country: selectedCountries[0]?.name ?? "" })
                ) : (
                  <>
                    {t("onboarding.groups.description", {
                      regions: new Intl.ListFormat(i18n.language, { type: "conjunction" }).format(
                        selectedCountries.map((c) => c.name),
                      ),
                    })}{" "}
                    {selectedTaxa === null &&
                      (restoredTaxa ? t("onboarding.groups.restored") : t("onboarding.groups.choose"))}
                  </>
                )}
              </p>
            </div>

            {downloading ? (
              <>
                <Panel>
                  <PackProgress
                    status={status}
                    onCancel={(downloadsOnly) =>
                      void job.cancel(CANCEL_URL, downloadsOnly ? { downloadsOnly } : undefined)
                    }
                    cancelling={job.cancelling}
                  />
                </Panel>
                {canContinueInBackground(status) && (
                  <div className="flex justify-end">
                    <Button
                      variant="secondary"
                      onClick={() => {
                        if (firstCountryId) rememberLastRegion(firstCountryId);
                        navigate(firstCountry, { replace: true });
                      }}
                    >
                      {t("onboarding.setup.background")}
                    </Button>
                  </div>
                )}
                <SetupTips />
              </>
            ) : (
              <>
                {availableTaxa.length === 0 ? (
                  packIndex.indexUnavailable ? (
                    <ConnectionNote state={connection === "online" ? "slow" : connection} />
                  ) : (
                    <p className="text-body text-muted">
                      {packsError ? t("onboarding.groups.listFailed") : t("onboarding.groups.loading")}
                    </p>
                  )
                ) : (
                  <div className="space-y-4">
                    <div className="flex flex-wrap gap-2">
                      {availableTaxa
                        .filter((taxon) => !GROUPED_TAXON_CLASSES.has(taxon))
                        .map((taxon) => (
                          <Pill
                            key={taxon}
                            active={taxa.has(taxon)}
                            onClick={() => setSelectedTaxa(toggled(taxa, taxon))}
                          >
                            {taxonDisplayLabel(taxon, namingStyles)}
                          </Pill>
                        ))}
                    </div>
                    {TAXON_GROUPS.map((group) => {
                      const inGroup = group.taxa.filter((taxon) => availableTaxa.includes(taxon));
                      if (inGroup.length === 0) return null;
                      const chosen = inGroup.filter((taxon) => taxa.has(taxon)).length;
                      const isOpen = openTaxonGroups.has(group.key);
                      return (
                        <div key={group.key} className="rounded-panel border border-line bg-surface">
                          <div className="flex items-center justify-between gap-3 px-panel py-3">
                            {/* raw-control: the group's whole header row is its disclosure toggle */}
                            <button
                              type="button"
                              aria-expanded={isOpen}
                              onClick={() => setOpenTaxonGroups((prev) => toggled(prev, group.key))}
                              className="flex flex-1 items-center gap-2 text-left text-headline font-medium text-ink"
                            >
                              <span
                                aria-hidden="true"
                                className={`inline-block transition-transform ${isOpen ? "rotate-90" : ""}`}
                              >
                                ›
                              </span>
                              {group.label}
                              <span className="text-callout font-normal text-muted">
                                {t("onboarding.groups.chosenOf", { chosen, total: inGroup.length })}
                              </span>
                            </button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setGroup(inGroup, chosen < inGroup.length)}
                            >
                              {chosen < inGroup.length
                                ? t("onboarding.groups.addAll")
                                : t("onboarding.groups.removeAll")}
                            </Button>
                          </div>
                          {isOpen && (
                            <div className="flex flex-wrap gap-2 px-panel pb-panel">
                              {inGroup.map((taxon) => (
                                <Pill
                                  key={taxon}
                                  active={taxa.has(taxon)}
                                  onClick={() => setSelectedTaxa(toggled(taxa, taxon))}
                                >
                                  {taxonDisplayLabel(taxon, namingStyles)}
                                </Pill>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                <p className="text-callout text-muted">{t("onboarding.groups.later")}</p>
                <FormMessage error={job.actionError} />
                {setup === "failed" && status?.error && (
                  <FormMessage error={t("onboarding.groups.downloadFailed", { error: status.error })} />
                )}
                <div className="flex items-center justify-end gap-3">
                  {taxa.size === 0 && availableTaxa.length > 0 && (
                    <p className="text-callout text-muted">{t("onboarding.groups.chooseOne")}</p>
                  )}
                  <Button
                    size="lg"
                    onClick={startDownload}
                    loading={job.starting}
                    disabled={connection === "offline" || (taxa.size === 0 && availableTaxa.length > 0)}
                  >
                    {t("onboarding.groups.download", { count: selectedCountryIds.size })}
                  </Button>
                </div>
              </>
            )}
          </section>
        )}

        {step === "done" && (
          <section className="mt-8 space-y-section" aria-labelledby="onboarding-title">
            <div>
              <h1 id="onboarding-title" className="text-large-title font-bold text-ink">
                {t("onboarding.done.title")}
              </h1>
              <p className="mt-2 text-title-3 text-muted">
                {existing?.found ? t("onboarding.done.existingDescription") : t("onboarding.done.description")}
              </p>
            </div>
            {status?.running ? (
              <Panel>
                <PackProgress
                  status={status}
                  onCancel={(downloadsOnly) =>
                    void job.cancel(CANCEL_URL, downloadsOnly ? { downloadsOnly } : undefined)
                  }
                  cancelling={job.cancelling}
                />
              </Panel>
            ) : (
              startedHere &&
              status?.error && <FormMessage error={t("onboarding.groups.downloadFailed", { error: status.error })} />
            )}
            {existing?.found && !reimport.actionError && (
              <Panel>
                {reimport.status?.running || !reimport.status?.finishedAt ? (
                  <JobProgress status={reimport.status} phases={{}} fallbackLabel={t("onboarding.done.bringingBack")} />
                ) : reimport.status.error ? (
                  <FormMessage error={reimport.status.error} />
                ) : (
                  <FormMessage success={t("onboarding.done.broughtBack")} />
                )}
              </Panel>
            )}
            {reimport.actionError && (
              <div className="space-y-2">
                <FormMessage error={reimport.actionError} />
                <Button
                  variant="secondary"
                  loading={reimport.starting}
                  onClick={() => void startReimport(REIMPORT_URL, {})}
                >
                  {t("common.retry")}
                </Button>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button size="lg" onClick={() => navigate(firstCountry, { replace: true })}>
                {t("onboarding.done.collection")}
              </Button>
              <Button size="lg" variant="secondary" onClick={() => navigate("/import", { replace: true })}>
                {existing?.found ? t("onboarding.done.importMore") : t("onboarding.done.import")}
              </Button>
            </div>
            <div className="-ml-3 flex flex-wrap gap-1">
              {/* I-04: a Lightroom Classic catalogue as the first source. */}
              <Button variant="ghost" onClick={() => navigate("/import/lightroom", { replace: true })}>
                {t("onboarding.done.lightroom")}
              </Button>
              <Button variant="ghost" onClick={() => navigate(firstCountry, { replace: true, state: TOUR_STATE })}>
                {t("tour.start")}
              </Button>
            </div>
            <p className="text-callout text-muted">
              <Trans
                i18nKey="onboarding.done.downloadMore"
                components={{ a: <Link to={SPECIES_DOWNLOADS_PATH} className="underline" /> }}
              />
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
