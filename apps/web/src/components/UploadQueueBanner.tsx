import { useUploadQueue, resolveDuplicate } from "../lib/uploadQueue";

// Same fixed-position, render-on-every-page pattern as MigrationStatusIndicator — uploads are
// enqueued from whichever species page happens to be open and keep running in the background
// (see lib/uploadQueue.ts), so this needs to stay visible after that page's own dialog closes
// or the user navigates elsewhere entirely.
export default function UploadQueueBanner() {
  const { jobs, targetsExternalDrive, justFinishedAt, pendingDuplicate } = useUploadQueue();
  const inProgress = jobs.filter((j) => !j.done).length;
  const failed = jobs.filter((j) => j.done && j.error).length;
  const skipped = jobs.filter((j) => j.skipped).length;
  const justFinished = jobs.length === 0 && justFinishedAt != null && Date.now() - justFinishedAt < 6000;

  return (
    <>
      {(jobs.length > 0 || justFinished) && (
        <div className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-muted shadow-sm">
          {jobs.length > 0 ? (
            <>
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-line border-t-ink" />
              <span>
                Uploading… {jobs.length - inProgress}/{jobs.length}
                {failed > 0 ? ` (${failed} failed)` : ""}
                {skipped > 0 ? ` (${skipped} skipped)` : ""}
              </span>
              {targetsExternalDrive && <span className="font-medium text-amber-700">Don't unplug the drive yet</span>}
            </>
          ) : (
            <span>Upload finished</span>
          )}
        </div>
      )}

      {pendingDuplicate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-xl border border-line bg-surface p-5">
            <h2 className="text-sm font-semibold text-ink">Possible duplicate</h2>
            <p className="mt-2 text-sm text-muted">
              "{pendingDuplicate.fileName}" looks like a photo you already have of {pendingDuplicate.info.speciesName}
              {pendingDuplicate.info.takenAt ? ` from ${new Date(pendingDuplicate.info.takenAt).toLocaleDateString()}` : ""}.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => resolveDuplicate(pendingDuplicate.jobId, "skip")}
                className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-surface-muted"
              >
                Skip
              </button>
              <button
                type="button"
                onClick={() => resolveDuplicate(pendingDuplicate.jobId, "import")}
                className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg"
              >
                Import anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
