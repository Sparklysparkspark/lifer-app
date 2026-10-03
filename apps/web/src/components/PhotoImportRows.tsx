import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { errorMessage } from "../lib/errorMessage";
import { mapWithConcurrency } from "../lib/concurrency";
import { postUploadedFile, registerExternalJob, reportJobProgress, settleExternalJob, suggestSpeciesFromVideo, type PossibleDuplicate } from "../lib/uploadQueue";
import { discardUpload, uploadFile } from "../lib/tusUpload";
import SpeciesPicker, { type SuggestedSpecies } from "./SpeciesPicker";
import RegionBrowser from "./RegionBrowser";
import Lightbox from "./Lightbox";
import ImportReviewRow from "./importReview/ImportReviewRow";
import { useImportReview, type ReviewRowBase } from "./importReview/useImportReview";
import { useSpeciesGallery } from "./importReview/useSpeciesGallery";
import { isRawFile, VENDOR_RAW_EXTENSIONS } from "../lib/rawExtensions";
import { isBrowserDisplayable, isVideoFile, photoFormatOf, PHOTO_ACCEPT, VIDEO_ACCEPT } from "../lib/photoFormats";
import { computeClientVectors, recordServerMatching, shouldMatchLocally, prepareLocalInference, useLocalInferenceReady } from "../lib/localInference";
import { useSettings } from "../hooks/useSettings";
import { pluralize, pluralWord } from "../lib/pluralize";
import Button from "./Button";
import ProgressBar from "./ProgressBar";

// Shared with CollectionPage, so the last region picked in either place is the default in both.
const LAST_REGION_KEY = "lifer:lastRegionId";

// Species suggestions are one-click only; nothing is ever assigned automatically.
type RowStatus = "pending" | "ready" | "uploading" | "done" | "error";

interface ImportRow extends ReviewRowBase {
  file: File;
  previewUrl: string;
  status: RowStatus;
  captureId?: string;
  error?: string;
  /** Browsers can't render RAW, TIFF or HEIC (previewFromServer), so rawPreviewUrl holds the JPEG
   *  preview from /uploads/inspect. `undefined` = not checked yet, `null` = the file has none. */
  isRaw?: boolean;
  previewFromServer?: boolean;
  rawPreviewUrl?: string | null;
  /** The finished resumable upload of this file; the check and the import both use it. */
  uploadId?: string | null;
  /** 0..1 while this file's upload is in flight. */
  uploadProgress?: number | null;
  /** The upload itself failed before import (too large for the server, connection lost). */
  uploadError?: string;
  /** The server's kept copy of a video from the species check (see uploadQueue.ts postUploadedFile). */
  stagedId?: string | null;
  /** Imports via /uploads/video and gets suggestions from sampled frames; no duplicate check. */
  isVideo?: boolean;
}

const UPLOAD_CONCURRENCY = 2;
// Inspect runs server-side inference, so a big drop shouldn't queue dozens at once.
const INSPECT_CONCURRENCY = 2;

