import { useState } from "react";
import { CLIENT_HEADER } from "../../api/client";
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
      const res = await fetch(`/api/stats/export.csv?filter=${filter}`, {
        credentials: "same-origin",
        headers: CLIENT_HEADER,
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const csv = await res.text();
      const filename = statsCsvFilename(filter, new Date());

      if (window.liferSetup) {
        // Desktop: a native Save As dialog.
        const { save } = await import("@tauri-apps/plugin-dialog");
        const { writeTextFile } = await import("@tauri-apps/plugin-fs");
        const path = await save({ defaultPath: filename, filters: [{ name: "CSV", extensions: ["csv"] }] });
        if (!path) return; // user cancelled the dialog
        await writeTextFile(path, csv);
      } else {
        const blob = new Blob([csv], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        // Revoking right away can cancel the download before the browser reads the blob.
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Couldn't export stats");
    } finally {
      setExporting(false);
    }
  }

  return { exporting, exportError, exportCsv, bucketDownloading, downloadBucket };
}
