import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { JobStatus } from "@lifer/shared";
import { api } from "../../api/client";
import Button from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import FreeSpaceNote from "../../components/FreeSpaceNote";
import JobProgress from "../../components/JobProgress";
import Select from "../../components/Select";
import { useConfirm } from "../../hooks/useConfirm";
import { useJobPoll } from "../../hooks/useJobPoll";
import { errorMessage } from "../../lib/errorMessage";
import { formatBytes } from "../../lib/format";
import { checkPmtilesAvailable } from "../../lib/pmtilesAvailable";
import { MAP_PHASES } from "./phases";
import { SettingRow } from "./shared";

type Extract = { code: string; name: string; sizeBytes: number; downloaded: boolean; updateAvailable: boolean };
type DetailStatus = JobStatus<{ code: string }> & {
  code: string | null;
  available: boolean;
  indexError: string | null;
  extracts: Extract[];
  freeBytes: number | null;
};

// Optional street and trail maps, one country each (apps/api/src/offlinePacks/mapDetail.ts). The
// list comes from the published index; nothing downloads until the user picks a country.
export default function DetailedMapsRows() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const job = useJobPoll<DetailStatus>("/offline-packs/maps/status", {
    idleIntervalMs: null,
    // The map style reads which countries have detail when a map next opens.
    onFinish: () => void checkPmtilesAvailable(),
  });
  const [code, setCode] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<{ code: string; text: string } | null>(null);
  const status = job.status;
  if (!status || (!status.available && !status.extracts.some((e) => e.downloaded))) return null;

  const choices = status.extracts.filter((e) => !e.downloaded);
  const picked = choices.find((e) => e.code === code) ?? choices[0];
  const fits = !picked || status.freeBytes == null || picked.sizeBytes * 1.1 <= status.freeBytes;

  async function remove(e: Extract) {
    const ok = await confirm({
      title: t("settings.offlineData.detailMaps.removeConfirm.title", { name: e.name }),
      message: t("settings.offlineData.detailMaps.removeConfirm.message", { size: formatBytes(e.sizeBytes) }),
      confirmLabel: t("settings.offlineData.remove"),
      danger: true,
    });
    if (!ok) return;
    setRemoving(e.code);
    setRemoveError(null);
    try {
      await api.delete(`/offline-packs/maps/${encodeURIComponent(e.code)}`);
      await Promise.all([job.refresh(), checkPmtilesAvailable()]);
    } catch (err) {
      setRemoveError({ code: e.code, text: errorMessage(err, t("settings.offlineData.detailMaps.removeFailed")) });
    } finally {
      setRemoving(null);
    }
  }

  const download = (c: string) => void job.start("/offline-packs/maps/download", { code: c });

  return (
    <>
      <SettingRow
        label={t("settings.offlineData.detailMaps.label")}
        description={
          <>
            {t("settings.offlineData.detailMaps.description")}
            {picked && !status.running && (
              <>
                {" "}
                {t("settings.offlineData.detailMaps.size", { size: formatBytes(picked.sizeBytes) })}
                <FreeSpaceNote needed={picked.sizeBytes} free={status.freeBytes} />
              </>
            )}
          </>
        }
        control={
          !status.running &&
          picked && (
            <div className="flex items-center gap-2">
              <Select
                label={t("settings.offlineData.detailMaps.country")}
                labelClassName="sr-only"
                value={picked.code}
                onChange={(e) => setCode(e.target.value)}
                className="max-w-48"
              >
                {choices.map((e) => (
                  <option key={e.code} value={e.code}>
                    {e.name}
                  </option>
                ))}
              </Select>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => download(picked.code)}
                loading={job.starting}
                disabled={!fits}
              >
                {job.starting ? t("settings.offlineData.starting") : t("settings.offlineData.download")}
              </Button>
            </div>
          )
        }
      >
        {status.running ? (
          <JobProgress
            status={status}
            phases={MAP_PHASES}
            onCancel={() => void job.cancel("/offline-packs/maps/download/cancel")}
            cancelling={job.cancelling}
          />
        ) : (
          (job.actionError || status.error || status.cancelled) && (
            <JobProgress
              status={status}
              error={job.actionError}
              errorPrefix={t("settings.offlineData.downloadFailed")}
            />
          )
        )}
        {status.indexError && <FormMessage error={t("settings.offlineData.detailMaps.listFailed")} />}
      </SettingRow>
      {status.extracts
        .filter((e) => e.downloaded)
        .map((e) => (
          <SettingRow
            key={e.code}
            label={e.name}
            description={t("settings.offlineData.uses", { size: formatBytes(e.sizeBytes) })}
            control={
              <div className="flex items-center gap-2">
                {e.updateAvailable && !status.running && (
                  <Button variant="secondary" size="sm" onClick={() => download(e.code)}>
                    {t("settings.offlineData.detailMaps.update")}
                  </Button>
                )}
                <Button variant="secondary" size="sm" onClick={() => void remove(e)} loading={removing === e.code}>
                  {removing === e.code ? t("settings.offlineData.removing") : t("settings.offlineData.remove")}
                </Button>
              </div>
            }
          >
            {removeError?.code === e.code && <FormMessage error={removeError.text} />}
          </SettingRow>
        ))}
    </>
  );
}
