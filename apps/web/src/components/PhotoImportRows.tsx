import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { api, apiPath, ApiError } from "../api/client";
import { errorMessage } from "../lib/errorMessage";
import { mapWithConcurrency } from "../lib/concurrency";
import {
  postUploadedFile,
  registerExternalJob,
  reportImportsRemoved,
  reportResultShownElsewhere,
  reportJobProgress,
  settleExternalJob,
  suggestSpeciesFromVideo,
} from "../lib/uploadQueue";
import { discardUpload, uploadFile } from "../lib/tusUpload";
import SpeciesPicker, { type SuggestedSpecies } from "./SpeciesPicker";
import RegionBrowser from "./RegionBrowser";
import Lightbox from "./Lightbox";
import ImportReviewRow from "./importReview/ImportReviewRow";
import ImportPlaceGroups from "./importReview/ImportPlaceGroups";
import { groupImportRows, groupPlace, type StagedPlace } from "./importReview/importGroups";
import { batchPairs, joinPairs, type PairFacts } from "./importReview/batchPairs";
import Tip from "./Tip";
import { useImportReview, type ReviewRowBase } from "./importReview/useImportReview";
import ImportCompareView from "./importReview/ImportCompareView";
import ImportSkipped from "./importReview/ImportSkipped";
import KnownFiles from "./importReview/KnownFiles";
import RecentImportFolders from "./importReview/RecentImportFolders";
import { fetchFolderFile, rememberSkipped, sortKnownFiles, type KnownFile, type SkipReason } from "../lib/knownFiles";
import { pickFolderNative } from "../lib/pickFolderNative";
import { useDeploymentMode } from "../hooks/useDeploymentMode";
import { skipKind, type SkipKind } from "./importReview/compareQueue";
import { isRawFile, VENDOR_RAW_EXTENSIONS } from "../lib/rawExtensions";
import { isBrowserDisplayable, isVideoFile, photoFormatOf, PHOTO_ACCEPT, VIDEO_ACCEPT } from "../lib/photoFormats";
import {
  computeClientVectors,
  recordServerMatching,
  shouldMatchLocally,
  prepareLocalInference,
  useLocalInferenceReady,
} from "../lib/localInference";
import { useSettings } from "../hooks/useSettings";
import { useRegions } from "../hooks/useRegions";
import { downloadedTaxaByCountry, usePackIndex } from "../lib/packIndex";
import Button from "./Button";
import FilePickArea from "./FilePickArea";
import ProgressBar from "./ProgressBar";
import { useSpeciesName } from "../lib/speciesName";
import { useLatest } from "../hooks/useLatest";
import { useJobPoll } from "../hooks/useJobPoll";
import { useToast } from "../hooks/useToast";
import {
  commitImport,
  placeAssignments,
  resetUndoneRows,
  undoImports,
  type CommittedImport,
} from "../lib/importCommit";
import { formatNumber } from "../lib/format";
import { useUndoLocation } from "../hooks/useSavedSpots";
import type { CullMarksOption, JobStatus } from "@lifer/shared";
import CullMarksChoice from "./importReview/CullMarksChoice";
import { isRejected, rejectedRowNote } from "../lib/cullInfo";
import { ignore } from "../lib/ignore";

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
  /** From /uploads/inspect: the animal's box in percent of the preview, when matching found it. */
  subject?: { x: number; y: number; w: number; h: number } | null;
  /** From /uploads/inspect: the camera's GPS point, the region holding it and the nearest town. */
  gps?: { lat: number; lon: number; regionId: string | null; town?: string | null } | null;
  /** From /uploads/inspect: the camera's own clock, for grouping. */
  cameraTime?: string | null;
  /** From /uploads/inspect: the capture time and version evidence, which pair a RAW with its edit. */
  takenAt?: string | null;
  versionEvidence?: { documentId: string | null; press: string | null } | null;
  /** The region this row's suggestions were last ranked for. */
  inspectedRegion?: string | null;
  /** Chosen on the import screen and applied after the import (staged, not sent with it). */
  place?: StagedPlace | null;
  /** Free-text place label, sent with the import as the photo's Location. */
  label?: string;
}

function uniqueCaptures(all: CommittedImport[]): CommittedImport[] {
  const seen = new Set<string>();
  return all.filter((c) => !seen.has(c.captureId) && !!seen.add(c.captureId));
}

// What pairs a checked file with another of the import; a file already matched to the library
// keeps that match instead.
function pairFacts(r: ImportRow): PairFacts[] {
  if (r.isVideo || r.takenAt === undefined || r.possibleDuplicate || r.rawMatch || r.editedVersionOf) return [];
  return [
    {
      key: r.key,
      name: r.file.name,
      isRaw: !!r.isRaw,
      takenAt: r.takenAt,
      documentId: r.versionEvidence?.documentId ?? null,
      press: r.versionEvidence?.press ?? null,
    },
  ];
}

const UPLOAD_CONCURRENCY = 2;
// Inspect runs server-side inference, so a big drop shouldn't queue dozens at once.
const INSPECT_CONCURRENCY = 2;

