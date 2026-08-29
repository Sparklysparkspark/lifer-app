import { useUploadQueue } from "../lib/uploadQueue";

// Same fixed-position, render-on-every-page pattern as MigrationStatusIndicator — uploads are
// enqueued from whichever species page happens to be open and keep running in the background
// (see lib/uploadQueue.ts), so this needs to stay visible after that page's own dialog closes
// or the user navigates elsewhere entirely.
export default function UploadQueueBanner() {
  const { jobs, targetsExternalDrive, justFinishedAt } = useUploadQueue();
  const inProgress = jobs.filter((j) => !j.done).length;
  const failed = jobs.filter((j) => j.done && j.error).length;
  const justFinished = jobs.length === 0 && justFinishedAt != null && Date.now() - justFinishedAt < 6000;

  if (jobs.length === 0 && !justFinished) return null;

  return (
    <div className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-muted shadow-sm">
      {jobs.length > 0 ? (
        <>
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-line border-t-ink" />
          <span>
            Uploading… {jobs.length - inProgress}/{jobs.length}
            {failed > 0 ? ` (${failed} failed)` : ""}
          </span>
          {targetsExternalDrive && <span className="font-medium text-amber-700">Don't unplug the drive yet</span>}
        </>
      ) : (
        <span>Upload finished</span>
      )}
    </div>
  );
}
