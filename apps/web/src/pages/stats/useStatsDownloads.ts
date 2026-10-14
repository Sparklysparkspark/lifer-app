import { useState } from "react";
import { downloadFile } from "../../lib/downloadFile";
import { statsCsvFilename } from "./statsHelpers";
import type { PhotoFilter } from "./types";

// The CSV export, and downloading every photo behind an EXIF bar. Both report into one error line.
export function useStatsDownloads(filter: PhotoFilter) {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [bucketDownloading, setBucketDownloading] = useState(false);

  async function downloadBucket(photoIds: string[]) {
    setBucketDownloading(true);
    try {
      for (const id of photoIds) {
        await downloadFile(`/api/photos/${id}/original?download=1`, `${id}.jpg`);
      }
    } catch {
      setExportError("Couldn't download every photo. Try again.");
    } finally {
      setBucketDownloading(false);
    }
  }

  async function exportCsv() {
    setExporting(true);
    setExportError(null);
    try {
      const filename = statsCsvFilename(filter, new Date());
      await downloadFile(`/api/stats/export.csv?filter=${filter}`, filename, { filename });
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Couldn't export stats");
    } finally {
      setExporting(false);
    }
  }

  return { exporting, exportError, exportCsv, bucketDownloading, downloadBucket };
}
