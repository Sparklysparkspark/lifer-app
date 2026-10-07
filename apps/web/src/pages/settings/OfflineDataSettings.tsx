import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import Button from "../../components/Button";
import { buttonClasses } from "../../lib/buttonClasses";
import DownloadedPacksList, { type PackEntry } from "../../components/DownloadedPacksList";
import FormMessage from "../../components/FormMessage";
import InlineSpinner from "../../components/InlineSpinner";
import JobProgress from "../../components/JobProgress";
import { useConfirm } from "../../hooks/useConfirm";
import { useJobPoll } from "../../hooks/useJobPoll";
import { errorMessage } from "../../lib/errorMessage";
import { formatBytes } from "../../lib/format";
import { pluralize } from "../../lib/pluralize";
import {
  CATALOG_PHASES,
  MAP_PHASES,
  MODEL_PHASES,
  failedVectorAssets,
  type CatalogUpdateStatus,
  type MapStatus,
  type ModelStatus,
} from "./phases";
import { Card, SettingToggleCard } from "./shared";
import MatchingHardware from "./MatchingHardware";
import { useServerSetting } from "./useServerSetting";

export default function OfflineDataSettings() {
  return (
    <>
      <CatalogUpdateSection />
      <MapSection />
      <EmbeddingModelSection />
      <OfflinePacksSummarySection />
      <WithheldPhotosSection />
    </>
  );
}

// Species in a downloaded pack whose only iNaturalist photos can't be redistributed get them
// fetched in the background, for this install only (apps/api/src/species/withheldPhotos.ts).
function WithheldPhotosSection() {
  const setting = useServerSetting("fetchWithheldPhotos", "/settings/fetch-withheld-photos");
  return (
    <SettingToggleCard
      setting={setting}
      learnMore="withheld-photos"
      title="Photos packs can't include"
      description="Some photos can't be included in packs for licensing reasons. Lifer can download them from iNaturalist for your own viewing, a few at a time in the background, so the species in your packs have photos offline too."
      label="Fetch withheld photos in the background"
    />
  );
}

// Refreshes catalog metadata from the latest published seed (see catalogSeedUpdate.ts); an
// existing install never gets it otherwise. Downloaded reference photos are left alone.
function CatalogUpdateSection() {
  const [check, setCheck] = useState<"idle" | "checking" | "up-to-date" | "available" | "error">("idle");
  const [checkError, setCheckError] = useState<string | null>(null);
  const [downloadBytes, setDownloadBytes] = useState<number | null>(null);
  // Only a run this mount watched finish shows its outcome.
  const [finished, setFinished] = useState<CatalogUpdateStatus | null>(null);
  const job = useJobPoll<CatalogUpdateStatus>("/settings/catalog-update/status", {
    onFinish: (status) => {
      setFinished(status);
      if (!status.error && !status.cancelled) setCheck("up-to-date");
    },
  });

  // The request itself, once "checking" is showing. Only touches state setters, so one copy serves.
  const fetchCatalogUpdate = useCallback(
    (): Promise<void> =>
      api
        .get<{ available: boolean; downloadBytes?: number | null }>("/settings/catalog-update")
        .then((result) => {
          setDownloadBytes(result.downloadBytes ?? null);
          setCheck(result.available ? "available" : "up-to-date");
        })
        .catch((err) => {
          console.error(err);
          setCheckError(errorMessage(err, "Couldn't check for a catalog update"));
          setCheck("error");
        }),
    [],
  );

  async function checkForUpdate(clearOutcome = true) {
    setCheck("checking");
    setCheckError(null);
    if (clearOutcome) setFinished(null);
    await fetchCatalogUpdate();
  }

  // One automatic check per mount. The job survives navigation, so it waits for the poll to find
  // a running one first. A just-failed run's outcome stays visible (with Retry) through it.
  // "checking" is set while rendering; the effect then sends the request.
  const initialStatusSeen = job.status !== null || job.loadError !== null;
  const [autoChecked, setAutoChecked] = useState(false);
  if (!autoChecked && initialStatusSeen && check === "idle" && !job.status?.running) {
    setAutoChecked(true);
    setCheck("checking");
  }
  useEffect(() => {
    if (autoChecked) void fetchCatalogUpdate();
  }, [autoChecked, fetchCatalogUpdate]);

  async function applyUpdate() {
    setFinished(null);
    await job.start("/settings/catalog-update/apply");
  }

  const running = job.status?.running === true;
  const speciesCount = finished?.result?.merged?.species;
  const vectorErrors = failedVectorAssets(finished?.result?.referenceVectors);
  const doneOk = finished && !finished.error && !finished.cancelled;

  return (
    <Card
      title="Species catalog updates"
      learnMore="species-catalog"
      description="Refreshes rarity tiers, occurrence stats, and endemic labels from the latest published data. Never touches your own downloaded reference photos."
    >
      {running ? (
        <JobProgress
          status={job.status}
          phases={CATALOG_PHASES}
          onCancel={() => void job.cancel("/settings/catalog-update/cancel")}
          cancelling={job.cancelling}
        />
      ) : check === "idle" || check === "checking" ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <InlineSpinner />
          Checking…
        </p>
      ) : check === "error" ? (
        <div className="space-y-2">
          <FormMessage error={checkError} />
          <button type="button" onClick={() => void checkForUpdate()} className="text-sm text-ink underline">
            Check again
          </button>
        </div>
      ) : check === "up-to-date" ? (
        <div className="space-y-2">
          <p className="text-sm text-muted">
            {doneOk
              ? `Done, ${speciesCount != null ? speciesCount.toLocaleString() : "your"} species refreshed.`
              : "Your species catalog is up to date."}
          </p>
          {doneOk && vectorErrors.length > 0 && (
            <p className="text-sm text-muted">
              Species reference vectors couldn't be fully updated: {vectorErrors.join(" ")}
            </p>
          )}
          <button type="button" onClick={() => void checkForUpdate()} className="text-sm text-ink underline">
            Check again
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm font-medium text-ink">A newer species catalog is available.</p>
          {!finished && !job.actionError && (
            <Button onClick={applyUpdate} loading={job.starting}>
              {job.starting ? "Starting…" : `Update catalog${downloadBytes ? ` (${formatBytes(downloadBytes)})` : ""}`}
            </Button>
          )}
        </div>
      )}
      {!running && (
        <JobProgress
          status={finished}
          error={job.actionError}
          onRetry={check === "available" ? applyUpdate : undefined}
        />
      )}
    </Card>
  );
}

