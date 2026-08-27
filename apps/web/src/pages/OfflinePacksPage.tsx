import { useEffect, useMemo, useState } from "react";
import type { RegionSummary } from "@lifer/shared";
import { api, ApiError } from "../api/client";
import { Spinner } from "../components/LoadingScreen";
import BackToCollectionLink from "../components/BackToCollectionLink";
import InfoTip from "../components/InfoTip";

const PACKS_INFO_PARAGRAPHS = [
  '"Update available" means the pack\'s checklist data (which species occur there, and how often) has changed since you downloaded it. Re-downloading refreshes that.',
  "It won't overwrite any reference photo or description a species already has, no matter where that came from. Those are only ever filled in once, never replaced.",
];

interface PackEntry {
  id: string;
  type: "region" | "seaZone";
  region?: string;
  seaZone?: string;
  taxon?: "aves" | "mammalia" | "actinopterygii" | null;
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
  taxon: "aves" | "mammalia" | "actinopterygii" | null;
  sizeBytes: number;
  covers: number;
}

interface Recommendation {
  recommended: RecommendedPack[];
  uncovered: string[];
}

const TAXON_LABEL: Record<string, string> = { aves: "Birds", mammalia: "Mammals", actinopterygii: "Fish" };

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// Lets the user select countries or continents (picking a continent auto-selects all its
// countries, with the option to uncheck some) and download offline map packs. Works
// identically whether Lifer is running locally or on a server — this is just a fetch from
// wherever PACK_INDEX_URL points, nothing server-specific about it.
export default function OfflinePacksPage() {
  const [regions, setRegions] = useState<RegionSummary[] | null>(null);
  const [packs, setPacks] = useState<PackEntry[] | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [status, setStatus] = useState<DownloadStatus | null>(null);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [recommendationError, setRecommendationError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ regions: RegionSummary[] }>("/regions").then((res) => setRegions(res.regions));
    api
      .get<{ packs: PackEntry[] }>("/offline-packs/index")
      .then((res) => setPacks(res.packs))
      .catch((err) => setIndexError(err instanceof ApiError ? err.message : "Couldn't load available packs"));
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

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const res = await api.get<DownloadStatus>("/offline-packs/download/status");
        if (!cancelled) setStatus(res);
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

  const packsByRegion = useMemo(() => {
    const map = new Map<string, PackEntry[]>();
    for (const p of packs ?? []) {
      if (p.type !== "region" || !p.region) continue;
      if (!map.has(p.region)) map.set(p.region, []);
      map.get(p.region)!.push(p);
    }
    return map;
  }, [packs]);

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

  function availablePackIdsUnder(regionNames: string[]): string[] {
    const ids: string[] = [];
    for (const name of regionNames) {
      for (const p of packsByRegion.get(name) ?? []) {
        if (!p.downloaded || p.updateAvailable) ids.push(p.id);
      }
    }
    return ids;
  }

  function toggle(packId: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(packId);
      else next.delete(packId);
      return next;
    });
  }

  function toggleContinent(continentId: string, countries: RegionSummary[]) {
    const ids = availablePackIdsUnder(countries.map((c) => c.name));
    const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  const selectedSizeBytes = (packs ?? []).filter((p) => selected.has(p.id)).reduce((sum, p) => sum + p.sizeBytes, 0);

  async function startDownload() {
    setStartError(null);
    setStarting(true);
    try {
      await api.post("/offline-packs/download", { packIds: [...selected] });
      setSelected(new Set());
    } catch (err) {
      setStartError(err instanceof ApiError ? err.message : "Couldn't start the download");
    } finally {
      setStarting(false);
    }
  }

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

      <main className="mx-auto max-w-2xl space-y-6 p-6">
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
                      {p.region ?? p.seaZone} {p.taxon ? `(${TAXON_LABEL[p.taxon]})` : ""} — covers {p.covers} species,{" "}
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
                  onClick={() => setSelected((prev) => new Set([...prev, ...recommendation.recommended.map((p) => p.id)]))}
                  className="mt-3 rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-surface-muted"
                >
                  Select these packs
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

        {!regions || !packs ? (
          <Spinner />
        ) : (
          continents.map((continent) => {
            const countries = (countriesByContinent.get(continent.id) ?? []).filter((c) => packsByRegion.has(c.name));
            if (countries.length === 0) return null;
            const continentPackIds = availablePackIdsUnder(countries.map((c) => c.name));
            const allSelected = continentPackIds.length > 0 && continentPackIds.every((id) => selected.has(id));
            const someSelected = continentPackIds.some((id) => selected.has(id));

            return (
              <section key={continent.id} className="rounded-xl border border-line bg-surface p-4">
                <label className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = !allSelected && someSelected;
                    }}
                    onChange={() => toggleContinent(continent.id, countries)}
                    disabled={continentPackIds.length === 0}
                  />
                  {continent.name}
                </label>

                <div className="mt-3 space-y-2 pl-6">
                  {countries.map((country) => {
                    const countryPacks = packsByRegion.get(country.name) ?? [];
                    return (
                      <div key={country.id} className="flex flex-wrap items-center gap-3 text-sm text-ink">
                        <span className="w-32 shrink-0">{country.name}</span>
                        {(["aves", "mammalia", "actinopterygii"] as const).map((taxon) => {
                          const pack = countryPacks.find((p) => p.taxon === taxon);
                          if (!pack) return <span key={taxon} className="w-28 shrink-0 text-muted">—</span>;
                          const upToDate = pack.downloaded && !pack.updateAvailable;
                          return (
                            <label key={taxon} className="flex w-28 shrink-0 items-center gap-1.5 text-xs text-muted">
                              <input
                                type="checkbox"
                                checked={upToDate || selected.has(pack.id)}
                                disabled={upToDate}
                                onChange={(e) => toggle(pack.id, e.target.checked)}
                              />
                              {TAXON_LABEL[taxon]} (
                              {upToDate ? "✓" : pack.updateAvailable ? <span className="text-accent">Update available</span> : formatBytes(pack.sizeBytes)}
                              )
                            </label>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })
        )}

        {packs && continents.every((c) => (countriesByContinent.get(c.id) ?? []).every((country) => !packsByRegion.has(country.name))) && (
          <p className="text-sm text-muted">No packs available yet for any region.</p>
        )}

        <div className="sticky bottom-4 flex items-center justify-between rounded-xl border border-line bg-surface p-4 shadow-sm">
          <p className="text-sm text-muted">
            {selected.size === 0 ? "Nothing selected" : `${selected.size} pack(s) selected — ${formatBytes(selectedSizeBytes)}`}
          </p>
          <div className="flex items-center gap-3">
            {startError && <span className="text-sm text-red-600">{startError}</span>}
            <button
              onClick={startDownload}
              disabled={selected.size === 0 || starting || status?.running}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
            >
              {starting ? "Starting…" : "Download selected"}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