/** The element that scrolls `el` (the page's own scroller in the sidebar layout), else the window. */
function scrollParentOf(el: Element): Element | Window {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if ((overflowY === "auto" || overflowY === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return window;
}

// Batch import: drop files, assign a species to each (or bulk-assign a selection), then import.
// Used by BulkImportPage, TripDetailPage and AlbumDetailPage; tripId/albumId go straight to /uploads.
export default function PhotoImportRows({
  tripId,
  albumId,
  onImported,
  onImportStarted,
  suggestedRegionId,
}: {
  tripId?: string;
  /** The batch's trip's region, offered first in the region picker. */
  suggestedRegionId?: string | null;
  /** Links each new capture into this album. Unlike tripId, it never changes where files are stored. */
  albumId?: string;
  onImported?: () => void;
  /** Called once the uploads have started, with whether that covers every row here and the
   *  batch's region. Uploads continue in the background if the page is left. */
  onImportStarted?: (everyRowIncluded: boolean, regionId: string | null) => void;
}) {
  const { t } = useTranslation();
  const speciesName = useSpeciesName();
  const [rawRows, setRows] = useState<ImportRow[]>([]);
  // A RAW and its edit in this import are one photo: they show and act as one (batchPairs.ts).
  const pairs = useMemo(() => batchPairs(rawRows.flatMap(pairFacts)), [rawRows]);
  const rows = useMemo(() => joinPairs(rawRows, pairs, (r) => r.file.name), [rawRows, pairs]);
  const [importing, setImporting] = useState(false);
  const [lastBatch, setLastBatch] = useState<CommittedImport[]>([]);
  const toast = useToast();
  // The import's places are one step in the shared location history (POST /captures/location/undo).
  const undoPlaces = useUndoLocation(() => onImported?.());
  const navigate = useNavigate();
  // Row previews are local blob URLs, so the lightbox needs no fetch.
  // The previewed photo, by its row key: rows above it can come and go without the preview switching photos.
  const [previewKey, setPreviewKey] = useState<string | null>(null);

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
    const promise = uploadFile(file, {
      signal: controller.signal,
      onProgress: (sent, total) => setRowProgress(key, sent, total),
    })
      .then((uploadId) => {
        setRows((prev) =>
          prev.map((r) => (r.key === key ? { ...r, uploadId, uploadProgress: null, uploadError: undefined } : r)),
        );
        return uploadId;
      })
      .catch((err: unknown) => {
        uploadsRef.current.delete(key);
        if (!controller.signal.aborted) {
          const uploadError = err instanceof Error ? err.message : t("import.rows.uploadFailed");
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
  const rowsRef = useLatest(rows);
  useEffect(() => {
    // The same Set for the component's life (importAll adds to it), so it's safe to hold here.
    const importingKeys = importingKeysRef.current;
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- a latest-value ref, not a DOM node: the rows left at unmount are the ones to clean up
      for (const row of rowsRef.current) {
        URL.revokeObjectURL(row.previewUrl);
        if (!importingKeys.has(row.key) && !row.captureId) dropUpload(row.key, row.uploadId);
      }
    };
  }, [rowsRef]);

  // Suggestions are skipped entirely (not just hidden) unless the setting is on.
  const suggestEnabled = useSettings().settings?.speciesSuggestEnabled ?? false;

  // Region narrows the suggestion candidates. The batch's is the fallback: a row's place, camera
  // GPS or group goes first (rowRegions below).
  const [regionId, setRegionId] = useState<string | null>(() => localStorage.getItem(LAST_REGION_KEY));
  // The last batch's region stays a quick pick after switching away from it.
  const [lastRegionId] = useState(regionId);
  // With no last-used region, start on the first downloaded country so suggestions work right away.
  const { regions } = useRegions();
  const { packs } = usePackIndex();
  const firstCountryId = useMemo(() => {
    const name = packs ? downloadedTaxaByCountry(packs).keys().next().value : undefined;
    return (name && regions?.find((r) => r.name === name)?.id) || null;
  }, [packs, regions]);
  // Once only, so clearing the region by hand afterwards sticks.
  const fallbackApplied = useRef(false);
  const selectRegionRef = useLatest(selectRegion);
  useEffect(() => {
    if (regionId || !firstCountryId || fallbackApplied.current) return;
    fallbackApplied.current = true;
    selectRegionRef.current(firstCountryId);
  }, [regionId, firstCountryId, selectRegionRef]);

  // What to do with photos a culling app rejected (read from each file's own metadata by
  // /uploads/inspect). Skipping them is the default.
  const [cullOption, setCullOption] = useState<CullMarksOption>("skip");
  const skipsRow = (r: ImportRow) => cullOption === "skip" && isRejected(r);

  // In the desktop app connected to a server, photos can be matched on this computer instead.
  const localMatching = useLocalInferenceReady();
  useEffect(() => prepareLocalInference(), []);

  // Loads the models and this region's candidate set before the first photo arrives. Best-effort.
  useEffect(() => {
    if (!suggestEnabled || !regionId) return;
    const timer = setTimeout(() => {
      api.post("/species/matching/warm", { regionId }).catch(ignore("Couldn't warm up species matching"));
    }, 400);
    return () => clearTimeout(timer);
  }, [suggestEnabled, regionId]);

  // Species matching downloads by itself after setup. Photos added before it's ready got no
  // suggestions, so they're checked again the moment it finishes.
  const modelJob = useJobPoll<JobStatus & { downloaded?: boolean }>("/settings/embedding-model/status", {
    intervalMs: 3000,
    idleIntervalMs: 15000,
  });
  const matchingDownloading = suggestEnabled && !!modelJob.status?.running;
  const matchingPercent =
    modelJob.status?.running && modelJob.status.totalBytes
      ? Math.min(99, Math.round(((modelJob.status.downloadedBytes ?? 0) / modelJob.status.totalBytes) * 100))
      : null;
  const wasDownloading = useRef(false);
  useEffect(() => {
    const finished = wasDownloading.current && !matchingDownloading;
    wasDownloading.current = matchingDownloading;
    if (!finished || !suggestEnabled) return;
    // Forgetting their region makes the re-check effect below rank them again.
    const waiting = new Set(
      rowsRef.current
        .filter((r) => !r.captureId && !r.speciesId && !r.isInspecting && r.suggestions.length === 0)
        .map((r) => r.key),
    );
    setRows((prev) => prev.map((r) => (waiting.has(r.key) ? { ...r, inspectedRegion: null } : r)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the download finishing re-checks
  }, [matchingDownloading]);

  // Rows whose region falls back to the batch's are re-checked by the effect below.
  function selectRegion(id: string | null) {
    setRegionId(id);
    if (id) localStorage.setItem(LAST_REGION_KEY, id);
    else localStorage.removeItem(LAST_REGION_KEY);
  }

  // Importing a folder again: files the library already has (imported, or left out before) never
  // become rows, so they're never uploaded or checked. One line counts them (KnownFiles).
  const [known, setKnown] = useState<KnownFile[]>([]);
  const [freshCount, setFreshCount] = useState(0);
  const [editedCount, setEditedCount] = useState(0);
  const [checking, setChecking] = useState<{ done: number; total: number } | null>(null);
  const fingerprintsRef = useRef(new WeakMap<File, string>());
  // Rows arrive once the files are sorted, so they use the settings and region as they are then.
  const addRowsLatest = useLatest((files: File[]) => addRows(files));
  const removedFilesRef = useRef<File[]>([]);

  function addFiles(fileList: FileList | File[]) {
    // RAW and HEIC files often have an empty MIME type, so those match by extension. Anything the
    // server wouldn't take (a GIF in a picked folder) is left out.
    const files = Array.from(fileList).filter((f) => photoFormatOf(f) != null || isRawFile(f.name) || isVideoFile(f));
    let done = 0;
    void sortKnownFiles(files, (fresh, old) => {
      for (const f of fresh) if (f.fingerprint) fingerprintsRef.current.set(f.file, f.fingerprint);
      for (const k of old) if (k.file) fingerprintsRef.current.set(k.file, k.fingerprint);
      addRowsLatest.current(fresh.map((f) => f.file));
      setFreshCount((n) => n + fresh.length);
      if (old.length > 0) setKnown((prev) => [...prev, ...old]);
      done += fresh.length + old.length;
      setChecking(done < files.length ? { done, total: files.length } : null);
    });
  }

  // Desktop: a folder by its path, read by the local API, so it can be offered again later
  // (RecentImportFolders). Its new files are fetched and queued like picked ones.
  const desktop = useDeploymentMode() === "desktop";
  const [readingFolder, setReadingFolder] = useState<string | null>(null);
  async function importFolder(path: string) {
    setReadingFolder(path);
    try {
      const { files } = await api.post("/uploads/source-folders/scan", { path });
      const fresh = files.filter((f) => f.status === "new");
      const old: KnownFile[] = files.flatMap((f) =>
        f.status === "new" || !f.fingerprint
          ? []
          : [{ name: f.name, fingerprint: f.fingerprint, status: f.status, file: null, path: f.path }],
      );
      setKnown((prev) => [...prev, ...old]);
      setFreshCount((n) => n + fresh.length);
      setEditedCount((n) => n + fresh.filter((f) => f.edited).length);
      // In small batches, so the first rows show while the rest are read.
      for (let i = 0; i < fresh.length; i += 24) {
        const batch = await mapWithConcurrency(fresh.slice(i, i + 24), 4, (f) =>
          fetchFolderFile(f).then(
            (file) => {
              if (f.fingerprint) fingerprintsRef.current.set(file, f.fingerprint);
              return file;
            },
            () => null,
          ),
        );
        addRowsLatest.current(batch.filter((f): f is File => f != null));
      }
    } catch (err) {
      toast.error(errorMessage(err, t("import.recentFolders.readFailed")));
    } finally {
      setReadingFolder(null);
    }
  }

  async function importKnownAnyway(chosen: KnownFile[]) {
    const set = new Set(chosen);
    setKnown((prev) => prev.filter((k) => !set.has(k)));
    setFreshCount((n) => n + chosen.length);
    const files = await mapWithConcurrency(chosen, 4, (k) =>
      k.file
        ? Promise.resolve(k.file)
        : fetchFolderFile({ path: k.path!, name: k.name, mtimeMs: Date.now() }).catch(() => null),
    );
    addRowsLatest.current(files.filter((f): f is File => f != null));
  }

  // Choices are final once the user imports: what they left out stays out next time.
  function rememberLeftOut() {
    const left: Array<{ file: File; reason: SkipReason }> = [
      ...removedFilesRef.current.map((file) => ({ file, reason: "removed" as const })),
      ...rows.flatMap((r) =>
        r.notWildlife && !r.possibleDuplicate
          ? [{ file: r.file, reason: r.notWildlife.marked ? ("no_animal" as const) : ("not_wildlife" as const) }]
          : [],
      ),
    ];
    removedFilesRef.current = [];
    const files = left.flatMap(({ file, reason }) => {
      const fingerprint = fingerprintsRef.current.get(file);
      return fingerprint ? [{ fingerprint, name: file.name, size: file.size, reason }] : [];
    });
    rememberSkipped(files).catch(ignore("Couldn't remember the photos left out"));
  }

  function addRows(files: File[]) {
    if (files.length === 0) return;
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
      inspectedRegion: suggestEnabled ? regionId : null,
    }));
    setRows((prev) => [...prev, ...newRows]);
    mapWithConcurrency(newRows, INSPECT_CONCURRENCY, async (row) =>
      row.isVideo
        ? inspectVideoFile(row.key, row.file, suggestEnabled ? regionId : null)
        : inspectFile(row.key, row.file, suggestEnabled ? regionId : null, true),
    );
  }

  // One /uploads/inspect call does the duplicate check and, given a region, suggestions, so the
  // file is embedded once. Best-effort: a failure never blocks assigning a species by hand.
  // `cameraRegion`: rank with the region of the photo's own GPS point when it has one, so a first
  // check needs no second for its camera's region.
  async function inspectFile(key: string, file: File, forRegionId: string | null, cameraRegion = false) {
    const isLatest = startInspect(key);
    try {
      // TIFF and HEIC are matched on the server's decoded copy, which only it makes. A RAW is
      // matched on the preview inside it, which this computer can read too.
      const raw = isRawFile(file.name);
      const local = (raw || isBrowserDisplayable(file)) && shouldMatchLocally();
      const vectorsPromise = local ? computeClientVectors(file, raw) : Promise.resolve(null);
      const inspect = async (uploadId: string) => {
        const form = new FormData();
        form.append("uploadId", uploadId);
        if (forRegionId) form.append("regionId", forRegionId);
        if (forRegionId && cameraRegion) form.append("cameraRegion", "1");
        const clientVectors = await vectorsPromise;
        if (clientVectors) form.append("clientVectors", clientVectors);
        return api.post("/uploads/inspect", form);
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
      const known = res.rawMatch ?? res.editedVersionOf;
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
                  maybeNotWildlife: res.maybeNotWildlife ?? null,
                  invertebrate: res.invertebrate ?? null,
                  rawMatch: res.rawMatch ?? null,
                  editedVersionOf: res.editedVersionOf ?? null,
                  // A RAW or an edited copy of a photo you already have takes that photo's species
                  // (unless one was picked).
                  ...(known && !r.speciesId ? { speciesId: known.speciesId, speciesLabel: speciesName(known) } : {}),
                  cull: res.cull ?? null,
                  subject: res.subject ?? null,
                  gps: res.gps ?? null,
                  cameraTime: res.cameraTime ?? null,
                  takenAt: res.takenAt ?? null,
                  versionEvidence: res.versionEvidence ?? null,
                  inspectedRegion: (forRegionId && cameraRegion && res.gps?.regionId) || forRegionId,
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
      const res = await suggestSpeciesFromVideo(upload, forRegionId);
      if (!isLatest()) return;
      setRows((prev) =>
        prev.map((r) =>
          r.key === key
            ? {
                ...r,
                suggestions: res.suggestions,
                suggestError: res.error,
                stagedId: res.stagedId ?? null,
                inspectedRegion: forRegionId,
                isInspecting: false,
              }
            : r,
        ),
      );
    } catch (err) {
      console.error(err);
      if (!isLatest()) return;
      setRows((prev) =>
        prev.map((r) =>
          r.key === key
            ? { ...r, suggestError: errorMessage(err, "Couldn't analyze this video"), isInspecting: false }
            : r,
        ),
      );
    }
  }

  function removeRow(key: string) {
    const removed = rows.find((r) => r.key === key);
    // Its partner keeps the species and verdict it showed.
    const partner = rows.find((r) => r.key === removed?.partnerKey);
    setRows((prev) => {
      const row = prev.find((r) => r.key === key);
      if (row) URL.revokeObjectURL(row.previewUrl);
      return prev
        .filter((r) => r.key !== key)
        .map((r) =>
          r.key === partner?.key
            ? {
                ...r,
                speciesId: partner.speciesId,
                speciesLabel: partner.speciesLabel,
                notWildlife: partner.notWildlife,
              }
            : r,
        );
    });
    if (removed && !removed.captureId) dropUpload(key, removed.uploadId);
    if (removed && !removed.captureId && !removed.possibleDuplicate) removedFilesRef.current.push(removed.file);
    review.forgetRow(key);
  }

  const readyRows = rows.filter((r) => r.speciesId && r.status === "ready" && !skipsRow(r) && !skipKind(r));
  // A pair imports as one photo, so it counts once.
  const readyKeys = new Set(readyRows.map((r) => r.key));
  const readyCount = readyRows.filter((r) => !(r.samePhotoAs && readyKeys.has(r.partnerKey!))).length;

  // Photos this import leaves out (not wildlife, marked "No animal", already in the library) wait in
  // one section at the end, out of the groups, their counts and the keys.
  const skippedRows = useMemo(() => rows.filter((r) => skipKind(r)), [rows]);
  // Outings, oldest first; the review keys walk the rows in the order they're shown.
  const groups = useMemo(() => groupImportRows(rows.filter((r) => !skipKind(r))), [rows]);
  const orderedRows = useMemo(() => groups.flat(), [groups]);
  const previewRows = useMemo(() => [...orderedRows, ...skippedRows], [orderedRows, skippedRows]);
  const previewIndex = previewKey ? previewRows.findIndex((r) => r.key === previewKey) : -1;
  // The previewed photo left the import (removed): the preview closes rather than show another.
  useEffect(() => {
    if (previewKey && previewIndex < 0) setPreviewKey(null);
  }, [previewKey, previewIndex]);

  // A staged saved place carries no region, so the spots' own regions are looked up once chosen.
  const [spotRegions, setSpotRegions] = useState<Record<string, string | null>>({});
  const stagedSpots = [...new Set(rows.flatMap((r) => (r.place?.spotId ? [r.place.spotId] : [])))].sort().join(",");
  useEffect(() => {
    if (!stagedSpots || stagedSpots.split(",").every((id) => id in spotRegions)) return;
    api
      .get("/saved-spots")
      .then(({ spots }) => setSpotRegions(Object.fromEntries(spots.map((s) => [s.id, s.regionId]))))
      .catch(ignore("Couldn't load the saved places' regions"));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch only for a spot not looked up yet
  }, [stagedSpots]);

  // Each row's region for suggestions: its place's, its camera's, its group's, else the batch's.
  const rowRegions = useMemo(() => {
    const placeRegion = (p: StagedPlace | null | undefined) =>
      p?.regionId ?? (p?.spotId ? spotRegions[p.spotId] : null) ?? null;
    const out = new Map<string, string | null>();
    for (const g of groups) {
      const groupRegion = placeRegion(groupPlace(g)) ?? g.find((r) => r.gps?.regionId)?.gps?.regionId ?? null;
      for (const r of g) out.set(r.key, placeRegion(r.place) ?? r.gps?.regionId ?? groupRegion ?? regionId);
    }
    return out;
  }, [groups, spotRegions, regionId]);

  // Re-checks only the rows whose region changed (a place chosen, the batch region switched, a
  // neighbour's GPS read), marking them first so each change asks once.
  useEffect(() => {
    if (!suggestEnabled) return;
    const stale = new Map<string, string>();
    for (const r of rows) {
      const want = rowRegions.get(r.key);
      if (want && want !== r.inspectedRegion && !r.isInspecting && !r.captureId && r.status !== "uploading")
        stale.set(r.key, want);
    }
    if (stale.size === 0) return;
    setRows((prev) => prev.map((r) => (stale.has(r.key) ? { ...r, inspectedRegion: stale.get(r.key) } : r)));
    const todo = rows.filter((r) => stale.has(r.key));
    void mapWithConcurrency(todo, INSPECT_CONCURRENCY, async (row) =>
      row.isVideo
        ? inspectVideoFile(row.key, row.file, stale.get(row.key)!)
        : inspectFile(row.key, row.file, stale.get(row.key)!),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the inspect helpers are plain functions of this render
  }, [rows, rowRegions, suggestEnabled]);

  const stage = (keys: string[], change: Partial<ImportRow>) => {
    const set = new Set(keys);
    setRows((prev) => prev.map((r) => (set.has(r.key) ? { ...r, ...change } : r)));
  };

  const review = useImportReview(orderedRows, setRows, {
    onAllAssignedEnter: () => void importAll(),
    enterStartsImport: !importing && readyCount > 0,
  });
  const {
    selected,
    bulkKeys,
    toggleSelected,
    focusedRowKey,
    setFocusedRowKey,
    activeRow,
    highlightIndex,
    assignSpecies,
    assignAndAdvance,
  } = review;

  // A row found late to leave out (a duplicate, not wildlife) above the outlined photo leaves the list: whatever scrolls the page moves
  // by as much, so the outlined photo stays where it was on screen.
  const anchor = useRef<{ key: string; top: number; skipped: number } | null>(null);
  const activeKey = activeRow?.key ?? null;
  useLayoutEffect(() => {
    const el = activeKey ? document.querySelector(`[data-import-row="${CSS.escape(activeKey)}"]`) : null;
    const prev = anchor.current;
    if (el && prev && prev.key === activeKey && prev.skipped !== skippedRows.length) {
      const moved = el.getBoundingClientRect().top - prev.top;
      if (moved) scrollParentOf(el).scrollBy(0, moved);
    }
    anchor.current =
      el && activeKey ? { key: activeKey, top: el.getBoundingClientRect().top, skipped: skippedRows.length } : null;
  });
  useEffect(() => {
    // Scrolling by hand moves the anchor with it.
    const onScroll = () => {
      const a = anchor.current;
      const el = a && document.querySelector(`[data-import-row="${CSS.escape(a.key)}"]`);
      if (a && el) a.top = el.getBoundingClientRect().top;
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => document.removeEventListener("scroll", onScroll, { capture: true });
  }, []);

  // "Import anyway" puts each back in the list (a duplicate filed under its earlier species).
  const importSkippedAnyway = (keys: string[]) =>
    keys.forEach((k) => {
      const row = rows.find((r) => r.key === k);
      if (row) review.dismissWarning(k, skipKind(row) === "duplicate" ? "possibleDuplicate" : "notWildlife");
    });

  async function importAll() {
    const toImport = rows.filter(
      (r) => r.speciesId && (r.status === "ready" || r.status === "error") && !skipsRow(r) && !skipKind(r),
    );
    if (toImport.length === 0) return;
    rememberLeftOut();
    setImporting(true);
    for (const row of toImport) importingKeysRef.current.add(row.key);
    setRows((prev) =>
      prev.map((r) =>
        toImport.some((t) => t.key === r.key) ? { ...r, status: "uploading", uploadError: undefined } : r,
      ),
    );
    // Rows already imported earlier count as covered; anything still unassigned would be lost.
    onImportStarted?.(
      rows.every((r) => r.status === "done" || r.notWildlife || skipsRow(r) || toImport.some((t) => t.key === r.key)),
      regionId,
    );

    // A RAW goes in one request with its paired edit, so the two become one photo with both files.
    const byKey = new Map(toImport.map((r) => [r.key, r]));
    const rawWith = new Map<string, ImportRow>();
    for (const r of toImport) {
      const p = r.partnerKey ? byKey.get(r.partnerKey) : undefined;
      if (p && r.isRaw && !p.isRaw && p.speciesId === r.speciesId) rawWith.set(p.key, r);
    }
    const riding = new Set([...rawWith.values()].map((r) => r.key));
    const requests = toImport.filter((r) => !riding.has(r.key));

    const committed: CommittedImport[] = [];
    // Every file joins the global upload banner now, so its count is the whole import from the
    // start (not just the ones begun); the uploads keep going if this screen unmounts.
    for (const row of requests) rowJobsRef.current.set(row.key, registerExternalJob(row.speciesId!, row.file.name));
    await mapWithConcurrency(requests, UPLOAD_CONCURRENCY, async (row) => {
      const jobId = rowJobsRef.current.get(row.key)!;
      const onProgress = (sent: number, total: number) => setRowProgress(row.key, sent, total);
      const raw = rawWith.get(row.key);
      const keys = raw ? [row.key, raw.key] : [row.key];
      try {
        const outcome = await commitImport(
          {
            speciesId: row.speciesId!,
            isVideo: !!row.isVideo,
            cullOption,
            tripId,
            albumId,
            regionId,
            locationLabel: row.label ?? "",
          },
          {
            ensureUploaded: () => ensureUploaded(row.key, row.file),
            // A 410 on the reused upload sends the file again.
            post: async (endpoint, uploadId, addFields) => {
              const rawUploadId = raw ? await ensureUploaded(raw.key, raw.file) : null;
              return postUploadedFile(endpoint, row.file, {
                stagedId: row.isVideo ? row.stagedId : undefined,
                uploadId,
                onProgress,
                addFields: (form) => {
                  addFields(form);
                  if (rawUploadId) form.append("rawUploadId", rawUploadId);
                },
              });
            },
          },
        );
        for (const k of keys) uploadsRef.current.delete(k);
        if (outcome.kind === "rejected") {
          // The server read a reject this screen hadn't seen yet (the check failed or was still
          // running), and the import skips those.
          setRows((prev) =>
            prev.map((r) =>
              keys.includes(r.key)
                ? { ...r, status: "ready", uploadId: null, cull: { verdict: "reject", label: r.cull?.label ?? null } }
                : r,
            ),
          );
          settleExternalJob(jobId);
          return;
        }
        const captureId = outcome.captureId;
        for (const key of keys) committed.push({ key, captureId });
        setRows((prev) => prev.map((r) => (keys.includes(r.key) ? { ...r, status: "done", captureId } : r)));
        settleExternalJob(jobId);
      } catch (err) {
        const message = err instanceof Error ? err.message : t("import.rows.uploadFailed");
        setRows((prev) =>
          prev.map((r) => (keys.includes(r.key) ? { ...r, status: "error", error: message, uploadProgress: null } : r)),
        );
        settleExternalJob(jobId, message);
        // The RAW's upload may be what expired: a retry sends it again.
        if (raw) uploadsRef.current.delete(raw.key);
      } finally {
        rowJobsRef.current.delete(row.key);
        for (const k of keys) importingKeysRef.current.delete(k);
      }
    });

    setLastBatch(committed);
    setImporting(false);
    if (committed.length === 0) return;
    // The staged places, read as they are now (they can change while files upload), in one step.
    const latest = new Map(rowsRef.current.map((r) => [r.key, r]));
    // A RAW imported with its edit shares the edit's capture: one photo.
    const photos = uniqueCaptures(committed);
    const places = placeAssignments(
      photos.map((c) => {
        const r = latest.get(c.key) ?? toImport.find((x) => x.key === c.key);
        return { captureId: c.captureId, place: r?.place, label: r?.label };
      }),
    );
    const placed =
      places.length === 0
        ? null
        : await api.post("/places/apply", { places }).catch((err: unknown) => {
            toast.error(errorMessage(err, t("import.rows.placesFailed")));
            return null;
          });
    onImported?.();
    // The page may be gone by now (BulkImportPage leaves once uploads start), so the result and
    // its undo go in a toast, which shows wherever the user is.
    const species = new Set(toImport.filter((r) => committed.some((c) => c.key === r.key)).map((r) => r.speciesId));
    const onlySpecies = species.size === 1 ? [...species][0] : null;
    reportResultShownElsewhere();
    toast.show(t("import.rows.filed", { photos: photos.length, species: species.size }), {
      tone: "success",
      actions: [
        {
          label: t("import.rows.view"),
          onClick: () => navigate(onlySpecies ? `/species/${onlySpecies}` : regionId ? `/?region=${regionId}` : "/"),
        },
        { label: t("import.rows.undo"), onClick: () => void undoBatch(committed) },
      ],
    });
    if (placed && placed.applied > 0)
      toast.show(t("import.rows.placesSet", { count: placed.applied, formatted: formatNumber(placed.applied) }), {
        tone: "success",
        actions: [{ label: t("import.rows.undo"), onClick: () => void undoPlaces() }],
      });
    // Photos taken during a trip they weren't imported into: a hint to review them there.
    api
      .post("/trips/matching", { captureIds: photos.map((c) => c.captureId) })
      .then(({ trips }) => {
        const trip = trips[0];
        if (!trip) return;
        toast.show(t("import.rows.tripHint", { count: trip.count, name: trip.name }), {
          actions: [{ label: t("trips.suggestions.review"), onClick: () => navigate(`/trips/${trip.id}`) }],
        });
      })
      .catch(() => {});
  }

  // A capture that couldn't be deleted is still on the server, so its row stays imported (and
  // undoable) rather than going back to "ready", where importing it again would duplicate it.
  // Undo can run from the page and from the toast, so skip captures already deleted by the other.
  const undoneCaptureIds = useRef(new Set<string>());
  async function undoBatch(all: CommittedImport[]) {
    const batch = all.filter((c) => !undoneCaptureIds.current.has(c.captureId));
    if (batch.length === 0) return;
    const { undone: undonePhotos, failed } = await undoImports(
      uniqueCaptures(batch),
      (captureId) => api.delete(apiPath("/captures/{id}", { id: captureId })),
      UPLOAD_CONCURRENCY,
    );
    for (const u of undonePhotos) undoneCaptureIds.current.add(u.captureId);
    const undone = batch.filter((c) => undoneCaptureIds.current.has(c.captureId));
    if (undone.length > 0) reportImportsRemoved();
    setRows((prev) => resetUndoneRows(prev, undone));
    setLastBatch((prev) => prev.filter((c) => !undoneCaptureIds.current.has(c.captureId)));
    if (failed.length > 0) {
      toast.error(t("import.rows.undoPartlyFailed", { count: failed.length }));
    }
  }
  const doneCount = rows.filter((r) => r.status === "done").length;
  // "339 files · 312 ready to import · 14 not wildlife · 3 already imported", leaving out the zeros.
  const kindCount = (kind: SkipKind) => skippedRows.filter((r) => skipKind(r) === kind).length;
  const summaryParts = [
    t("import.rows.filesCount", { count: rows.length, formatted: formatNumber(rows.length) }),
    ...(
      [
        ["import.rows.readyCount", readyCount],
        ["import.rows.doneCount", doneCount],
        ["import.rows.notWildlifeCount", kindCount("notWildlife")],
        ["import.rows.markedCount", kindCount("marked")],
        ["import.rows.duplicateCount", kindCount("duplicate")],
      ] as const
    ).flatMap(([key, n]) => (n > 0 ? [t(key, { count: n, formatted: formatNumber(n) })] : [])),
  ];
  // "photo"/"video" for a single-kind batch, "file" for a mixed one.
  const readyHasVideo = readyRows.some((r) => r.isVideo);
  const readyHasPhoto = readyRows.some((r) => !r.isVideo);
  const importKey =
    readyHasVideo && readyHasPhoto
      ? "import.rows.importFiles"
      : readyHasVideo
        ? "import.rows.importVideos"
        : "import.rows.importPhotos";

  return (
    <div className="space-y-item">
      {suggestEnabled && (
        <div>
          <p className="text-callout">
            <span className="text-ink">{t("captureEdit.location.region")}</span>
            <span className="ml-1.5 text-footnote text-muted">{t("import.rows.forSuggestions")}</span>
          </p>
          <div className="mt-1">
            <RegionBrowser
              regionId={regionId}
              onChange={selectRegion}
              suggestedRegionIds={[suggestedRegionId, lastRegionId]}
            />
          </div>
          {!regionId && <p className="mt-1 text-footnote text-muted">{t("import.rows.pickRegion")}</p>}
          {matchingDownloading && (
            <p role="status" className="mt-1 text-footnote text-muted">
              {matchingPercent != null
                ? t("import.rows.matchingDownloadingPercent", { percent: matchingPercent })
                : t("import.rows.matchingDownloading")}
            </p>
          )}
          {localMatching && <p className="mt-1 text-footnote text-muted">{t("import.rows.localMatching")}</p>}
        </div>
      )}

      <FilePickArea
        prompt={t("import.rows.pickPrompt")}
        hint={t("import.rows.pickHint")}
        accept={`${PHOTO_ACCEPT},${VIDEO_ACCEPT},${[...VENDOR_RAW_EXTENSIONS].join(",")}`}
        onFiles={(files) => addFiles(files)}
        onChooseFolder={
          desktop
            ? async () => {
                const path = await pickFolderNative();
                if (path === undefined) return false;
                if (path) void importFolder(path);
                return true;
              }
            : undefined
        }
      />
      <RecentImportFolders onImport={(path) => void importFolder(path)} busyPath={readingFolder} />
      <KnownFiles
        known={known}
        fresh={freshCount}
        edited={editedCount}
        checking={checking}
        onImportAnyway={(chosen) => void importKnownAnyway(chosen)}
      />

      {rows.length > 0 && (
        <>
          <CullMarksChoice
            total={rows.length}
            rejected={rows.filter((r) => isRejected(r) && r.status !== "done").length}
            value={cullOption}
            onChange={setCullOption}
            disabled={importing}
          />
          <div className="flex items-center gap-3 text-callout text-muted">
            <span>{summaryParts.join(" · ")}</span>
            {bulkKeys.length > 0 && (
              <div className="flex items-center gap-2">
                <span>{t("import.rows.assignSelected", { count: bulkKeys.length })}</span>
                <div className="w-56">
                  <SpeciesPicker
                    placeholder={t("import.rows.typeSpecies")}
                    regionId={regionId}
                    onSelect={(r) => assignSpecies(bulkKeys, r)}
                  />
                </div>
              </div>
            )}
            <div className="ml-auto flex items-center gap-3">
              {lastBatch.length > 0 && (
                <Button variant="link" size="sm" onClick={() => void undoBatch(lastBatch)}>
                  {t("import.rows.undoLast", { count: uniqueCaptures(lastBatch).length })}
                </Button>
              )}
              <Button size="sm" onClick={importAll} loading={importing} disabled={readyCount === 0}>
                {importing ? t("import.rows.importing") : t(importKey, { count: readyCount })}
              </Button>
            </div>
          </div>

          <Tip id="import-keys" when={rows.some((r) => r.suggestions.length > 0)} className="mb-2" />
          <ImportPlaceGroups
            groups={groups}
            activeKey={activeRow?.key ?? null}
            regionId={regionId}
            onPlace={(keys, place) => stage(keys, { place })}
            onLabel={(keys, label) => stage(keys, { label })}
            thumb={(r) => (r.previewFromServer ? (r.rawPreviewUrl ?? null) : r.isVideo ? null : r.previewUrl)}
            renderRow={(row, place) => {
              const open = () => setPreviewKey(row.key);
              return (
                <ImportReviewRow
                  key={row.key}
                  row={row}
                  name={row.file.name}
                  preview={
                    row.previewFromServer && !row.rawPreviewUrl ? (
                      // Until inspect returns the server's preview, or for good if the file has none.
                      <div
                        onClick={open}
                        className="flex h-14 w-14 cursor-pointer items-center justify-center rounded-badge bg-surface-muted text-footnote font-medium uppercase text-muted"
                      >
                        {row.isRaw ? "RAW" : (photoFormatOf(row.file) ?? t("import.rows.photoFormatUnknown"))}
                      </div>
                    ) : row.previewFromServer ? (
                      <img
                        src={row.rawPreviewUrl!}
                        alt=""
                        onClick={open}
                        className="h-14 w-14 cursor-pointer rounded-badge object-cover"
                      />
                    ) : row.isVideo ? (
                      // Seeking past 0 once metadata loads forces a first frame to paint.
                      <video
                        src={row.previewUrl}
                        muted
                        preload="auto"
                        onLoadedMetadata={(e) => {
                          e.currentTarget.currentTime = 0.1;
                        }}
                        onClick={open}
                        className="h-14 w-14 cursor-pointer rounded-badge object-cover"
                      />
                    ) : (
                      <img
                        src={row.previewUrl}
                        alt=""
                        onClick={open}
                        className="h-14 w-14 cursor-pointer rounded-badge object-cover"
                      />
                    )
                  }
                  status={
                    <>
                      {row.uploadProgress != null && (
                        <ProgressBar
                          value={row.uploadProgress}
                          size="xs"
                          label={t("import.rows.uploadingFile", { name: row.file.name })}
                          className="w-16"
                        />
                      )}
                      {place}
                      <span className="text-footnote text-muted">
                        {row.status === "done"
                          ? t("import.rows.imported")
                          : row.status === "error"
                            ? row.error
                            : row.status === "uploading"
                              ? t("import.rows.uploading")
                              : (row.uploadError ?? rejectedRowNote(row, cullOption) ?? "")}
                      </span>
                    </>
                  }
                  removable={row.status !== "uploading" && row.status !== "done"}
                  onRemove={() => removeRow(row.key)}
                  removeLabel={row.isVideo ? t("import.rows.removeVideo") : t("import.rows.removePhoto")}
                  selected={selected.has(row.key)}
                  onToggleSelected={() => toggleSelected(row.key)}
                  focused={focusedRowKey === row.key}
                  onFocus={() => setFocusedRowKey(row.key)}
                  regionId={regionId}
                  onPick={(r) => assignAndAdvance(row.key, r)}
                  isActive={row.key === activeRow?.key}
                  highlightIndex={highlightIndex}
                  onDismissWarning={(warning) => review.dismissWarning(row.key, warning)}
                  onCompare={(speciesId) => review.openCompare(row.key, speciesId)}
                  onNoAnimal={() => review.markNoAnimal([row.key])}
                />
              );
            }}
          />
          <ImportSkipped
            rows={skippedRows}
            nameOf={(r) => r.file.name}
            thumb={(r) => (r.previewFromServer ? (r.rawPreviewUrl ?? null) : r.isVideo ? null : r.previewUrl)}
            onRemove={(keys) => keys.forEach(removeRow)}
            onImportAnyway={importSkippedAnyway}
          />
        </>
      )}

      {previewIndex >= 0 && (
        <Lightbox
          slides={previewRows.map((r) => ({
            url: r.previewFromServer && r.rawPreviewUrl ? r.rawPreviewUrl : r.previewUrl,
            videoUrl: r.isVideo ? r.previewUrl : null,
            noPreview: r.previewFromServer && !r.rawPreviewUrl,
            caption: r.file.name,
          }))}
          index={previewIndex}
          onIndexChange={(i) => setPreviewKey(previewRows[i]?.key ?? null)}
          onClose={() => setPreviewKey(null)}
        />
      )}

      {review.compare && (
        <ImportCompareView
          rows={orderedRows}
          target={review.compare}
          regionId={regionId}
          photoUrl={(r) => (r.isVideo ? null : r.previewFromServer ? (r.rawPreviewUrl ?? null) : r.previewUrl)}
          nameOf={(r) => r.file.name}
          onConfirm={(keys, species) =>
            keys.length === 1 ? assignAndAdvance(keys[0], species) : assignSpecies(keys, species)
          }
          onNoAnimal={review.markNoAnimal}
          onClose={review.closeCompare}
        />
      )}
    </div>
  );
}
