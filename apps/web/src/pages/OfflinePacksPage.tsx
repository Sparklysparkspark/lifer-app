import { useEffect, useMemo, useState } from "react";
import type { RegionSummary } from "@lifer/shared";
import { api, ApiError } from "../api/client";
import BackToCollectionLink from "../components/BackToCollectionLink";

interface PackEntry {
  id: string;
  type: "region" | "seaZone";
  region?: string;
  seaZone?: string;
  taxon?: "aves" | "mammalia" | "actinopterygii" | null;
  sizeBytes: number;
  speciesCount: number;
  downloaded: boolean;
}

interface DownloadStatus {
  running: boolean;
  processed: number;
  total: number;
  currentPack: string | null;
  error: string | null;
  finishedAt: number | null;
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

  useEffect(() => {
    api.get<{ regions: RegionSummary[] }>("/regions").then((res) => setRegions(res.regions));
    api
      .get<{ packs: PackEntry[] }>("/offline-packs/index")
      .then((res) => setPacks(res.packs))
      .catch((err) => setIndexError(err instanceof ApiError ? err.message : "Couldn't load available packs"));
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
        if (!p.downloaded) ids.push(p.id);
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
    <div className="min-h-screen bg-stone-50">
      <header className="border-b border-stone-200 bg-white px-6 py-4">
        <BackToCollectionLink className="text-sm text-stone-500 hover:underline" />
        <h1 className="mt-1 text-lg font-semibold text-stone-900">Offline packs</h1>
        <p className="mt-1 text-sm text-stone-500">
          Download reference photos and habitat info for a region so it's usable without an internet connection.
        </p>
      </header>

      <main className="mx-auto max-w-2xl space-y-6 p-6">
        {indexError && <p className="text-sm text-red-600">{indexError}</p>}

        {status?.running && (
          <div className="rounded-xl border border-stone-200 bg-white p-4">
            <p className="text-sm text-stone-700">
              Downloading… {status.processed}/{status.total}
              {status.currentPack ? ` (${status.currentPack})` : ""}
            </p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-stone-100">
              <div
                className="h-full bg-stone-900 transition-all"
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
          <p className="text-stone-500">Loading…</p>
        ) : (
          continents.map((continent) => {
            const countries = (countriesByContinent.get(continent.id) ?? []).filter((c) => packsByRegion.has(c.name));
            if (countries.length === 0) return null;
            const continentPackIds = availablePackIdsUnder(countries.map((c) => c.name));
            const allSelected = continentPackIds.length > 0 && continentPackIds.every((id) => selected.has(id));
            const someSelected = continentPackIds.some((id) => selected.has(id));

            return (
              <section key={continent.id} className="rounded-xl border border-stone-200 bg-white p-4">
                <label className="flex items-center gap-2 text-sm font-semibold text-stone-900">
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
                      <div key={country.id} className="flex flex-wrap items-center gap-3 text-sm text-stone-700">
                        <span className="w-32 shrink-0">{country.name}</span>
                        {(["aves", "mammalia", "actinopterygii"] as const).map((taxon) => {
                          const pack = countryPacks.find((p) => p.taxon === taxon);
                          if (!pack) return <span key={taxon} className="w-28 shrink-0 text-stone-300">—</span>;
                          return (
                            <label key={taxon} className="flex w-28 shrink-0 items-center gap-1.5 text-xs text-stone-600">
                              <input
                                type="checkbox"
                                checked={pack.downloaded || selected.has(pack.id)}
                                disabled={pack.downloaded}
                                onChange={(e) => toggle(pack.id, e.target.checked)}
                              />
                              {TAXON_LABEL[taxon]} ({pack.downloaded ? "✓" : formatBytes(pack.sizeBytes)})
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
          <p className="text-sm text-stone-500">No packs available yet for any region.</p>
        )}

        <div className="sticky bottom-4 flex items-center justify-between rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
          <p className="text-sm text-stone-600">
            {selected.size === 0 ? "Nothing selected" : `${selected.size} pack(s) selected — ${formatBytes(selectedSizeBytes)}`}
          </p>
          <div className="flex items-center gap-3">
            {startError && <span className="text-sm text-red-600">{startError}</span>}
            <button
              onClick={startDownload}
              disabled={selected.size === 0 || starting || status?.running}
              className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {starting ? "Starting…" : "Download selected"}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
