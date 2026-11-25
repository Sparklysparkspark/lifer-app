import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { JobStatus } from "@lifer/shared";
import { api, apiPath } from "../../api/client";
import Button from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import InfoTip from "../../components/InfoTip";
import JobProgress from "../../components/JobProgress";
import Select from "../../components/Select";
import Switch from "../../components/Switch";
import { useConfirm } from "../../hooks/useConfirm";
import { useJobPoll } from "../../hooks/useJobPoll";
import { errorMessage } from "../../lib/errorMessage";
import { ignore } from "../../lib/ignore";
import { SettingRow, SettingsGroup } from "./shared";

type SidecarNames = "stem" | "full" | "both";
interface FileWriting {
  sidecarNames: SidecarNames;
  insideFiles: boolean;
  linkedFolders: boolean;
}

const NAME_LABEL: Record<SidecarNames, string> = {
  stem: "fileWriting.sidecarNames.stem",
  full: "fileWriting.sidecarNames.full",
  both: "fileWriting.sidecarNames.both",
};

const APPLY = "/settings/file-writing/apply";

/** Settings > Metadata > Where keywords go: sidecar names for RAW files, in-file writes, sidecars
 *  next to linked files, and bringing photos already in Lifer in line after a change. */
export default function FileWritingSettings() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [saved, setSaved] = useState<FileWriting | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const apply = useJobPoll<JobStatus<unknown> & { written: number; failed: number }>(`${APPLY}/status`);
  const applyStatus = apply.status;

  useEffect(() => {
    api.get("/settings/file-writing").then(setSaved).catch(ignore("Couldn't load the file writing settings"));
  }, []);

  async function save(patch: Partial<FileWriting>): Promise<boolean> {
    setSaving(true);
    setError(null);
    try {
      setSaved(await api.put("/settings/file-writing", patch));
      return true;
    } catch (err) {
      setError(errorMessage(err, t("fileWriting.saveFailed")));
      return false;
    } finally {
      setSaving(false);
    }
  }

  // Turning linked folders on first counts what it would write, and writes only once confirmed.
  async function setLinked(next: boolean) {
    if (!next) return void save({ linkedFolders: false });
    setError(null);
    let preview;
    try {
      preview = await api.get("/settings/file-writing/linked-preview");
    } catch (err) {
      setError(errorMessage(err, t("fileWriting.linked.previewFailed")));
      return;
    }
    if (preview.files > 0) {
      const lines = [
        t("fileWriting.linked.confirm.create", { count: preview.create }),
        preview.update > 0 && t("fileWriting.linked.confirm.update", { count: preview.update }),
        preview.skip > 0 && t("fileWriting.linked.confirm.skip", { count: preview.skip }),
        preview.unavailable > 0 && t("fileWriting.linked.confirm.unavailable", { count: preview.unavailable }),
      ].filter(Boolean);
      const ok = await confirm({
        title: t("fileWriting.linked.confirm.title"),
        message: (
          <ul className="list-disc space-y-1 pl-5">
            {lines.map((line) => (
              <li key={String(line)}>{line}</li>
            ))}
          </ul>
        ),
        confirmLabel: t("fileWriting.linked.confirm.action"),
      });
      if (!ok) return;
    }
    if ((await save({ linkedFolders: true })) && preview.files > 0)
      await apply.start(apiPath(APPLY, {}, { background: "1" }));
  }

  if (!saved) return null;
  return (
    <SettingsGroup title={t("fileWriting.title")}>
      <SettingRow
        label={t("fileWriting.sidecarNames.label")}
        description={t("fileWriting.sidecarNames.description")}
        control={
          <Select
            aria-label={t("fileWriting.sidecarNames.label")}
            value={saved.sidecarNames}
            disabled={saving}
            onChange={(e) => void save({ sidecarNames: e.target.value as SidecarNames })}
          >
            {(Object.keys(NAME_LABEL) as SidecarNames[]).map((n) => (
              <option key={n} value={n}>
                {t(NAME_LABEL[n])}
              </option>
            ))}
          </Select>
        }
      />
      <SettingRow
        label={t("fileWriting.insideFiles.label")}
        description={t("fileWriting.insideFiles.description")}
        control={
          <div className="flex items-center gap-2">
            <InfoTip
              align="right"
              paragraphs={[t("fileWriting.insideFiles.help.changes"), t("fileWriting.insideFiles.help.sidecar")]}
            />
            <Switch
              label={t("fileWriting.insideFiles.label")}
              checked={saved.insideFiles}
              disabled={saving}
              onChange={(next) => void save({ insideFiles: next })}
            />
          </div>
        }
      />
      <SettingRow
        label={t("fileWriting.linked.label")}
        description={t("fileWriting.linked.description")}
        control={
          <div className="flex items-center gap-2">
            <InfoTip align="right" paragraphs={[t("fileWriting.linked.help")]} />
            <Switch
              label={t("fileWriting.linked.label")}
              checked={saved.linkedFolders}
              disabled={saving}
              onChange={(next) => void setLinked(next)}
            />
          </div>
        }
      >
        {error && <FormMessage error={error} />}
      </SettingRow>
      <SettingRow
        label={t("fileWriting.apply.label")}
        description={t("fileWriting.apply.description")}
        control={
          !applyStatus?.running && (
            <Button
              variant="secondary"
              size="sm"
              loading={apply.starting}
              onClick={() => void apply.start(apiPath(APPLY, {}, { background: "1" }))}
            >
              {t("fileWriting.apply.action")}
            </Button>
          )
        }
      >
        {applyStatus?.running && (
          <JobProgress
            compact
            status={applyStatus}
            fallbackLabel={t("fileWriting.apply.running")}
            onCancel={() => apply.cancel(`${APPLY}/cancel`)}
            cancelling={apply.cancelling}
          />
        )}
        {!applyStatus?.running && applyStatus?.finishedAt != null && !applyStatus.error && (
          <>
            <FormMessage
              success={t(applyStatus.cancelled ? "fileWriting.apply.stopped" : "fileWriting.apply.result", {
                count: applyStatus.written,
              })}
            />
            {applyStatus.failed > 0 && (
              <FormMessage error={t("fileWriting.apply.failedFiles", { count: applyStatus.failed })} />
            )}
          </>
        )}
        <FormMessage error={applyStatus?.error ? t("fileWriting.apply.failed") : (apply.actionError ?? null)} />
      </SettingRow>
    </SettingsGroup>
  );
}
