import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import Button from "../../components/Button";
import DownloadedPacksList from "../../components/DownloadedPacksList";
import { usePackIndex } from "../../lib/packIndex";
import FormMessage from "../../components/FormMessage";
import JobProgress from "../../components/JobProgress";
import { useConfirm } from "../../hooks/useConfirm";
import { useJobPoll } from "../../hooks/useJobPoll";
import { errorMessage } from "../../lib/errorMessage";
import { formatBytes, formatNumber } from "../../lib/format";
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
import { SettingRow, SettingSwitchRow, SettingsGroup } from "./shared";
import MatchingHardware from "./MatchingHardware";
import { useServerSetting } from "./useServerSetting";
import { ignore } from "../../lib/ignore";

export default function OfflineDataSettings() {
  return (
    <>
      <SettingsGroup title="Species data">
        <CatalogUpdateRow />
        <EmbeddingModelRows />
        <MapRow />
      </SettingsGroup>
      <SettingsGroup title="Region packs">
        <OfflinePacksSummaryRow />
        <WithheldPhotosRow />
      </SettingsGroup>
    </>
  );
}

// Whether JobProgress has a failure or cancellation to show, so an idle row gets no empty space.
function hasOutcome(status: { error: string | null; cancelled: boolean }, actionError: string | null) {
  return !!(actionError || status.error || status.cancelled);
}

// Species in a downloaded pack whose only iNaturalist photos can't be redistributed get them
// fetched in the background, for this install only (apps/api/src/species/withheldPhotos.ts).
function WithheldPhotosRow() {
  const setting = useServerSetting("fetchWithheldPhotos", "/settings/fetch-withheld-photos");
  return (
    <SettingSwitchRow
      setting={setting}
      label="Fetch photos packs can't include"
      description="Some photos are left out of packs for licensing reasons. This downloads them from iNaturalist in the background, for your own viewing."
    />
  );
}

// Refreshes catalog metadata from the latest published seed (see catalogSeedUpdate.ts); an
// existing install never gets it otherwise. Downloaded reference photos are left alone.
function CatalogUpdateRow() {
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

  const checkAgain = (
    <Button variant="secondary" size="sm" onClick={() => void checkForUpdate()}>
      Check again
    </Button>
  );
  let statusText: string;
  let control: ReactNode = null;
  if (running) {
    statusText = "Updating.";
  } else if (check === "idle" || check === "checking") {
    statusText = "Checking for updates.";
    control = (
      <Button variant="secondary" size="sm" loading>
        Checking…
      </Button>
    );
  } else if (check === "error") {
    statusText = "Couldn't check for updates.";
    control = checkAgain;
  } else if (check === "up-to-date") {
    statusText = doneOk
      ? speciesCount === 0
        ? "Already up to date."
        : `Updated ${speciesCount != null ? formatNumber(speciesCount) : "your"} species.`
      : "Up to date.";
    control = checkAgain;
  } else {
    statusText = `A newer catalog is available${downloadBytes ? ` (${formatBytes(downloadBytes)})` : ""}.`;
    if (!finished && !job.actionError) {
      control = (
        <Button variant="secondary" size="sm" onClick={applyUpdate} loading={job.starting}>
          {job.starting ? "Starting…" : "Update"}
        </Button>
      );
    }
  }

  return (
    <SettingRow
      label="Species catalog"
      description={`Rarity tiers, occurrence stats and endemic labels. ${statusText}`}
      control={control}
    >
      {running && (
        <JobProgress
          status={job.status}
          phases={CATALOG_PHASES}
          onCancel={() => void job.cancel("/settings/catalog-update/cancel")}
          cancelling={job.cancelling}
        />
      )}
      {!running && check === "error" && <FormMessage error={checkError} />}
      {!running && check === "up-to-date" && doneOk && vectorErrors.length > 0 && (
        <p className="text-xs text-muted">
          Species reference vectors couldn't be fully updated: {vectorErrors.join(" ")}
        </p>
      )}
      {!running && (finished || job.actionError) && (
        <JobProgress
          status={finished}
          error={job.actionError}
          onRetry={check === "available" ? applyUpdate : undefined}
        />
      )}
    </SettingRow>
  );
}

// Management of what's already downloaded; discovering new regions stays on the Offline packs page.
function OfflinePacksSummaryRow() {
  const { packs, error, refresh } = usePackIndex();
  const loadError = error ? errorMessage(error, "Couldn't load your downloaded packs") : null;
  // Refetched on open: this is where downloads are managed, so it shouldn't show a stale list.
  useEffect(() => {
    refresh().catch(ignore("Couldn't refresh the pack index"));
  }, [refresh]);
  const refreshList = () => void refresh().catch(ignore("Couldn't refresh the pack index"));

  if (!packs) {
    return loadError ? <SettingRow label="Downloaded packs">{<FormMessage error={loadError} />}</SettingRow> : null;
  }
  const downloaded = packs.filter((p) => p.downloaded);
  const totalBytes = downloaded.reduce((sum, p) => sum + p.sizeBytes, 0);

  return (
    <SettingRow
      label="Downloaded packs"
      description={
        downloaded.length === 0
          ? "No region packs downloaded yet."
          : `${pluralize(downloaded.length, "pack")}, ${formatBytes(totalBytes)} in total.`
      }
      control={
        <Link to="/offline-packs" className="text-sm text-ink underline">
          {downloaded.length === 0 ? "Browse regions" : "Manage packs"}
        </Link>
      }
    >
      {downloaded.length > 0 && <DownloadedPacksList packs={packs} onRefresh={refreshList} />}
    </SettingRow>
  );
}

