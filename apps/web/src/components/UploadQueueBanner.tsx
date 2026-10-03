import { useUploadQueue, resolveDuplicate } from "../lib/uploadQueue";
import { formatDate } from "../lib/formatDate";
import InlineSpinner from "./InlineSpinner";
import Modal from "./Modal";
import Button from "./Button";
import ProgressBar from "./ProgressBar";

// Rendered on every page (positioned by StatusTray), since uploads keep running in the background
// after the page that started them closes.
export default function UploadQueueBanner() {
  const { jobs, targetsExternalDrive, justFinishedAt, pendingDuplicates } = useUploadQueue();
  // One prompt at a time; the rest wait their turn in the queue.
  const pendingDuplicate = pendingDuplicates[0] ?? null;
  const inProgress = jobs.filter((j) => !j.done).length;
  const failed = jobs.filter((j) => j.done && j.error).length;
  const skipped = jobs.filter((j) => j.skipped).length;
  const justFinished = jobs.length === 0 && justFinishedAt != null && Date.now() - justFinishedAt < 6000;
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
                Uploading… {jobs.length - inProgress}/{jobs.length}
                {failed > 0 ? ` (${failed} failed)` : ""}
                {skipped > 0 ? ` (${skipped} skipped)` : ""}
              </span>
              {uploadFraction != null && <ProgressBar value={uploadFraction} size="xs" tone="ink" label="Upload progress" className="w-20" />}
              {targetsExternalDrive && <span className="font-medium text-amber-700 dark:text-amber-400">Don't unplug the drive yet</span>}
            </>
          ) : (
            <span>Upload finished</span>
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
            Possible duplicate
            {pendingDuplicates.length > 1 && <span className="ml-2 font-normal text-muted">(1 of {pendingDuplicates.length})</span>}
          </>
        }
        footer={
          pendingDuplicate && (
            <>
              <Button variant="secondary" size="sm" onClick={() => resolveDuplicate(pendingDuplicate.jobId, "skip")}>
                Skip
              </Button>
              <Button size="sm" onClick={() => resolveDuplicate(pendingDuplicate.jobId, "import")}>
                Import anyway
              </Button>
            </>
          )
        }
      >
        {pendingDuplicate && (
          <p className="text-sm text-muted">
            "{pendingDuplicate.fileName}" looks like a photo you already have of {pendingDuplicate.info.speciesName}
            {takenOn ? ` from ${takenOn}` : ""}.
          </p>
        )}
      </Modal>
    </>
  );
}
