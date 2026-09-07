import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import PageHeader from "../components/PageHeader";
import { Spinner } from "../components/LoadingScreen";

interface ImportCluster {
  speciesId: string;
  commonName: string | null;
  scientificName: string;
  earliestTakenAt: string | null;
  latestTakenAt: string | null;
  captures: Array<{ id: string; currentPhotoId: string | null }>;
}

interface ObservationSummary {
  observationId: string;
  scientificName: string;
  commonName: string | null;
  currentPhotoId: string | null;
  createdAt: string;
  confirmedAt: string | null;
  url: string;
  editUrl: string;
}

type Tab = "import" | "pending" | "completed";

function speciesLabel(commonName: string | null, scientificName: string): string {
  return commonName ?? scientificName;
}

function formatDateRange(start: string | null, end: string | null): string {
  if (!start) return "Date unknown";
  const startDate = new Date(start).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  if (!end || end === start) return startDate;
  const endDate = new Date(end).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return startDate === endDate ? startDate : `${startDate} – ${endDate}`;
}

// Three sub-views kept off the main nav (reached only via Settings) so this doesn't clutter
// the everyday UI for anyone not using it: species/photo clusters still waiting to be sent,
// ones sent but not yet confirmed as finished on iNaturalist's own site, and a log of what's
// been fully contributed. See ~/.claude/plans/inaturalist-sync.md.
export default function InaturalistPage() {
  const [tab, setTab] = useState<Tab>("import");

  return (
    <div className="min-h-screen bg-canvas">
      <PageHeader title="iNaturalist" backFallbackTo="/settings" backLabel="Settings">
        <p className="mt-1 text-sm text-muted">Send your sightings to iNaturalist as draft observations, then finish them there.</p>
        <div className="mt-4 flex gap-2">
          {(["import", "pending", "completed"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded-md px-3 py-1.5 text-sm capitalize ${
                tab === t ? "bg-ink text-canvas" : "border border-line text-ink hover:bg-surface-muted"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </PageHeader>
      <main className="mx-auto max-w-3xl space-y-4 p-6">
        {tab === "import" && <ImportTab />}
        {tab === "pending" && <PendingTab />}
        {tab === "completed" && <CompletedTab />}
      </main>
    </div>
  );
}

function ImportTab() {
  const [clusters, setClusters] = useState<ImportCluster[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<Record<string, Set<string>>>({});

  function load() {
    api
      .get<{ clusters: ImportCluster[] }>("/inaturalist/import")
      .then((r) => setClusters(r.clusters))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load your library"));
  }
  useEffect(load, []);

  function clusterKey(cluster: ImportCluster): string {
    return cluster.captures.map((c) => c.id).join(",");
  }

  function toggleExcluded(key: string, captureId: string) {
    setExcluded((prev) => {
      const set = new Set(prev[key] ?? []);
      if (set.has(captureId)) set.delete(captureId);
      else set.add(captureId);
      return { ...prev, [key]: set };
    });
  }

  async function createObservation(cluster: ImportCluster) {
    const key = clusterKey(cluster);
    const excludedIds = excluded[key] ?? new Set<string>();
    const captureIds = cluster.captures.map((c) => c.id).filter((id) => !excludedIds.has(id));
    if (captureIds.length === 0) return;
    setSubmitting(key);
    setError(null);
    try {
      await api.post("/inaturalist/observations", { captureIds });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create the observation");
    } finally {
      setSubmitting(null);
    }
  }

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!clusters) return <Spinner />;
  if (clusters.length === 0) return <p className="text-sm text-muted">Nothing waiting to be sent. Every sighting has already been submitted.</p>;

  return (
    <div className="space-y-4">
      {clusters.map((cluster) => {
        const key = clusterKey(cluster);
        const excludedIds = excluded[key] ?? new Set<string>();
        return (
          <div key={key} className="rounded-xl border border-line bg-surface p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-ink">{speciesLabel(cluster.commonName, cluster.scientificName)}</p>
                <p className="text-xs text-muted">
                  {cluster.captures.length} photo{cluster.captures.length === 1 ? "" : "s"} · {formatDateRange(cluster.earliestTakenAt, cluster.latestTakenAt)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => createObservation(cluster)}
                disabled={submitting === key || excludedIds.size === cluster.captures.length}
                className="rounded-md bg-ink px-3 py-1.5 text-sm text-canvas disabled:opacity-50"
              >
                {submitting === key ? "Creating…" : "Create Observation"}
              </button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {cluster.captures.map((capture) => (
                <label key={capture.id} className="relative">
                  <input
                    type="checkbox"
                    checked={!excludedIds.has(capture.id)}
                    onChange={() => toggleExcluded(key, capture.id)}
                    className="absolute right-1 top-1 h-4 w-4"
                  />
                  {capture.currentPhotoId ? (
                    <img
                      src={`/api/photos/${capture.currentPhotoId}/thumb`}
                      alt=""
                      className={`h-20 w-20 rounded-md object-cover ${excludedIds.has(capture.id) ? "opacity-30" : ""}`}
                    />
                  ) : (
                    <div className="h-20 w-20 rounded-md bg-surface-muted" />
                  )}
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PendingTab() {
  const [observations, setObservations] = useState<ObservationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [message, setMessage] = useState<Record<string, string>>({});

  function load() {
    api
      .get<{ observations: ObservationSummary[] }>("/inaturalist/pending")
      .then((r) => setObservations(r.observations))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load pending observations"));
  }
  useEffect(load, []);

  async function confirm(observationId: string) {
    setConfirming(observationId);
    setError(null);
    try {
      const result = await api.post<{ confirmed: boolean; message?: string }>(`/inaturalist/observations/${observationId}/confirm`);
      if (result.confirmed) load();
      else setMessage((prev) => ({ ...prev, [observationId]: result.message ?? "Not yet confirmed." }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't check this observation");
    } finally {
      setConfirming(null);
    }
  }

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!observations) return <Spinner />;
  if (observations.length === 0) return <p className="text-sm text-muted">Nothing pending. Every observation you've sent has been confirmed complete.</p>;

  return (
    <div className="space-y-3">
      {observations.map((obs) => (
        <div key={obs.observationId} className="rounded-xl border border-line bg-surface p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              {obs.currentPhotoId ? (
                <img src={`/api/photos/${obs.currentPhotoId}/thumb`} alt="" className="h-14 w-14 rounded-md object-cover" />
              ) : (
                <div className="h-14 w-14 rounded-md bg-surface-muted" />
              )}
              <div>
                <p className="text-sm font-medium text-ink">{speciesLabel(obs.commonName, obs.scientificName)}</p>
                <a href={obs.editUrl} target="_blank" rel="noreferrer" className="text-xs text-muted hover:underline">
                  Finish on iNaturalist
                </a>
              </div>
            </div>
            <button
              type="button"
              onClick={() => confirm(obs.observationId)}
              disabled={confirming === obs.observationId}
              className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-surface-muted disabled:opacity-50"
            >
              {confirming === obs.observationId ? "Checking…" : "Confirm Complete"}
            </button>
          </div>
          {message[obs.observationId] && <p className="mt-2 text-xs text-muted">{message[obs.observationId]}</p>}
        </div>
      ))}
    </div>
  );
}

function CompletedTab() {
  const [observations, setObservations] = useState<ObservationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ observations: ObservationSummary[] }>("/inaturalist/completed")
      .then((r) => setObservations(r.observations))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load completed observations"));
  }, []);

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!observations) return <Spinner />;
  if (observations.length === 0) return <p className="text-sm text-muted">Nothing here yet. Confirmed observations will show up in this list.</p>;

  return (
    <div className="space-y-3">
      {observations.map((obs) => (
        <a
          key={obs.observationId}
          href={obs.url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-3 rounded-xl border border-line bg-surface p-4 hover:bg-surface-muted"
        >
          {obs.currentPhotoId ? (
            <img src={`/api/photos/${obs.currentPhotoId}/thumb`} alt="" className="h-14 w-14 rounded-md object-cover" />
          ) : (
            <div className="h-14 w-14 rounded-md bg-surface-muted" />
          )}
          <p className="text-sm font-medium text-ink">{speciesLabel(obs.commonName, obs.scientificName)}</p>
        </a>
      ))}
    </div>
  );
}
