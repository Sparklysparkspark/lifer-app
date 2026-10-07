import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import PageHeader from "../components/PageHeader";
import { Spinner } from "../components/LoadingScreen";
import EmptyState from "../components/EmptyState";
import Button from "../components/Button";
import FormMessage from "../components/FormMessage";
import { formatDate } from "../lib/format";
import { pluralize } from "../lib/pluralize";
import { openExternal } from "../lib/openExternal";

const sendIcon = (
  <svg
    viewBox="0 0 24 24"
    className="h-6 w-6 text-muted"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z" />
  </svg>
);
const pendingIcon = (
  <svg
    viewBox="0 0 24 24"
    className="h-6 w-6 text-muted"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 3" />
  </svg>
);
const completedIcon = (
  <svg
    viewBox="0 0 24 24"
    className="h-6 w-6 text-muted"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

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
  const startDate = formatDate(start, "medium");
  if (!end || end === start) return startDate;
  const endDate = formatDate(end, "medium");
  return startDate === endDate ? startDate : `${startDate} – ${endDate}`;
}

// Reached from Settings: sightings waiting to send, drafts not yet finished on iNaturalist, and
// what's been fully contributed.
export default function InaturalistPage() {
  const [tab, setTab] = useState<Tab>("import");

  return (
    <div className="flex-1 bg-canvas">
      <PageHeader sticky title="iNaturalist" backFallbackTo="/settings" backLabel="Settings">
        <p className="mt-1 text-sm text-muted">
          Send your sightings to iNaturalist as draft observations, then finish them there.
        </p>
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
  const [notice, setNotice] = useState<string | null>(null);

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
    setNotice(null);
    try {
      const sent = await api.post<{ editUrl: string; needsLocation: boolean; needsDate: boolean }>(
        "/inaturalist/observations",
        { captureIds },
      );
      // Lifer only sends what the photos recorded. Anything missing is added on iNaturalist,
      // whose map is far better for placing a sighting than anything offline.
      if (sent.needsLocation || sent.needsDate) {
        const missing =
          sent.needsLocation && sent.needsDate ? "location and date" : sent.needsLocation ? "location" : "date";
        setNotice(
          `Sent. These photos had no ${missing}, so add it on iNaturalist, then choose Confirm complete on the Pending tab to bring it back into Lifer.`,
        );
        openExternal(sent.editUrl);
      } else {
        setNotice("Sent to iNaturalist.");
      }
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create the observation");
    } finally {
      setSubmitting(null);
    }
  }

  if (error) return <FormMessage error={error} />;
  if (!clusters) return <Spinner />;
  const noticeMessage = notice ? <FormMessage success={notice} /> : null;
  if (clusters.length === 0)
    return (
      <div className="space-y-4">
        {noticeMessage}
        <EmptyState
          icon={sendIcon}
          title="Nothing waiting to be sent"
          description="Every sighting has already been submitted."
        />
      </div>
    );

  return (
    <div className="space-y-4">
      {noticeMessage}
      {clusters.map((cluster) => {
        const key = clusterKey(cluster);
        const excludedIds = excluded[key] ?? new Set<string>();
        return (
          <div key={key} className="rounded-xl border border-line bg-surface p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-ink">
                  {speciesLabel(cluster.commonName, cluster.scientificName)}
                </p>
                <p className="text-xs text-muted">
                  {pluralize(cluster.captures.length, "photo")} ·{" "}
                  {formatDateRange(cluster.earliestTakenAt, cluster.latestTakenAt)}
                </p>
              </div>
              <Button
                size="sm"
                onClick={() => createObservation(cluster)}
                loading={submitting === key}
                disabled={excludedIds.size === cluster.captures.length}
              >
                {submitting === key ? "Creating…" : "Create observation"}
              </Button>
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
                      loading="lazy"
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
      const result = await api.post<{ confirmed: boolean; message?: string }>(
        `/inaturalist/observations/${observationId}/confirm`,
      );
      if (result.confirmed) load();
      else setMessage((prev) => ({ ...prev, [observationId]: result.message ?? "Not yet confirmed." }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't check this observation");
    } finally {
      setConfirming(null);
    }
  }

  if (error) return <FormMessage error={error} />;
  if (!observations) return <Spinner />;
  if (observations.length === 0)
    return (
      <EmptyState
        icon={pendingIcon}
        title="Nothing pending"
        description="Every observation you've sent has been confirmed complete."
      />
    );

  return (
    <div className="space-y-3">
      {observations.map((obs) => (
        <div key={obs.observationId} className="rounded-xl border border-line bg-surface p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              {obs.currentPhotoId ? (
                <img
                  src={`/api/photos/${obs.currentPhotoId}/thumb`}
                  alt=""
                  loading="lazy"
                  className="h-14 w-14 rounded-md object-cover"
                />
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
            <Button
              variant="secondary"
              size="sm"
              onClick={() => confirm(obs.observationId)}
              loading={confirming === obs.observationId}
            >
              {confirming === obs.observationId ? "Checking…" : "Confirm complete"}
            </Button>
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

  if (error) return <FormMessage error={error} />;
  if (!observations) return <Spinner />;
  if (observations.length === 0)
    return (
      <EmptyState
        icon={completedIcon}
        title="Nothing here yet"
        description="Confirmed observations will show up in this list."
      />
    );

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
            <img
              src={`/api/photos/${obs.currentPhotoId}/thumb`}
              alt=""
              loading="lazy"
              className="h-14 w-14 rounded-md object-cover"
            />
          ) : (
            <div className="h-14 w-14 rounded-md bg-surface-muted" />
          )}
          <p className="text-sm font-medium text-ink">{speciesLabel(obs.commonName, obs.scientificName)}</p>
        </a>
      ))}
    </div>
  );
}
