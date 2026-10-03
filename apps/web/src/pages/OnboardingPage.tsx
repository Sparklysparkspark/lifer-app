import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { RegionSummary, TaxonClass } from "@lifer/shared";
import { taxonDisplayLabel, TAXON_GROUPS, GROUPED_TAXON_CLASSES } from "@lifer/shared";
import { api } from "../api/client";
import { Logo } from "../components/Logo";
import RegionPicker from "../components/RegionPicker";
import { Spinner } from "../components/LoadingScreen";
import Pill from "../components/Pill";
import FormMessage from "../components/FormMessage";
import JobProgress, { type JobProgressStatus } from "../components/JobProgress";
import type { PackEntry } from "../components/DownloadedPacksList";
import { PACK_DOWNLOAD_PHASES, packProgressDetail, usePackDownloadJob } from "../hooks/usePackDownloadStatus";
import { useRegions } from "../hooks/useRegions";
import { useSettings } from "../hooks/useSettings";
import { errorMessage } from "../lib/errorMessage";
import { pluralize } from "../lib/pluralize";

interface MapStatus {
  available: boolean;
  downloaded: boolean;
  downloading: boolean;
  downloadedBytes: number;
  totalBytes: number | null;
  error: string | null;
}

const MAP_PHASES = { downloading: { label: "Downloading the map", progress: "bytes" as const } };

// A brand-new server may still be loading its catalog: the downloaded pack waits in "preparing".
const PACK_PHASES = { ...PACK_DOWNLOAD_PHASES, preparing: { label: "Finishing setup", progress: "none" as const } };