// Management of what's already downloaded; discovering new regions stays on the Offline packs page.
function OfflinePacksSummarySection() {
  const [packs, setPacks] = useState<PackEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  function refresh() {
    api
      .get<{ packs: PackEntry[] }>("/offline-packs/index")
      .then((res) => {
        setPacks(res.packs);
        setLoadError(null);
      })
      .catch((err) => setLoadError(errorMessage(err, "Couldn't load your downloaded packs")));
  }

  useEffect(refresh, []);

  if (!packs) {
    return loadError ? (
      <Card title="Downloaded packs" description="" learnMore="downloaded-packs">
        <FormMessage error={loadError} />
      </Card>
    ) : null;
  }
  const downloaded = packs.filter((p) => p.downloaded);
  const totalBytes = downloaded.reduce((sum, p) => sum + p.sizeBytes, 0);

  return (
    <Card
      title="Downloaded packs"
      learnMore="downloaded-packs"
      description={
        downloaded.length === 0
          ? "No region packs downloaded yet."
          : `${pluralize(downloaded.length, "pack")} downloaded, ${formatBytes(totalBytes)} total.`
      }
    >
      {downloaded.length === 0 ? (
        <Link to="/offline-packs" className={buttonClasses("secondary", "sm")}>
          Browse regions
        </Link>
      ) : (
        <>
          <DownloadedPacksList packs={packs} onRefresh={refresh} />
          <Link to="/offline-packs" className="text-sm text-ink underline">
            Manage in Offline packs
          </Link>
        </>
      )}
    </Card>
  );
}

