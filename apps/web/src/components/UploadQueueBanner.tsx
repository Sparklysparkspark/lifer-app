import { useTranslation } from "react-i18next";
import { useUploadQueue, resolveDuplicate } from "../lib/uploadQueue";
import { formatDate } from "../lib/format";
import InlineSpinner from "./InlineSpinner";
import Modal from "./Modal";
import Button from "./Button";
import ProgressBar from "./ProgressBar";

// Rendered on every page (positioned by StatusTray), since uploads keep running in the background
// after the page that started them closes.
export default function UploadQueueBanner() {
  const { t } = useTranslation();
  const { jobs, targetsExternalDrive, justFinishedAt, pendingDuplicates } = useUploadQueue();
  // One prompt at a time; the rest wait their turn in the queue.
  const pendingDuplicate = pendingDuplicates[0] ?? null;
  const inProgress = jobs.filter((j) => !j.done).length;
  const failed = jobs.filter((j) => j.done && j.error).length;
  const skipped = jobs.filter((j) => j.skipped).length;
  // The queue clears justFinishedAt itself after a few seconds (lib/uploadQueue.ts).
  const justFinished = jobs.length === 0 && justFinishedAt != null;
  // Bytes across the files whose uploads report a size; a finished file counts as fully sent.
  const sized = jobs.filter((j) => j.totalBytes);
  const totalBytes = sized.reduce((sum, j) => sum + j.totalBytes!, 0);
  const sentBytes = sized.reduce((sum, j) => sum + (j.done ? j.totalBytes! : (j.sentBytes ?? 0)), 0);
  const uploadFraction = totalBytes > 0 && sentBytes < totalBytes ? sentBytes / totalBytes : null;
  const takenOn = pendingDuplicate ? formatDate(pendingDuplicate.info.takenAt, "short") : "";

  return (
    <>
      {(jobs.length > 0 || justFinished) && (
        <div className="flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-muted shadow-sm">
          {jobs.length > 0 ? (
            <>
              <InlineSpinner tone="ink" />
              <span>
                {t("upload.banner.uploading", { done: jobs.length - inProgress, total: jobs.length, failed, skipped })}
              </span>
              {uploadFraction != null && (
                <ProgressBar value={uploadFraction} size="xs" tone="ink" label={t("upload.banner.progressLabel")} className="w-20" />
              )}
              {targetsExternalDrive && (
                <span className="font-medium text-amber-700 dark:text-amber-400">{t("upload.banner.keepDrive")}</span>
              )}
            </>
          ) : (
            <span>{t("upload.banner.finished")}</span>
          )}
        </div>
      )}

      {/* Escape takes the safe answer (Skip); the backdrop does nothing. No Enter default: both are real choices. */}
      <Modal
        key={pendingDuplicate?.jobId}
        open={!!pendingDuplicate}
        onClose={() => pendingDuplicate && resolveDuplicate(pendingDuplicate.jobId, "skip")}
        dismissOnBackdrop={false}
        title={
          <>
            {t("upload.duplicate.title")}
            {pendingDuplicates.length > 1 && (
              <span className="ml-2 font-normal text-muted">
                {t("upload.duplicate.position", { total: pendingDuplicates.length })}
              </span>
            )}
          </>
        }
        footer={
          pendingDuplicate && (
            <>
              <Button variant="secondary" size="sm" onClick={() => resolveDuplicate(pendingDuplicate.jobId, "skip")}>
                {t("upload.duplicate.skip")}
              </Button>
              <Button size="sm" onClick={() => resolveDuplicate(pendingDuplicate.jobId, "import")}>
                {t("upload.duplicate.importAnyway")}
              </Button>
            </>
          )
        }
      >
        {pendingDuplicate && (
          <p className="text-sm text-muted">
            {takenOn
              ? t("upload.duplicate.messageWithDate", {
                  fileName: pendingDuplicate.fileName,
                  species: pendingDuplicate.info.speciesName,
                  date: takenOn,
                })
              : t("upload.duplicate.message", {
                  fileName: pendingDuplicate.fileName,
                  species: pendingDuplicate.info.speciesName,
                })}
          </p>
        )}
      </Modal>
    </>
  );
}
