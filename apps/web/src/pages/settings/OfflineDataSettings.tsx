import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import Button from "../../components/Button";
import ConnectionNote from "../../components/ConnectionNote";
import FormMessage from "../../components/FormMessage";
import JobProgress from "../../components/JobProgress";
import { useConfirm } from "../../hooks/useConfirm";
import { useJobPoll } from "../../hooks/useJobPoll";
import { errorMessage } from "../../lib/errorMessage";
import { formatBytes, formatNumber } from "../../lib/format";
import { useConnection } from "../../lib/packIndex";
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

export default function OfflineDataSettings() {
  const { t } = useTranslation();
  return (
    <>
      <SettingsGroup title={t("settings.offlineData.speciesData")}>
        <CatalogUpdateRow />
        <EmbeddingModelRows />
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
export function WithheldPhotosRow() {
  const { t } = useTranslation();
  const setting = useServerSetting("fetchWithheldPhotos", "/settings/fetch-withheld-photos");
  return (
    <SettingSwitchRow
      setting={setting}
      label={t("settings.offlineData.withheld.label")}
      description={t("settings.offlineData.withheld.description")}
    />
  );
}

// Refreshes catalog metadata from the latest published seed (see catalogSeedUpdate.ts); an
// existing install never gets it otherwise. Downloaded reference photos are left alone.
function CatalogUpdateRow() {
  const { t } = useTranslation();
  const [check, setCheck] = useState<"idle" | "checking" | "up-to-date" | "available" | "error">("idle");
  const [checkError, setCheckError] = useState<string | null>(null);
  const [downloadBytes, setDownloadBytes] = useState<number | null>(null);
  // Only a run this mount watched finish shows its outcome.
  const [finished, setFinished] = useState<CatalogUpdateStatus | null>(null);
  const connection = useConnection();
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
          setCheckError(errorMessage(err, t("settings.offlineData.catalog.checkFailed")));
          setCheck("error");
        }),
    [t],
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
      {t("settings.offlineData.catalog.checkAgain")}
    </Button>
  );
  let statusText: string;
  let control: ReactNode = null;
  if (running) {
    statusText = t("settings.offlineData.catalog.updating");
  } else if (check === "idle" || check === "checking") {
    statusText = t("settings.offlineData.catalog.checking");
    control = (
      <Button variant="secondary" size="sm" loading>
        {t("settings.offlineData.catalog.checkingButton")}
      </Button>
    );
  } else if (check === "error") {
    statusText = t("settings.offlineData.catalog.checkError");
    control = checkAgain;
  } else if (check === "up-to-date") {
    statusText = doneOk
      ? speciesCount === 0
        ? t("settings.offlineData.catalog.alreadyUpToDate")
        : speciesCount != null
          ? t("settings.offlineData.catalog.updatedCount", { species: formatNumber(speciesCount) })
          : t("settings.offlineData.catalog.updatedAll")
      : t("settings.offlineData.catalog.upToDate");
    control = checkAgain;
  } else {
    statusText = downloadBytes
      ? t("settings.offlineData.catalog.availableWithSize", { size: formatBytes(downloadBytes) })
      : t("settings.offlineData.catalog.available");
    if (!finished && !job.actionError) {
      control = (
        <Button variant="secondary" size="sm" onClick={applyUpdate} loading={job.starting}>
          {job.starting ? t("settings.offlineData.starting") : t("settings.offlineData.catalog.update")}
        </Button>
      );
    }
  }

  return (
    <SettingRow
      label={t("settings.offlineData.catalog.label")}
      description={t("settings.offlineData.catalog.description", { status: statusText })}
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
      {/* Offline or slow, the shared note says so instead of the raw error; Check again stays usable. */}
      {!running && (check === "checking" || check === "error") && <ConnectionNote state={connection} />}
      {!running && check === "error" && connection === "online" && <FormMessage error={checkError} />}
      {!running && check === "up-to-date" && doneOk && vectorErrors.length > 0 && (
        <p className="text-footnote text-muted">
          {t("settings.offlineData.vectorsUpdateFailed", { errors: vectorErrors.join(" ") })}
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

// An opt-in (~640 MB) basemap download, required for the locality/occurrence map of a species.
export function MapRow() {
  const { t } = useTranslation();
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
    const ok = await confirm({
      title: t("settings.offlineData.map.removeConfirm.title"),
      message: status?.sizeBytes
        ? t("settings.offlineData.map.removeConfirm.messageWithSize", { size: formatBytes(status.sizeBytes) })
        : t("settings.offlineData.map.removeConfirm.message"),
      confirmLabel: t("settings.offlineData.remove"),
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
      setOffloadError(errorMessage(err, t("settings.offlineData.map.removeFailed")));
    } finally {
      setBusy(false);
    }
  }

  // `available` only means a download source is configured; a downloaded map still needs its offload button.
  if (!status || (!status.available && !status.downloaded)) return null;

  return (
    <SettingRow
      label={t("settings.offlineData.map.label")}
      description={t("settings.offlineData.map.description", {
        status: status.downloaded
          ? status.sizeBytes
            ? t("settings.offlineData.uses", { size: formatBytes(status.sizeBytes) })
            : t("settings.offlineData.map.downloaded")
          : t("settings.offlineData.map.size"),
      })}
      control={
        status.running ? null : status.downloaded ? (
          <Button variant="secondary" size="sm" onClick={offload} loading={busy}>
            {busy ? t("settings.offlineData.removing") : t("settings.offlineData.remove")}
          </Button>
        ) : (
          <Button variant="secondary" size="sm" onClick={download} loading={job.starting}>
            {job.starting ? t("settings.offlineData.starting") : t("settings.offlineData.download")}
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
          <JobProgress status={status} error={job.actionError} errorPrefix={t("settings.offlineData.downloadFailed")} />
        )
      )}
      {offloadError && <FormMessage error={offloadError} />}
    </SettingRow>
  );
}

// BioCLIP 2 names species in suggestions; CLIP powers Gallery content search. Both opt-in downloads.
function EmbeddingModelRows() {
  const { t } = useTranslation();
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
    const ok = await confirm({
      title: t("settings.offlineData.model.removeConfirm.title"),
      message: status?.sizeBytes
        ? t("settings.offlineData.model.removeConfirm.messageWithSize", { size: formatBytes(status.sizeBytes) })
        : t("settings.offlineData.model.removeConfirm.message"),
      confirmLabel: t("settings.offlineData.remove"),
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
      setOffloadError(errorMessage(err, t("settings.offlineData.model.removeFailed")));
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;
  const vectorErrors = failedVectorAssets(status.result?.referenceVectors);

  const purpose = t("settings.offlineData.model.purpose");
  const activeText =
    status.activeModel === "identification"
      ? t("settings.offlineData.model.activeIdentification")
      : status.activeModel
        ? status.running
          ? t("settings.offlineData.model.activeGeneralRunning")
          : status.idModelDownloaded
            ? t("settings.offlineData.model.activeGeneralPending")
            : t("settings.offlineData.model.activeGeneral")
        : null;
  let description: string;
  if (status.running) {
    description = activeText ?? purpose;
  } else if (status.downloaded) {
    description = status.sizeBytes
      ? `${activeText ?? purpose} ${t("settings.offlineData.uses", { size: formatBytes(status.sizeBytes) })}`
      : (activeText ?? purpose);
  } else if (!status.usable) {
    description = `${purpose} ${t("settings.offlineData.model.size")}`;
  } else if (status.idModelDownloaded) {
    description = `${activeText ?? purpose} ${t("settings.offlineData.model.sceneMissing")}`;
  } else {
    description = `${activeText ?? purpose} ${t("settings.offlineData.model.idMissing")}`;
  }

  return (
    <>
      <SettingRow
        label={t("settings.offlineData.model.label")}
        description={description}
        control={
          status.running ? null : status.downloaded ? (
            <Button variant="secondary" size="sm" onClick={offload} loading={busy}>
              {busy ? t("settings.offlineData.removing") : t("settings.offlineData.remove")}
            </Button>
          ) : (
            <Button variant="secondary" size="sm" onClick={download} loading={job.starting}>
              {job.starting ? t("settings.offlineData.starting") : t("settings.offlineData.download")}
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
            <p className="text-footnote text-muted">
              {t("settings.offlineData.vectorsDownloadFailed", { errors: vectorErrors.join(" ") })}
            </p>
          )
        ) : (
          hasOutcome(status, job.actionError) && (
            <JobProgress
              status={status}
              error={job.actionError}
              errorPrefix={t("settings.offlineData.downloadFailed")}
            />
          )
        )}
        {offloadError && <FormMessage error={offloadError} />}
      </SettingRow>
      {status.downloaded && !status.running && <MatchingHardware />}
    </>
  );
}