// Shown once, right after account creation. The region pack step can't be skipped: Collection
// is empty without one. The map and species matching steps are optional.
export default function OnboardingPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<"map" | "matching" | "pack" | "guide">("map");

  // --- Step A: optional offline map ---
  const [wantMap, setWantMap] = useState(true);
  const [mapStatus, setMapStatus] = useState<MapStatus | null>(null);
  const [startingMap, setStartingMap] = useState(false);

  useEffect(() => {
    if (step !== "map") return;
    api
      .get<MapStatus>("/settings/map/status")
      .then(setMapStatus)
      .catch(() => setMapStatus(null));
  }, [step]);

  useEffect(() => {
    if (!mapStatus?.downloading) return;
    const timer = setTimeout(() => {
      api
        .get<MapStatus>("/settings/map/status")
        .then(setMapStatus)
        .catch(() => {});
    }, 1000);
    return () => clearTimeout(timer);
  }, [mapStatus]);

  async function continueFromMapStep() {
    if (!wantMap || !mapStatus?.available || mapStatus.downloaded) {
      setStep("matching");
      return;
    }
    setStartingMap(true);
    try {
      await api.post("/settings/map/download");
      const res = await api.get<MapStatus>("/settings/map/status");
      setMapStatus(res);
    } catch {
      // Best effort: Settings offers the same download later.
      setStep("matching");
    } finally {
      setStartingMap(false);
    }
  }

  useEffect(() => {
    if (step === "map" && mapStatus && !mapStatus.downloading && startingMap === false && mapStatus.downloaded) setStep("matching");
  }, [step, mapStatus, startingMap]);

  // --- Step A2: species matching (optional) ---
  // Offered here since the model download otherwise hides in Settings. It runs server-side, so setup moves on.
  const [modelStatus, setModelStatus] = useState<{ downloaded: boolean; running: boolean } | null>(null);
  const [startingModel, setStartingModel] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);

  useEffect(() => {
    if (step !== "matching") return;
    api
      .get<{ downloaded: boolean; running: boolean }>("/settings/embedding-model/status")
      .then((res) => {
        if (res.downloaded || res.running) setStep("pack");
        else setModelStatus(res);
      })
      .catch(() => setStep("pack")); // no way to check: don't hold up setup over an optional step
  }, [step]);

  async function enableSpeciesMatching() {
    setStartingModel(true);
    setModelError(null);
    try {
      await api.post("/settings/embedding-model/download");
      setStep("pack");
    } catch (err) {
      setModelError(errorMessage(err, "Couldn't start the download"));
    } finally {
      setStartingModel(false);
    }
  }

  // --- Step B: mandatory first region pack ---
  const { regions, error: regionsError, refresh: refreshRegions } = useRegions();
  const { settings, error: settingsError, refresh: refreshSettings } = useSettings();
  const [selectedCountryIds, setSelectedCountryIds] = useState<Set<string>>(new Set());
  const [openContinentIds, setOpenContinentIds] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState("");
  const job = usePackDownloadJob();
  const status = job.status;
  // Last run's error is only ours to show once a download was started from this screen.
  const [startedHere, setStartedHere] = useState(false);

  // Taxon picker for the chosen regions, the same one Offline Packs uses. Empty means all taxa.
  const [packs, setPacks] = useState<PackEntry[] | null>(null);
  const [packsError, setPacksError] = useState(false);
  const [selectedTaxa, setSelectedTaxa] = useState<Set<TaxonClass>>(new Set());
  const [openTaxonGroups, setOpenTaxonGroups] = useState<Set<string>>(new Set());
  const namingStyles = settings?.speciesNamingStyles ?? [];
  const catalogLoading = settings?.catalogLoading ?? null;

  useEffect(() => {
    if (step !== "pack") return;
    setPacksError(false);
    api
      .get<{ packs: PackEntry[] }>("/offline-packs/index")
      .then((res) => setPacks(res.packs))
      .catch(() => {
        setPacks([]);
        setPacksError(true);
      });
  }, [step]);

  // A new server loads its catalog in the background after starting (minutes on a NAS), so this
  // step can open before any country exists. Keep checking until they show up.
  const hasCountries = (regions ?? []).some((r) => r.parentId !== null);
  useEffect(() => {
    if (step !== "pack" || hasCountries || catalogLoading === "failed") return;
    if (regions === null && !regionsError) return;
    const timer = setTimeout(() => {
      refreshRegions().catch(() => {});
      refreshSettings().catch(() => {});
    }, 3000);
    return () => clearTimeout(timer);
  }, [step, regions, regionsError, hasCountries, catalogLoading, refreshRegions, refreshSettings]);

  const world = useMemo(() => (regions ?? []).find((r) => r.parentId === null && r.name === "World"), [regions]);
  const continents = useMemo(() => (regions ?? []).filter((r) => r.parentId === world?.id), [regions, world]);
  const countriesByContinent = useMemo(() => {
    const map = new Map<string, RegionSummary[]>();
    for (const r of regions ?? []) {
      if (!r.parentId || !continents.some((c) => c.id === r.parentId)) continue;
      if (!map.has(r.parentId)) map.set(r.parentId, []);
      map.get(r.parentId)!.push(r);
    }
    return map;
  }, [regions, continents]);
  const countryById = useMemo(() => new Map((regions ?? []).map((r) => [r.id, r])), [regions]);
  // From the pack catalog, which lists every published region and taxon whether downloaded or not.
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
  const availableTaxaForSelection = useMemo(() => {
    const set = new Set<TaxonClass>();
    for (const id of selectedCountryIds) for (const t of availableTaxaByRegion[id] ?? []) set.add(t);
    return [...set];
  }, [selectedCountryIds, availableTaxaByRegion]);
  function toggleTaxon(taxon: TaxonClass) {
    setSelectedTaxa((prev) => {
      const next = new Set(prev);
      if (next.has(taxon)) next.delete(taxon);
      else next.add(taxon);
      return next;
    });
  }
  const searchResults = useMemo(() => {
    if (searchTerm.trim().length < 2) return [];
    const term = searchTerm.trim().toLowerCase();
    const continentIds = new Set(continents.map((c) => c.id));
    return (regions ?? []).filter((r) => r.parentId && continentIds.has(r.parentId) && r.name.toLowerCase().includes(term)).slice(0, 8);
  }, [searchTerm, regions, continents]);

  const packsApplied = status?.processed ?? 0;
  const alreadySucceeded = !!status && !status.running && status.finishedAt != null && !status.error && packsApplied > 0;

  async function startDownload() {
    setStartedHere(true);
    const regionNames = [...selectedCountryIds].map((id) => countryById.get(id)?.name).filter((n): n is string => !!n);
    await job.start("/offline-packs/download-batch", {
      regionNames,
      taxa: selectedTaxa.size > 0 ? [...selectedTaxa] : "all",
    });
  }

  // The map download reports its own status shape; JobProgress takes a hand-built one.
  const mapJob: JobProgressStatus = {
    running: startingMap || !!mapStatus?.downloading,
    phase: mapStatus?.downloading ? "downloading" : null,
    downloadedBytes: mapStatus?.downloadedBytes || null,
    totalBytes: mapStatus?.totalBytes ?? null,
    processed: null,
    total: null,
    currentItem: null,
    error: null,
    cancelRequested: false,
    cancelled: false,
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-lg space-y-6 rounded-xl border border-line bg-surface p-8 shadow-sm">
        <Logo variant="wordmark" className="h-8 w-auto" />

        {step === "map" && (
          <>
            <div>
              <h2 className="text-lg font-semibold text-ink">Offline map</h2>
              <p className="mt-1 text-sm text-muted">
                An offline basemap (~550 MB): this is what makes locality info work on species detail pages, showing roughly where
                within a downloaded region each species is found. Skip this and download it later from Settings if you'd rather save the
                space.
              </p>
            </div>
            {startingMap || mapStatus?.downloading ? (
              <JobProgress
                status={mapJob}
                phases={MAP_PHASES}
                fallbackLabel="Starting the map download…"
              />
            ) : (
              <label className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" checked={wantMap} onChange={(e) => setWantMap(e.target.checked)} />
                Download the offline map (recommended)
              </label>
            )}
            {mapStatus?.error && !mapStatus.downloading && (
              <FormMessage error={`Couldn't download the map: ${mapStatus.error}. You can retry or continue without it.`} />
            )}
            <button
              type="button"
              onClick={continueFromMapStep}
              disabled={startingMap || !!mapStatus?.downloading}
              className="w-full rounded-md bg-accent py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
            >
              Continue
            </button>
          </>
        )}

        {step === "matching" && modelStatus && (
          <>
            <div>
              <h2 className="text-lg font-semibold text-ink">Species matching</h2>
              <p className="mt-1 text-sm text-muted">
                When you import photos, Lifer can suggest which species each one shows, using models that run entirely on your
                device, so your photos never leave it. It needs a one-time download of about 620MB, which carries on in the background
                while you finish setting up. You can turn this on or off later in Settings.
              </p>
            </div>
            <FormMessage error={modelError ? `${modelError}. You can try again or skip this for now.` : null} />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setStep("pack")}
                disabled={startingModel}
                className="flex-1 rounded-md border border-line py-2 text-sm font-medium text-ink hover:bg-surface-muted disabled:opacity-50"
              >
                Not now
              </button>
              <button
                type="button"
                onClick={enableSpeciesMatching}
                disabled={startingModel}
                className="flex-1 rounded-md bg-accent py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
              >
                {startingModel ? "Starting…" : "Enable species matching"}
              </button>
            </div>
          </>
        )}

        {step === "pack" && (
          <>
            <div>
              <h2 className="text-lg font-semibold text-ink">Download a region</h2>
              <p className="mt-1 text-sm text-muted">
                Pick at least one country to build your species checklist for. Lifer needs at least one downloaded region before
                there's anything to collect. You can add or remove regions anytime later from Offline Packs.
              </p>
            </div>

            {!regions && regionsError ? (
              <FormMessage error="Couldn't load the region list. Retrying…" />
            ) : !regions ? (
              <Spinner />
            ) : alreadySucceeded ? (
              <>
                <FormMessage success={`Downloaded, ${pluralize(packsApplied, "pack")} applied.`} />
                <button
                  type="button"
                  onClick={() => setStep("guide")}
                  className="w-full rounded-md bg-accent py-2 text-sm font-medium text-accent-fg"
                >
                  Continue to Lifer
                </button>
              </>
            ) : status?.running ? (
              <div className="rounded-xl border border-line bg-surface p-4">
                <JobProgress
                  status={status}
                  phases={PACK_PHASES}
                  fallbackLabel="Downloading…"
                  detail={
                    status.phase === "preparing"
                      ? "This only happens the first time and can take a few minutes."
                      : packProgressDetail(status)
                  }
                />
              </div>
            ) : !hasCountries ? (
              <div className="rounded-xl border border-line bg-surface p-4 text-sm text-ink">
                {settingsError && !settings ? (
                  <p>Couldn't reach the server to check on the species catalog. Retrying…</p>
                ) : catalogLoading === "failed" ? (
                  <p>
                    Lifer couldn't load its species catalog. Restart the server to try again, and check its logs if
                    this keeps happening.
                  </p>
                ) : (
                  <p>
                    Lifer is loading its species catalog for the first time. This only happens once and can take a
                    few minutes. Countries will appear here as soon as it's done.
                  </p>
                )}
              </div>
            ) : (
              <>
                <RegionPicker
                  mode="multi"
                  search={{ term: searchTerm, onTermChange: setSearchTerm, results: searchResults, onSelectResult: (r) => {
                    setSelectedCountryIds((prev) => new Set(prev).add(r.id));
                    setSearchTerm("");
                    const continentId = (r as RegionSummary).parentId;
                    if (continentId) setOpenContinentIds((prev) => new Set(prev).add(continentId));
                  }, placeholder: "Search for a country…" }}
                />
                <RegionPicker
                  mode="multi"
                  items={continents}
                  selectedIds={openContinentIds}
                  onToggleItem={(id) =>
                    setOpenContinentIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    })
                  }
                />
                {continents
                  .filter((c) => openContinentIds.has(c.id))
                  .map((continent) => (
                    <div key={continent.id} className="space-y-1">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{continent.name}</p>
                      <RegionPicker
                        mode="multi"
                        items={countriesByContinent.get(continent.id) ?? []}
                        selectedIds={selectedCountryIds}
                        onToggleItem={(id) =>
                          setSelectedCountryIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(id)) next.delete(id);
                            else next.add(id);
                            return next;
                          })
                        }
                      />
                    </div>
                  ))}
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
                          {packsError
                            ? "Couldn't load the pack list. All taxa will be downloaded."
                            : `No taxon data available yet for the selected ${selectedCountryIds.size === 1 ? "region" : "regions"}.`}
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
                    {/* A group is only a disclosure: opening it never selects anything. */}
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
                <FormMessage error={job.actionError} />
                {startedHere && status?.error && <FormMessage error={`Download failed: ${status.error}`} />}
                <button
                  type="button"
                  onClick={startDownload}
                  disabled={selectedCountryIds.size === 0 || job.starting}
                  className="w-full rounded-md bg-accent py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
                >
                  {job.starting
                    ? "Starting…"
                    : `Download ${selectedCountryIds.size || ""} region${selectedCountryIds.size === 1 ? "" : "s"}${
                        selectedTaxa.size > 0 ? ` (${selectedTaxa.size} group${selectedTaxa.size === 1 ? "" : "s"})` : ""
                      }`}
                </button>
              </>
            )}
          </>
        )}

        {step === "guide" && (
          <>
            <div>
              <h2 className="text-lg font-semibold text-ink">You're all set</h2>
              <p className="mt-1 text-sm text-muted">
                Take a couple minutes to see how uploading, bulk import, and trips fit together, or jump straight in and
                figure it out as you go. You can always open this later from Settings.
              </p>
            </div>
            <button
              type="button"
              // Not replace: the guide's back link uses real history and should return here.
              onClick={() => navigate("/guide", { state: { backLabel: "Setup" } })}
              className="w-full rounded-md bg-accent py-2 text-sm font-medium text-accent-fg"
            >
              Open the getting started guide
            </button>
            <button
              type="button"
              onClick={() => navigate("/", { replace: true })}
              className="w-full rounded-md border border-line py-2 text-sm text-ink hover:bg-surface-muted"
            >
              Skip
            </button>
          </>
        )}
      </div>
    </div>
  );
}