// Batch import: drop files, assign a species to each (or bulk-assign a selection), then import.
// Used by BulkImportPage, TripDetailPage and AlbumDetailPage; tripId/albumId go straight to /uploads.
export default function PhotoImportRows({
  tripId,
  albumId,
  onImported,
  onImportStarted,
}: {
  tripId?: string;
  /** Links each new capture into this album. Unlike tripId, it never changes where files are stored. */
  albumId?: string;
  onImported?: () => void;
  /** Called once the uploads have started, with whether that covers every row here. Uploads
   *  continue in the background if the page is left. */
  onImportStarted?: (everyRowIncluded: boolean) => void;
}) {
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [importing, setImporting] = useState(false);
  const [lastBatch, setLastBatch] = useState<Array<{ key: string; captureId: string }>>([]);
  // Row previews are local blob URLs, so the lightbox needs no fetch.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  // Every reference photo of a candidate species, for comparing against the new photo.
  const speciesGallery = useSpeciesGallery();

  // One upload per row, shared by the check and the import so the file is sent once.
  const uploadsRef = useRef(new Map<string, Promise<string>>());
  // Each row's latest check: changing region re-checks every row, and an older check's answer
  // arriving last mustn't replace the new region's.
  const inspectGenerations = useRef(new Map<string, number>());
  const startInspect = (key: string) => {
    const gen = (inspectGenerations.current.get(key) ?? 0) + 1;
    inspectGenerations.current.set(key, gen);
    return () => inspectGenerations.current.get(key) === gen;
  };
  const uploadAbortsRef = useRef(new Map<string, AbortController>());
  // Banner job per importing row, so an upload still in flight at import time shows its bytes there.
  const rowJobsRef = useRef(new Map<string, string>());
  // Set synchronously in importAll: rowsRef can lag a render behind when the page navigates away.
  const importingKeysRef = useRef(new Set<string>());
  const progressPctRef = useRef(new Map<string, number>());

  function setRowProgress(key: string, sent: number, total: number) {
    const jobId = rowJobsRef.current.get(key);
    if (jobId) reportJobProgress(jobId, sent, total);
    // Whole-percent steps only: tus reports progress many times a second.
    const pct = total > 0 ? Math.floor((sent / total) * 100) : 0;
    if (progressPctRef.current.get(key) === pct) return;
    progressPctRef.current.set(key, pct);
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, uploadProgress: pct >= 100 ? null : pct / 100 } : r)));
  }

  function ensureUploaded(key: string, file: File): Promise<string> {
    const existing = uploadsRef.current.get(key);
    if (existing) return existing;
    const controller = new AbortController();
    uploadAbortsRef.current.set(key, controller);
    const promise = uploadFile(file, { signal: controller.signal, onProgress: (sent, total) => setRowProgress(key, sent, total) })
      .then((uploadId) => {
        setRows((prev) => prev.map((r) => (r.key === key ? { ...r, uploadId, uploadProgress: null, uploadError: undefined } : r)));
        return uploadId;
      })
      .catch((err: unknown) => {
        uploadsRef.current.delete(key);
        if (!controller.signal.aborted) {
          const uploadError = err instanceof Error ? err.message : "Upload failed";
          setRows((prev) => prev.map((r) => (r.key === key ? { ...r, uploadProgress: null, uploadError } : r)));
        }
        throw err;
      })
      .finally(() => {
        uploadAbortsRef.current.delete(key);
        progressPctRef.current.delete(key);
      });
    uploadsRef.current.set(key, promise);
    return promise;
  }

  // Stops (or deletes on the server) the upload of a row that will never be imported.
  function dropUpload(key: string, uploadId: string | null | undefined) {
    uploadAbortsRef.current.get(key)?.abort();
    uploadsRef.current.delete(key);
    if (uploadId) discardUpload(uploadId);
  }

  // Blob URLs outlive the component, so revoke whatever rows remain on unmount. Uploads of rows
  // not being imported stop too; the importing ones carry on in the background.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  useEffect(() => {
    return () => {
      for (const row of rowsRef.current) {
        URL.revokeObjectURL(row.previewUrl);
        if (!importingKeysRef.current.has(row.key) && !row.captureId) dropUpload(row.key, row.uploadId);
      }
    };
  }, []);

  // Suggestions are skipped entirely (not just hidden) unless the setting is on.
  const suggestEnabled = useSettings().settings?.speciesSuggestEnabled ?? false;

  // Region narrows the suggestion candidates; picked once per batch rather than guessed from GPS.
  const [regionId, setRegionId] = useState<string | null>(() => localStorage.getItem(LAST_REGION_KEY));

  // One free-text place name per batch; not persisted like the region.
  const [locationLabel, setLocationLabel] = useState("");

  // In the desktop app connected to a server, photos can be matched on this computer instead.
  const localMatching = useLocalInferenceReady();
  useEffect(() => prepareLocalInference(), []);

  // Loads the models and this region's candidate set before the first photo arrives. Best-effort.
  useEffect(() => {
    if (!suggestEnabled || !regionId) return;
    const timer = setTimeout(() => {
      api.post("/species/matching/warm", { regionId }).catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [suggestEnabled, regionId]);

  function selectRegion(id: string | null) {
    setRegionId(id);
    if (id) localStorage.setItem(LAST_REGION_KEY, id);
    else localStorage.removeItem(LAST_REGION_KEY);
    if (id && suggestEnabled) {
      // Re-inspect every row not yet imported, for a region picked or changed mid-batch.
      const pending = rows.filter((r) => !r.captureId);
      mapWithConcurrency(pending, INSPECT_CONCURRENCY, async (row) =>
        row.isVideo ? inspectVideoFile(row.key, row.file, id) : inspectFile(row.key, row.file, id),
      );
    }
  }

  function addFiles(fileList: FileList | File[]) {
    // RAW and HEIC files often have an empty MIME type, so those match by extension. Anything the
    // server wouldn't take (a GIF in a picked folder) is left out.
    const files = Array.from(fileList).filter((f) => photoFormatOf(f) != null || isRawFile(f.name) || isVideoFile(f));
    const newRows: ImportRow[] = files.map((file) => ({
      key: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`,
      file,
      previewUrl: URL.createObjectURL(file),
      speciesId: null,
      speciesLabel: null,
      status: "ready",
      suggestions: [],
      isRaw: isRawFile(file.name),
      previewFromServer: isRawFile(file.name) || (!isVideoFile(file) && !isBrowserDisplayable(file)),
      isVideo: isVideoFile(file),
      isInspecting: true,
    }));
    setRows((prev) => [...prev, ...newRows]);
    mapWithConcurrency(newRows, INSPECT_CONCURRENCY, async (row) =>
      row.isVideo
        ? inspectVideoFile(row.key, row.file, suggestEnabled ? regionId : null)
        : inspectFile(row.key, row.file, suggestEnabled ? regionId : null),
    );
  }

  // One /uploads/inspect call does the duplicate check and, given a region, suggestions, so the
  // file is embedded once. Best-effort: a failure never blocks assigning a species by hand.
  async function inspectFile(key: string, file: File, forRegionId: string | null) {
    const isLatest = startInspect(key);
    try {
      // RAW, TIFF and HEIC are matched on the server's decoded preview, which only it makes.
      const local = !isRawFile(file.name) && isBrowserDisplayable(file) && shouldMatchLocally();
      const vectorsPromise = local ? computeClientVectors(file) : Promise.resolve(null);
      const inspect = async (uploadId: string) => {
        const form = new FormData();
        form.append("uploadId", uploadId);
        if (forRegionId) form.append("regionId", forRegionId);
        const clientVectors = await vectorsPromise;
        if (clientVectors) form.append("clientVectors", clientVectors);
        return api.post<{
          possibleDuplicate: PossibleDuplicate | null;
          suggestions: SuggestedSpecies[];
          burst?: { uploadIds: string[]; suggestions: SuggestedSpecies[] } | null;
          matchingMs?: number | null;
          previewDataUrl: string | null;
          notWildlife?: { looksLike: string } | null;
        }>("/uploads/inspect", form);
      };
      let res;
      try {
        res = await inspect(await ensureUploaded(key, file));
      } catch (err) {
        // 410: the server dropped the upload (expired), so send the file again once.
        if (!(err instanceof ApiError && err.status === 410)) throw err;
        uploadsRef.current.delete(key);
        res = await inspect(await ensureUploaded(key, file));
      }
      // Other frames of the same burst get the ranking pooled from all of them, keeping a species
      // their own keywords named on top.
      if (res.matchingMs != null) recordServerMatching(res.matchingMs);
      if (!isLatest()) return;
      const burst = res.burst;
      const mates = new Set(burst?.uploadIds ?? []);
      const pooledFor = (own: SuggestedSpecies[]): SuggestedSpecies[] => {
        const keyword = own[0]?.source === "keyword_tag" ? own[0] : null;
        return keyword ? [keyword, ...burst!.suggestions.filter((s) => s.id !== keyword.id)] : burst!.suggestions;
      };
      setRows((prev) =>
        prev.map((r) =>
          r.key !== key && r.uploadId && mates.has(r.uploadId) && !r.isInspecting
            ? { ...r, suggestions: pooledFor(r.suggestions) }
            : r.key === key
            ? {
                ...r,
                possibleDuplicate: res.possibleDuplicate,
                suggestions: res.suggestions,
                rawPreviewUrl: res.previewDataUrl,
                notWildlife: res.notWildlife ?? null,
                isInspecting: false,
              }
            : r,
        ),
      );
    } catch {
      if (isLatest()) setRows((prev) => prev.map((r) => (r.key === key ? { ...r, isInspecting: false } : r)));
    }
  }

  // Video version: suggestions from frames sampled across the clip, no duplicate check. Sent
  // once as a resumable upload that the import then reuses; a 410 resends it once.
  async function inspectVideoFile(key: string, file: File, forRegionId: string | null) {
    const isLatest = startInspect(key);
    try {
      const upload = (fresh: boolean) => {
        if (fresh) uploadsRef.current.delete(key);
        return ensureUploaded(key, file);
      };
      const res = await suggestSpeciesFromVideo<{ suggestions: SuggestedSpecies[]; error?: string; stagedId?: string | null }>(upload, forRegionId);
      if (!isLatest()) return;
      setRows((prev) =>
        prev.map((r) =>
          r.key === key ? { ...r, suggestions: res.suggestions, suggestError: res.error, stagedId: res.stagedId ?? null, isInspecting: false } : r,
        ),
      );
    } catch (err) {
      console.error(err);
      if (!isLatest()) return;
      setRows((prev) =>
        prev.map((r) => (r.key === key ? { ...r, suggestError: errorMessage(err, "Couldn't analyze this video"), isInspecting: false } : r)),
      );
    }
  }

  function removeRow(key: string) {
    setRows((prev) => {
      const row = prev.find((r) => r.key === key);
      if (row) URL.revokeObjectURL(row.previewUrl);
      return prev.filter((r) => r.key !== key);
    });
    const removed = rows.find((r) => r.key === key);
    if (removed && !removed.captureId) dropUpload(key, removed.uploadId);
    review.forgetRow(key);
  }

  const readyRows = rows.filter((r) => r.speciesId && r.status === "ready");
  const readyCount = readyRows.length;

  const review = useImportReview(rows, setRows, { onAllAssignedEnter: () => void importAll(), enterStartsImport: !importing && readyCount > 0 });
  const { selected, setSelected, toggleSelected, focusedRowKey, setFocusedRowKey, activeRow, highlightIndex, assignSpecies, assignAndAdvance } = review;

  async function importAll() {
    const toImport = rows.filter((r) => r.speciesId && (r.status === "ready" || r.status === "error"));
    if (toImport.length === 0) return;
    setImporting(true);
    for (const row of toImport) importingKeysRef.current.add(row.key);
    setRows((prev) =>
      prev.map((r) => (toImport.some((t) => t.key === r.key) ? { ...r, status: "uploading", uploadError: undefined } : r)),
    );
    // Rows already imported earlier count as covered; anything still unassigned would be lost.
    onImportStarted?.(rows.every((r) => r.status === "done" || r.notWildlife || toImport.some((t) => t.key === r.key)));

    const committed: Array<{ key: string; captureId: string }> = [];
    await mapWithConcurrency(toImport, UPLOAD_CONCURRENCY, async (row) => {
      // Shows in the global upload banner; the upload keeps going if this screen unmounts.
      const jobId = registerExternalJob(row.speciesId!, row.file.name);
      rowJobsRef.current.set(row.key, jobId);
      const onProgress = (sent: number, total: number) => setRowProgress(row.key, sent, total);
      try {
        // /uploads/video is store-mode only, so no mode field for videos.
        const form = new FormData();
        if (!row.isVideo) form.append("mode", "store");
        form.append("speciesId", row.speciesId!);
        if (tripId) form.append("tripId", tripId);
        if (albumId) form.append("albumId", albumId);
        // Stored on the capture so Stats can count countries without relying on GPS EXIF.
        if (regionId) form.append("regionId", regionId);
        if (locationLabel.trim()) form.append("locationLabel", locationLabel.trim());
        const addFields = (f: FormData) => {
          for (const [k, v] of form.entries()) f.append(k, v);
        };
        if (row.isVideo) {
          // The upload from the species check is reused (awaited if still going), so gigabytes
          // aren't sent twice; a 410 resends it.
          const uploadId = await ensureUploaded(row.key, row.file);
          const res = await postUploadedFile<{ captureId: string }>("/uploads/video", row.file, { stagedId: row.stagedId, uploadId, onProgress, addFields });
          uploadsRef.current.delete(row.key);
          committed.push({ key: row.key, captureId: res.captureId });
          setRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, status: "done", captureId: res.captureId } : r)));
          settleExternalJob(jobId);
          return;
        }
        // A RAW matching an imported JPEG is filed as its sibling (linkedExisting), still "done".
        // The upload from the check is reused (awaited if it's still going); a 410 resends it.
        const uploadId = await ensureUploaded(row.key, row.file);
        const res = await postUploadedFile<{ captureId: string; linkedExisting?: boolean }>("/uploads", row.file, { uploadId, onProgress, addFields });
        uploadsRef.current.delete(row.key);
        committed.push({ key: row.key, captureId: res.captureId });
        setRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, status: "done", captureId: res.captureId } : r)));
        settleExternalJob(jobId);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Upload failed";
        setRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, status: "error", error: message, uploadProgress: null } : r)));
        settleExternalJob(jobId, message);
      } finally {
        rowJobsRef.current.delete(row.key);
        importingKeysRef.current.delete(row.key);
      }
    });

    setLastBatch(committed);
    setImporting(false);
    if (committed.length > 0) onImported?.();
  }

  async function undoLastBatch() {
    if (lastBatch.length === 0) return;
    await mapWithConcurrency(lastBatch, UPLOAD_CONCURRENCY, async ({ captureId }) => {
      await api.delete(`/captures/${captureId}`).catch(() => {});
    });
    setRows((prev) =>
      prev.map((r) => (lastBatch.some((b) => b.key === r.key) ? { ...r, status: "ready", captureId: undefined } : r)),
    );
    setLastBatch([]);
  }
  const doneCount = rows.filter((r) => r.status === "done").length;
  const notWildlifeCount = rows.filter((r) => r.notWildlife && !r.speciesId).length;
  // "photo"/"video" for a single-kind batch, "file" for a mixed one.
  const readyHasVideo = readyRows.some((r) => r.isVideo);
  const readyHasPhoto = readyRows.some((r) => !r.isVideo);
  const readyNoun = readyHasVideo && readyHasPhoto ? "file" : readyHasVideo ? "video" : "photo";

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm text-ink">
        <span className="text-muted">Location (optional):</span>
        <input
          type="text"
          value={locationLabel}
          onChange={(e) => setLocationLabel(e.target.value)}
          placeholder="e.g. Prince George"
          className="w-56 rounded-md border border-line bg-surface px-2 py-1 text-sm"
        />
      </label>

      {suggestEnabled && (
        <div className="rounded-lg border border-line bg-surface-muted px-3 py-2">
          <div className="mb-1 flex items-center gap-2">
            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
              Experimental
            </span>
            <span className="text-sm text-muted">Region for species suggestions:</span>
          </div>
          <RegionBrowser regionId={regionId} onChange={selectRegion} />
          {!regionId && <p className="mt-1 text-xs text-muted">Pick a region to see species suggestions below.</p>}
          {localMatching && <p className="mt-1 text-xs text-muted">Matching on this computer or the server, whichever is faster</p>}
        </div>
      )}

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
        }}
        onClick={() => document.getElementById(`photo-import-files-${tripId ?? albumId ?? "general"}`)?.click()}
        className="cursor-pointer rounded-lg border-2 border-dashed border-line p-8 text-center"
      >
        <input
          id={`photo-import-folder-${tripId ?? albumId ?? "general"}`}
          type="file"
          multiple
          // @ts-expect-error non-standard but widely supported attribute for whole-folder picks
          webkitdirectory=""
          directory=""
          className="hidden"
          onChange={(e) => e.target.files && addFiles(e.target.files)}
        />
        <input
          id={`photo-import-files-${tripId ?? albumId ?? "general"}`}
          type="file"
          multiple
          accept={`${PHOTO_ACCEPT},${VIDEO_ACCEPT},${[...VENDOR_RAW_EXTENSIONS].join(",")}`}
          className="hidden"
          onChange={(e) => e.target.files && addFiles(e.target.files)}
        />
        <p className="text-sm text-muted">
          Drag photos, RAWs, or videos in, or{" "}
          <button
            onClick={(e) => {
              e.stopPropagation();
              document.getElementById(`photo-import-folder-${tripId ?? albumId ?? "general"}`)?.click();
            }}
            className="text-ink underline"
          >
            choose a folder
          </button>{" "}
          /{" "}
          <button
            onClick={(e) => {
              e.stopPropagation();
              document.getElementById(`photo-import-files-${tripId ?? albumId ?? "general"}`)?.click();
            }}
            className="text-ink underline"
          >
            choose files
          </button>
        </p>
        <p className="mt-1 text-xs text-muted">Assign a species to each item below, then import.</p>
      </div>

      {rows.length > 0 && (
        <>
          <div className="flex items-center gap-3 text-sm text-muted">
            <span>
              {pluralize(rows.length, "file")} · {readyCount} ready to import · {doneCount} imported
              {notWildlifeCount > 0 && ` · ${notWildlifeCount} not wildlife, left out`}
            </span>
            {selected.size > 0 && (
              <div className="flex items-center gap-2">
                <span>Assign {selected.size} selected to:</span>
                <div className="w-56">
                  <SpeciesPicker
                    placeholder="Type a species…"
                    regionId={regionId}
                    onSelect={(r) => {
                      assignSpecies([...selected], r);
                      setSelected(new Set());
                    }}
                  />
                </div>
              </div>
            )}
            <div className="ml-auto flex items-center gap-3">
              {lastBatch.length > 0 && (
                <button onClick={undoLastBatch} className="text-muted hover:underline">
                  Undo last import ({lastBatch.length})
                </button>
              )}
              <Button size="sm" onClick={importAll} loading={importing} disabled={readyCount === 0}>
                {importing ? "Importing…" : readyCount > 0 ? `Import ${pluralize(readyCount, readyNoun)}` : `Import ${pluralWord(0, readyNoun)}`}
              </Button>
            </div>
          </div>

          <div className="divide-y divide-line rounded-lg border border-line bg-surface">
            {rows.map((row, i) => (
              <ImportReviewRow
                key={row.key}
                row={row}
                name={row.file.name}
                preview={
                  row.previewFromServer && !row.rawPreviewUrl ? (
                    // Until inspect returns the server's preview, or for good if the file has none.
                    <div
                      onClick={() => setLightboxIndex(i)}
                      className="flex h-14 w-14 cursor-pointer items-center justify-center rounded-md bg-surface-muted text-[10px] font-medium uppercase text-muted"
                    >
                      {row.isRaw ? "RAW" : (photoFormatOf(row.file) ?? "photo")}
                    </div>
                  ) : row.previewFromServer ? (
                    <img src={row.rawPreviewUrl!} alt="" onClick={() => setLightboxIndex(i)} className="h-14 w-14 cursor-pointer rounded-md object-cover" />
                  ) : row.isVideo ? (
                    // Seeking past 0 once metadata loads forces a first frame to paint.
                    <video
                      src={row.previewUrl}
                      muted
                      preload="auto"
                      onLoadedMetadata={(e) => {
                        e.currentTarget.currentTime = 0.1;
                      }}
                      onClick={() => setLightboxIndex(i)}
                      className="h-14 w-14 cursor-pointer rounded-md object-cover"
                    />
                  ) : (
                    <img src={row.previewUrl} alt="" onClick={() => setLightboxIndex(i)} className="h-14 w-14 cursor-pointer rounded-md object-cover" />
                  )
                }
                status={
                  <>
                    {row.uploadProgress != null && (
                      <ProgressBar value={row.uploadProgress} size="xs" label={`Uploading ${row.file.name}`} className="w-16" />
                    )}
                    <span className="text-xs text-muted">
                      {row.status === "done"
                        ? "✓ Imported"
                        : row.status === "error"
                          ? row.error
                          : row.status === "uploading"
                            ? "Uploading…"
                            : (row.uploadError ?? "")}
                    </span>
                  </>
                }
                removable={row.status !== "uploading" && row.status !== "done"}
                onRemove={() => removeRow(row.key)}
                removeLabel={`Remove this ${row.isVideo ? "video" : "photo"} from the import list`}
                selected={selected.has(row.key)}
                onToggleSelected={() => toggleSelected(row.key)}
                focused={focusedRowKey === row.key}
                onFocus={() => setFocusedRowKey(row.key)}
                regionId={regionId}
                onPick={(r) => assignAndAdvance(row.key, r)}
                isActive={row.key === activeRow?.key}
                highlightIndex={highlightIndex}
                onDismissWarning={(warning) => review.dismissWarning(row.key, warning)}
                onViewSpeciesGallery={speciesGallery.open}
              />
            ))}
          </div>
        </>
      )}

      {lightboxIndex != null && (
        <Lightbox
          slides={rows.map((r) => ({
            url: r.previewFromServer && r.rawPreviewUrl ? r.rawPreviewUrl : r.previewUrl,
            videoUrl: r.isVideo ? r.previewUrl : null,
            noPreview: r.previewFromServer && !r.rawPreviewUrl,
            caption: r.file.name,
          }))}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}

      {speciesGallery.lightbox}
    </div>
  );
}
