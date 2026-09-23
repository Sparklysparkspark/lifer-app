import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { RegionSummary, TaxonClass } from "@lifer/shared";
import { taxonDisplayLabel } from "@lifer/shared";
import { api, ApiError } from "../api/client";
import { Logo } from "../components/Logo";
import RegionPicker from "../components/RegionPicker";
import { Spinner } from "../components/LoadingScreen";
import Pill from "../components/Pill";
import type { PackEntry } from "../components/DownloadedPacksList";

interface MapStatus {
  available: boolean;
  downloaded: boolean;
  downloading: boolean;
  downloadedBytes: number;
  totalBytes: number | null;
  error: string | null;
}

interface DownloadStatus {
  running: boolean;
  processed: number;
  total: number;
  currentPack: string | null;
  error: string | null;
  finishedAt: number | null;
}

// Shown exactly once, right after account creation (see LoginPage.tsx's handleSubmit —
// this is the only place that ever navigates here), before the user ever sees Collection.
// Two mandatory steps, no "decide later" option on the second one: a brand-new account's
// Collection page is completely empty without at least one downloaded region pack, so sending
// someone there first (with a "go find Offline Packs yourself" expectation) is a worse first
// run than just making pack selection the last step of setup itself. The map step (Step A) IS
// skippable — see MapSection's own comment on why it's the one genuinely optional download here.
export default function OnboardingPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<"map" | "pack" | "guide">("map");

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
      setStep("pack");
      return;
    }
    setStartingMap(true);
    try {
      await api.post("/settings/map/download");
      const res = await api.get<MapStatus>("/settings/map/status");
      setMapStatus(res);
    } catch {
      // Best-effort — a failed map download here isn't worth blocking setup over; Settings
      // still offers this same download later.
      setStep("pack");
    } finally {
      setStartingMap(false);
    }
  }

  useEffect(() => {
    if (mapStatus && !mapStatus.downloading && startingMap === false && mapStatus.downloaded) setStep("pack");
  }, [mapStatus, startingMap]);

  // --- Step B: mandatory first region pack ---
  const [regions, setRegions] = useState<RegionSummary[] | null>(null);
  const [selectedCountryIds, setSelectedCountryIds] = useState<Set<string>>(new Set());
  const [openContinentIds, setOpenContinentIds] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState("");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [status, setStatus] = useState<DownloadStatus | null>(null);

  // Which taxon groups (birds, mammals, reptiles, etc.) to include for the region(s) picked
  // above — same idea as Offline Packs' own picker, kept to a flat pill list here (no nested
  // disclosure groups) since this is a one-time setup step, not the full management screen.
  // Empty selection means "all taxa," same convention download-batch's own `taxa: "all"` uses.
  const [packs, setPacks] = useState<PackEntry[] | null>(null);
  const [selectedTaxa, setSelectedTaxa] = useState<Set<TaxonClass>>(new Set());
  const [namingStyles, setNamingStyles] = useState<string[]>([]);

  useEffect(() => {
    if (step !== "pack") return;
    api.get<{ regions: RegionSummary[] }>("/regions").then((res) => setRegions(res.regions));
    api.get<{ packs: PackEntry[] }>("/offline-packs/index").then((res) => setPacks(res.packs));
    api.get<{ speciesNamingStyles: string[] }>("/settings").then((res) => setNamingStyles(res.speciesNamingStyles));
  }, [step]);

  useEffect(() => {
    if (step !== "pack") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const res = await api.get<DownloadStatus>("/offline-packs/download/status");
        if (!cancelled) setStatus(res);
      } catch {
        // Transient — try again next tick.
      }
      if (!cancelled) timer = setTimeout(poll, 2000);
    }
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [step]);

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
  // Same "read taxa off the pack catalog, not local region_species" reasoning as Offline Packs'
  // own availableTaxaByRegion — the catalog already lists every published region×taxon
  // combination regardless of what (if anything) is downloaded locally yet.
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
    return [...set].sort((a, b) => taxonDisplayLabel(a, namingStyles).localeCompare(taxonDisplayLabel(b, namingStyles)));
  }, [selectedCountryIds, availableTaxaByRegion, namingStyles]);
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

  const alreadySucceeded = status && !status.running && status.finishedAt != null && !status.error && status.processed > 0;

  async function startDownload() {
    setStartError(null);
    setStarting(true);
    try {
      const regionNames = [...selectedCountryIds].map((id) => countryById.get(id)?.name).filter((n): n is string => !!n);
      await api.post("/offline-packs/download-batch", {
        regionNames,
        taxa: selectedTaxa.size > 0 ? [...selectedTaxa] : "all",
      });
    } catch (err) {
      setStartError(err instanceof ApiError ? err.message : "Couldn't start the download");
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-lg space-y-6 rounded-xl border border-line bg-surface p-8 shadow-sm">
        <Logo variant="wordmark" className="h-8 w-auto" />

        {step === "map" && (
          <>
            <div>
              <h2 className="text-lg font-semibold text-ink">Offline map</h2>
              <p className="mt-1 text-sm text-muted">
                An offline basemap (~550MB): this is what makes locality info work on species detail pages, showing roughly where
                within a downloaded region each species is found. Skip this and download it later from Settings if you'd rather save the
                space.
              </p>
            </div>
            {startingMap || mapStatus?.downloading ? (
              <p className="flex items-center gap-2 text-sm text-muted">
                <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-accent/40 border-t-accent" />
                Downloading…
                {mapStatus?.downloadedBytes ? ` ${(mapStatus.downloadedBytes / 1e6).toFixed(0)}MB` : ""}
                {mapStatus?.totalBytes ? ` of ${(mapStatus.totalBytes / 1e6).toFixed(0)}MB` : ""}
              </p>
            ) : (
              <label className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" checked={wantMap} onChange={(e) => setWantMap(e.target.checked)} />
                Download the offline map (recommended)
              </label>
            )}
            {mapStatus?.error && !mapStatus.downloading && (
              <p className="text-sm text-red-600">Couldn't download the map: {mapStatus.error}. You can retry or continue without it.</p>
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

        {step === "pack" && (
          <>
            <div>
              <h2 className="text-lg font-semibold text-ink">Download a region</h2>
              <p className="mt-1 text-sm text-muted">
                Pick at least one country to build your species checklist for. Lifer needs at least one downloaded region before
                there's anything to collect. You can add or remove regions anytime later from Offline Packs.
              </p>
            </div>

            {!regions ? (
              <Spinner />
            ) : alreadySucceeded ? (
              <>
                <p className="text-sm text-green-700">Downloaded, {status!.processed} pack(s) applied.</p>
                <button
                  type="button"
                  onClick={() => setStep("guide")}
                  className="w-full rounded-md bg-accent py-2 text-sm font-medium text-accent-fg"
                >
                  Continue to Lifer
                </button>
              </>
            ) : status?.running ? (
              <div className="rounded-xl border border-line bg-surface-muted p-4">
                <p className="text-sm text-ink">
                  Downloading… {status.processed}/{status.total}
                  {status.currentPack ? ` (${status.currentPack})` : ""}
                </p>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-canvas">
                  <div
                    className="h-full bg-accent transition-all"
                    style={{ width: `${status.total ? Math.round((status.processed / status.total) * 100) : 0}%` }}
                  />
                </div>
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
                  <div className="rounded-lg border border-line bg-surface-muted p-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-semibold text-ink">Taxon groups</p>
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
                    <p className="mt-0.5 text-xs text-muted">
                      Leave none checked for everything (birds, mammals, reptiles, and every other group) — you can add or
                      drop specific groups anytime later from Offline Packs.
                    </p>
                    {availableTaxaForSelection.length === 0 ? (
                      <p className="mt-2 text-xs text-muted">No taxon data available yet for the selected region(s).</p>
                    ) : (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {availableTaxaForSelection.map((taxon) => (
                          <Pill key={taxon} size="sm" active={selectedTaxa.has(taxon)} onClick={() => toggleTaxon(taxon)}>
                            {taxonDisplayLabel(taxon, namingStyles)}
                          </Pill>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {startError && <p className="text-sm text-red-600">{startError}</p>}
                {status?.error && <p className="text-sm text-red-600">Download failed: {status.error}</p>}
                <button
                  type="button"
                  onClick={startDownload}
                  disabled={selectedCountryIds.size === 0 || starting}
                  className="w-full rounded-md bg-accent py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
                >
                  {starting
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
              onClick={() => navigate("/guide", { replace: true })}
              className="w-full rounded-md bg-accent py-2 text-sm font-medium text-accent-fg"
            >
              Open Getting Started Guide
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
