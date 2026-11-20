import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import JobProgress, { type PhaseLabels } from "../../components/JobProgress";
import FormMessage from "../../components/FormMessage";
import type { TripScanImport } from "./useTripScanImport";
import type { ImportStatus } from "./types";

const scanPhases = (t: TFunction): PhaseLabels => ({
  checking: { label: t("trips.jobs.checking"), progress: "count" },
  recovering: { label: t("trips.jobs.recovering"), progress: "count" },
  "finding-new": { label: t("trips.jobs.findingNew"), progress: "count" },
  "reading-cull-marks": { label: t("trips.jobs.readingCullMarks"), progress: "count" },
  "linking-raws": { label: t("trips.jobs.linkingRaws"), progress: "count" },
});
const importPhases = (t: TFunction): PhaseLabels => ({
  importing: { label: t("trips.jobs.importing"), progress: "count" },
});

// What the culling marks did to a finished import, if anything.
function importOutcome(status: ImportStatus, t: TFunction): string | null {
  const skipped = status.result?.skipped ?? 0;
  const hidden = status.result?.hidden ?? 0;
  const parts = [
    skipped > 0 && t("trips.jobs.cullSkipped", { count: skipped }),
    hidden > 0 && t("trips.jobs.cullHidden", { count: hidden }),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}

// Errors and progress for the folder scan and the import, and what a finished scan found.
export default function TripJobStatus({ tripId, jobs }: { tripId: string | undefined; jobs: TripScanImport }) {
  const { t } = useTranslation();
  const { scanJob, scanStatus, scanning, importJob, importStatus } = jobs;
  return (
    <>
      <FormMessage error={jobs.relocateError ?? scanJob.actionError ?? importJob.actionError} />
      {scanStatus?.running && (
        <JobProgress
          status={scanStatus}
          phases={scanPhases(t)}
          fallbackLabel={t("trips.detail.scanning")}
          onCancel={() => void scanJob.cancel(`/trips/${tripId}/scan/cancel`)}
          cancelling={scanJob.cancelling}
        />
      )}
      {importStatus?.running && (
        <JobProgress
          status={importStatus}
          phases={importPhases(t)}
          onCancel={() => void importJob.cancel(`/trips/${tripId}/import/cancel`)}
          cancelling={importJob.cancelling}
        />
      )}
      {jobs.importRequested &&
        importStatus &&
        !importStatus.running &&
        importStatus.finishedAt &&
        importOutcome(importStatus, t) && (
          <p className="text-callout text-muted" data-testid="cull-import-outcome">
            {importOutcome(importStatus, t)}
          </p>
        )}
      {scanStatus && !scanning && scanStatus.finishedAt && jobs.scannedCount === 0 && (
        <p className="text-callout text-muted">
          {scanStatus.cancelled
            ? t("trips.jobs.scanCancelled")
            : scanStatus.recovered === 0 &&
                scanStatus.relinked === 0 &&
                scanStatus.markedStale === 0 &&
                scanStatus.rawsLinked === 0
              ? t("trips.jobs.noNewPhotos")
              : ""}
          {scanStatus.recovered > 0 && ` ${t("trips.jobs.recovered", { count: scanStatus.recovered })}`}
          {scanStatus.relinked > 0 && ` ${t("trips.jobs.relinked", { count: scanStatus.relinked })}`}
          {scanStatus.markedStale > 0 && ` ${t("trips.jobs.markedStale", { count: scanStatus.markedStale })}`}
          {scanStatus.rawsLinked > 0 && ` ${t("trips.jobs.rawsLinked", { count: scanStatus.rawsLinked })}`}
          {scanStatus.error && <span className="text-rose-700 dark:text-rose-400"> {scanStatus.error}</span>}
        </p>
      )}
    </>
  );
}