// An opt-in (~550 MB) basemap download, required for the locality/occurrence map of a species.
function MapSection() {
  const job = useJobPoll<MapStatus>("/settings/map/status", { idleIntervalMs: 5000 });
  const status = job.status;
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [offloadError, setOffloadError] = useState<string | null>(null);

  // No confirmation: the label and description already say what this does and how big it is.
  function download() {
    setOffloadError(null);
    void job.start("/settings/map/download");
  }

  async function offload() {
    const sizeLabel = status?.sizeBytes ? ` (~${formatBytes(status.sizeBytes)})` : "";
    const ok = await confirm({
      title: "Offload the offline map?",
      message: `Offload the downloaded offline map${sizeLabel}? You can download it again anytime.`,
      confirmLabel: "Offload",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setOffloadError(null);
    try {
      await api.delete("/settings/map");
      await job.refresh();
    } catch (err) {
      console.error(err);
      setOffloadError(errorMessage(err, "Couldn't offload the map"));
    } finally {
      setBusy(false);
    }
  }

  // `available` only means a download source is configured; a downloaded map still needs its offload button.
  if (!status || (!status.available && !status.downloaded)) return null;

  return (
    <Card
      title="Offline map"
      learnMore="offline-map"
      description="An offline basemap: this is what makes locality/occurrence data work at all, showing roughly where within a downloaded region each species is found. It doesn't render without this, even with an internet connection. Everything else in Lifer works the same either way."
    >
      {status.running ? (
        <JobProgress
          status={status}
          phases={MAP_PHASES}
          onCancel={() => void job.cancel("/settings/map/download/cancel")}
          cancelling={job.cancelling}
        />
      ) : status.downloaded ? (
        <Button variant="secondary" size="sm" onClick={offload} loading={busy}>
          {busy ? "Offloading…" : `Offload${status.sizeBytes ? ` (frees ${formatBytes(status.sizeBytes)})` : ""}`}
        </Button>
      ) : (
        <>
          <Button onClick={download} loading={job.starting}>
            {job.starting ? "Starting…" : "Download offline map (~550 MB)"}
          </Button>
          <JobProgress status={status} error={job.actionError} errorPrefix="Download failed" />
        </>
      )}
      <FormMessage error={offloadError} />
    </Card>
  );
}

// BioCLIP 2 names species in suggestions; CLIP powers Gallery content search. Both opt-in downloads.
function EmbeddingModelSection() {
  const job = useJobPoll<ModelStatus>("/settings/embedding-model/status", { idleIntervalMs: 5000 });
  const status = job.status;
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [offloadError, setOffloadError] = useState<string | null>(null);

  function download() {
    setOffloadError(null);
    void job.start("/settings/embedding-model/download");
  }

  async function offload() {
    const sizeLabel = status?.sizeBytes ? ` (~${formatBytes(status.sizeBytes)})` : "";
    const ok = await confirm({
      title: "Offload the species-matching model?",
      message: `Offload the species-matching model${sizeLabel}? Species suggestions while importing will turn off, and Gallery search will fall back to matching species names, ABA/eBird codes, and camera info only, so a search like "water bird" won't find photos by what's in them anymore. You can download it again anytime.`,
      confirmLabel: "Offload",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setOffloadError(null);
    try {
      await api.delete("/settings/embedding-model");
      await job.refresh();
    } catch (err) {
      console.error(err);
      setOffloadError(errorMessage(err, "Couldn't offload the model"));
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;
  const vectorErrors = failedVectorAssets(status.result?.referenceVectors);

  return (
    <Card
      title="Species-matching model"
      learnMore="species-model"
      description="Powers species suggestions while importing and Gallery's content search (finding photos by what's in them, like 'water bird', not just by species name). Without it, Lifer stays smaller and search falls back to species names, ABA/eBird codes, and camera info."
    >
      {status.activeModel && (
        <p className="text-sm text-muted">
          {status.activeModel === "identification"
            ? "Suggestions use the species identification model (BioCLIP 2)."
            : status.running
              ? "Suggestions use the general model until the identification model and its reference vectors are installed."
              : status.idModelDownloaded
                ? "Suggestions use the general model: the identification model's reference vectors aren't installed yet. They're tried again each time Lifer starts."
                : "Suggestions use the general model, which is less accurate. Download the identification model to improve them."}
        </p>
      )}
      {status.running ? (
        <JobProgress
          status={status}
          phases={MODEL_PHASES}
          onCancel={() => void job.cancel("/settings/embedding-model/download/cancel")}
          cancelling={job.cancelling}
        />
      ) : status.downloaded ? (
        <>
          <Button variant="secondary" size="sm" onClick={offload} loading={busy}>
            {busy ? "Offloading…" : `Offload${status.sizeBytes ? ` (frees ${formatBytes(status.sizeBytes)})` : ""}`}
          </Button>
          {vectorErrors.length > 0 && (
            <p className="text-sm text-muted">
              Species reference vectors couldn't be fully downloaded: {vectorErrors.join(" ")}
            </p>
          )}
          <MatchingHardware />
        </>
      ) : (
        <>
          <Button onClick={download} loading={job.starting}>
            {job.starting
              ? "Starting…"
              : status.usable
                ? "Download the identification model (~310 MB)"
                : "Download models (~620 MB)"}
          </Button>
          <JobProgress status={status} error={job.actionError} errorPrefix="Download failed" />
        </>
      )}
      <FormMessage error={offloadError} />
    </Card>
  );
}