// An opt-in (~550 MB) basemap download, required for the locality/occurrence map of a species.
function MapRow() {
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
      title: "Remove the offline map?",
      message: `Remove the offline map${sizeLabel}? You can download it again anytime.`,
      confirmLabel: "Remove",
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
      setOffloadError(errorMessage(err, "Couldn't remove the map"));
    } finally {
      setBusy(false);
    }
  }

  // `available` only means a download source is configured; a downloaded map still needs its offload button.
  if (!status || (!status.available && !status.downloaded)) return null;

  return (
    <SettingRow
      label="Offline map"
      description={`Needed for species range maps, even when online. ${
        status.downloaded
          ? status.sizeBytes
            ? `Uses ${formatBytes(status.sizeBytes)}.`
            : "Downloaded."
          : "About 550 MB."
      }`}
      control={
        status.running ? null : status.downloaded ? (
          <Button variant="secondary" size="sm" onClick={offload} loading={busy}>
            {busy ? "Removing…" : "Remove"}
          </Button>
        ) : (
          <Button variant="secondary" size="sm" onClick={download} loading={job.starting}>
            {job.starting ? "Starting…" : "Download"}
          </Button>
        )
      }
    >
      {status.running ? (
        <JobProgress
          status={status}
          phases={MAP_PHASES}
          onCancel={() => void job.cancel("/settings/map/download/cancel")}
          cancelling={job.cancelling}
        />
      ) : (
        !status.downloaded &&
        hasOutcome(status, job.actionError) && (
          <JobProgress status={status} error={job.actionError} errorPrefix="Download failed" />
        )
      )}
      {offloadError && <FormMessage error={offloadError} />}
    </SettingRow>
  );
}

// BioCLIP 2 names species in suggestions; CLIP powers Gallery content search. Both opt-in downloads.
function EmbeddingModelRows() {
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
      title: "Remove the species-matching model?",
      message: `Remove the species-matching model${sizeLabel}? Species suggestions while importing will turn off, and Gallery search will fall back to matching species names, ABA/eBird codes, and camera info only, so a search like "water bird" won't find photos by what's in them anymore. You can download it again anytime.`,
      confirmLabel: "Remove",
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

  const purpose = "Powers import suggestions and searching photos by what's in them.";
  const activeText =
    status.activeModel === "identification"
      ? "Suggestions use the identification model (BioCLIP 2)."
      : status.activeModel
        ? status.running
          ? "Suggestions use the general model until this finishes."
          : status.idModelDownloaded
            ? "Suggestions use the general model until the identification model's reference vectors install. Lifer retries each start."
            : "Suggestions use the general, less accurate model."
        : null;
  let description: string;
  if (status.running) {
    description = activeText ?? purpose;
  } else if (status.downloaded) {
    description = `${activeText ?? purpose}${status.sizeBytes ? ` Uses ${formatBytes(status.sizeBytes)}.` : ""}`;
  } else if (!status.usable) {
    description = `${purpose} About 680 MB.`;
  } else if (status.idModelDownloaded) {
    description = `${activeText ?? purpose} The scene model (about 61 MB) is still missing.`;
  } else {
    description = `${activeText ?? purpose} The identification model (about 370 MB) improves them.`;
  }

  return (
    <>
      <SettingRow
        label="Species-matching model"
        description={description}
        control={
          status.running ? null : status.downloaded ? (
            <Button variant="secondary" size="sm" onClick={offload} loading={busy}>
              {busy ? "Removing…" : "Remove"}
            </Button>
          ) : (
            <Button variant="secondary" size="sm" onClick={download} loading={job.starting}>
              {job.starting ? "Starting…" : "Download"}
            </Button>
          )
        }
      >
        {status.running ? (
          <JobProgress
            status={status}
            phases={MODEL_PHASES}
            onCancel={() => void job.cancel("/settings/embedding-model/download/cancel")}
            cancelling={job.cancelling}
          />
        ) : status.downloaded ? (
          vectorErrors.length > 0 && (
            <p className="text-xs text-muted">
              Species reference vectors couldn't be fully downloaded: {vectorErrors.join(" ")}
            </p>
          )
        ) : (
          hasOutcome(status, job.actionError) && (
            <JobProgress status={status} error={job.actionError} errorPrefix="Download failed" />
          )
        )}
        {offloadError && <FormMessage error={offloadError} />}
      </SettingRow>
      {status.downloaded && !status.running && <MatchingHardware />}
    </>
  );
}
