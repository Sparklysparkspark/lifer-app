import JobProgress, { type PhaseLabels } from "../../components/JobProgress";
import FormMessage from "../../components/FormMessage";
import { pluralize } from "../../lib/pluralize";
import type { TripScanImport } from "./useTripScanImport";
import type { ImportStatus } from "./types";

const SCAN_PHASES: PhaseLabels = {
  checking: { label: "Checking known photos", progress: "count" },
  recovering: { label: "Recovering photos", progress: "count" },
  "finding-new": { label: "Finding new photos in the trip folder", progress: "count" },
  "reading-cull-marks": { label: "Reading marks from your culling app", progress: "count" },
  "linking-raws": { label: "Linking RAW files", progress: "count" },
};
const IMPORT_PHASES: PhaseLabels = { importing: { label: "Importing photos", progress: "count" } };

// What the culling marks did to a finished import, if anything.
function importOutcome(status: ImportStatus): string | null {
  const skipped = status.result?.skipped ?? 0;
  const hidden = status.result?.hidden ?? 0;
  const parts = [
    skipped > 0 && `${pluralize(skipped, "photo")} rejected in your culling app skipped.`,
    hidden > 0 && `${pluralize(hidden, "photo")} rejected in your culling app imported hidden.`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}

// Errors and progress for the folder scan and the import, and what a finished scan found.
export default function TripJobStatus({ tripId, jobs }: { tripId: string | undefined; jobs: TripScanImport }) {
  const { scanJob, scanStatus, scanning, importJob, importStatus } = jobs;
  return (
    <>
      <FormMessage error={jobs.relocateError ?? scanJob.actionError ?? importJob.actionError} />
      {scanStatus?.running && (
        <JobProgress
          status={scanStatus}
          phases={SCAN_PHASES}
          fallbackLabel="Looking for photos…"
          onCancel={() => void scanJob.cancel(`/trips/${tripId}/scan/cancel`)}
          cancelling={scanJob.cancelling}
        />
      )}
      {importStatus?.running && (
        <JobProgress
          status={importStatus}
          phases={IMPORT_PHASES}
          onCancel={() => void importJob.cancel(`/trips/${tripId}/import/cancel`)}
          cancelling={importJob.cancelling}
        />
      )}
      {jobs.importRequested &&
        importStatus &&
        !importStatus.running &&
        importStatus.finishedAt &&
        importOutcome(importStatus) && (
          <p className="text-sm text-muted" data-testid="cull-import-outcome">
            {importOutcome(importStatus)}
          </p>
        )}
      {scanStatus && !scanning && scanStatus.finishedAt && jobs.scannedCount === 0 && (
        <p className="text-sm text-muted">
          {scanStatus.cancelled
            ? "Scan cancelled."
            : scanStatus.recovered === 0 &&
                scanStatus.relinked === 0 &&
                scanStatus.markedStale === 0 &&
                scanStatus.rawsLinked === 0
              ? "No new photos found."
              : ""}
          {scanStatus.recovered > 0 && ` ${pluralize(scanStatus.recovered, "photo")} automatically recovered.`}
          {scanStatus.relinked > 0 && ` ${pluralize(scanStatus.relinked, "moved file")} relinked.`}
          {scanStatus.markedStale > 0 && ` ${scanStatus.markedStale} missing (kept, marked stale).`}
          {scanStatus.rawsLinked > 0 && ` ${pluralize(scanStatus.rawsLinked, "RAW file")} linked.`}
          {scanStatus.error && <span className="text-rose-700 dark:text-rose-400"> {scanStatus.error}</span>}
        </p>
      )}
    </>
  );
}
