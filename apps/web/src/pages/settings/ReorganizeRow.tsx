import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { JobStatus } from "@lifer/shared";
import Button from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import JobProgress from "../../components/JobProgress";
import { useConfirm } from "../../hooks/useConfirm";
import { useJobPoll } from "../../hooks/useJobPoll";
import { SettingRow } from "./shared";

type ReorganizeStatus = JobStatus<{ moved: number; skipped: number; failed: number; total: number }>;
const BASE = "/settings/reorganize-originals";

/** "Reorganize existing photos": one background job shared by Library and Species and import, so
 *  leaving the page keeps it running and coming back shows its progress. */
export default function ReorganizeRow({
  description,
  confirmMessage,
}: {
  description: string;
  confirmMessage: string;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [result, setResult] = useState<string | null>(null);
  const job = useJobPoll<ReorganizeStatus>(`${BASE}/status`, {
    onFinish: (s) =>
      s.result && !s.error && !s.cancelled && setResult(t("settings.library.reorganizeResult", s.result)),
  });
  const running = !!job.status?.running;

  async function start() {
    const ok = await confirm({
      title: t("settings.library.reorganizeConfirm.title"),
      message: confirmMessage,
      confirmLabel: t("settings.library.reorganize"),
    });
    if (!ok) return;
    setResult(null);
    await job.start(`${BASE}?background=1`);
  }

  return (
    <SettingRow
      label={t("settings.library.reorganizeLabel")}
      description={description}
      control={
        !running && (
          <Button variant="secondary" size="sm" onClick={() => void start()} loading={job.starting}>
            {t("settings.library.reorganize")}
          </Button>
        )
      }
    >
      <JobProgress
        status={job.status}
        fallbackLabel={t("settings.library.reorganizing")}
        onCancel={() => void job.cancel(`${BASE}/cancel`)}
        cancelling={job.cancelling}
        error={job.status?.error ? t("settings.library.reorganizeFailed") : job.actionError}
      />
      {result && <FormMessage success={result} />}
    </SettingRow>
  );
}
