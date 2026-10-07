import { useRef, useState } from "react";
import type { CullMarksOption } from "@lifer/shared";
import { isRejected } from "../../lib/cullInfo";
import { api } from "../../api/client";
import type { SuggestedSpecies } from "../../components/SpeciesPicker";
import { useImportReview } from "../../components/importReview/useImportReview";
import { useJobPoll } from "../../hooks/useJobPoll";
import { mapWithConcurrency } from "../../lib/concurrency";
import { errorMessage } from "../../lib/errorMessage";
import { pickFolderNative } from "../../lib/pickFolderNative";
import type { ImportStatus, ReviewRow, ScanStatus, TripFolder } from "./types";

// Shared with the import screen and the collection, so the last region picked anywhere is the default.
const LAST_REGION_KEY = "lifer:lastRegionId";
// Each check is a real inference pass on the server.
const INSPECT_CONCURRENCY = 2;

// "Add more photos": scan the trip folder, review what's new (a species for each photo), then
// import it as a background job. Relocating a folder rescans too, to relink what's already there.
export function useTripScanImport({
  id,
  load,
  suggestEnabled,
}: {
  id: string | undefined;
  load: () => Promise<void>;
  suggestEnabled: boolean;
}) {
  // One loading tile per in-flight import; the review table closes as soon as an import starts.
  const [pendingImports, setPendingImports] = useState<string[]>([]);
  const [reviewRows, setReviewRows] = useState<ReviewRow[]>([]);
  // One region for the whole scanned batch: narrows the species suggestions and is stored on each
  // photo, as on the import screen.
  const [reviewRegionId, setReviewRegionId] = useState<string | null>(() => localStorage.getItem(LAST_REGION_KEY));
  // Which of the trip's two folders the in-page folder browser is choosing, if any.
  const [relocating, setRelocating] = useState<TripFolder | null>(null);
  const [relocateError, setRelocateError] = useState<string | null>(null);
  // What to do with photos a culling app rejected; skipping them is the default for every scan.
  const [cullOption, setCullOption] = useState<CullMarksOption>("skip");
  // Rejected photos not given a species check yet, since they were going to be skipped.
  const uncheckedRejectsRef = useRef(new Set<string>());

  // Only a scan started (or still running) here shows its outcome.
  const [scanRequested, setScanRequested] = useState(false);
  // Likewise an import: only one started here reports what the culling marks did to it.
  const [importRequested, setImportRequested] = useState(false);
  const scanJob = useJobPoll<ScanStatus>(id ? `/trips/${id}/scan/status` : null, {
    intervalMs: 1500,
    onFinish: (res) => {
      const rows: ReviewRow[] = res.newFiles.map((f) => ({
        key: f.relativePath,
        speciesId: null,
        speciesLabel: null,
        suggestions: [],
        status: "ready",
        isInspecting: f.cull?.verdict !== "reject",
        cull: f.cull ?? null,
      }));
      setReviewRows(rows);
      setCullOption("skip");
      // Photos about to be skipped aren't worth a species check.
      uncheckedRejectsRef.current = new Set(rows.filter(isRejected).map((r) => r.key));
      void inspectRows(
        rows.filter((r) => !isRejected(r)).map((r) => r.key),
        reviewRegionId,
      );
      if (res.recovered > 0) void load();
    },
  });
  const scanning = scanJob.starting || !!scanJob.status?.running;
  const scanStatus = scanRequested || scanJob.status?.running ? scanJob.status : null;

  // Refreshes the trip once at the end; in between, results only drain the loading tiles.
  const importJob = useJobPoll<ImportStatus>(id ? `/trips/${id}/import/status` : null, {
    intervalMs: 1000,
    onFinish: () => {
      void load().finally(() => setPendingImports([]));
    },
  });
  const importStatus = importJob.status;
  const importing = importJob.starting || !!importStatus?.running;
  const importResults = importStatus?.running ? importStatus.results : null;
  const importedSoFar = importResults?.filter((r) => r.captureId).length ?? 0;

  // A failed file drops its loading tile as soon as a poll reports it; imported ones stay until
  // the final refresh.
  const [seenImportResults, setSeenImportResults] = useState(importResults);
  if (seenImportResults !== importResults) {
    setSeenImportResults(importResults);
    const failed = new Set((importResults ?? []).filter((r) => !r.captureId).map((r) => r.relativePath));
    if (failed.size > 0) {
      setPendingImports((prev) => (prev.some((p) => failed.has(p)) ? prev.filter((p) => !failed.has(p)) : prev));
    }
  }

  async function startScan() {
    if (!id) return;
    setScanRequested(true);
    await scanJob.start(`/trips/${id}/scan`);
  }

  // Suggestions, a keyword match from the file's tags, and the not-wildlife flag for each photo
  // (POST /trips/:id/inspect). Best-effort: a failure only means picking the species by hand.
  // A newer pass (a region change) supersedes the running one, so old-region answers can't land late.
  const inspectGenerationRef = useRef(0);
  async function inspectRows(keys: string[], regionId: string | null) {
    if (!id) return;
    const generation = ++inspectGenerationRef.current;
    const keySet = new Set(keys);
    setReviewRows((prev) => prev.map((r) => (keySet.has(r.key) ? { ...r, isInspecting: true } : r)));
    await mapWithConcurrency(keys, INSPECT_CONCURRENCY, async (key) => {
      if (generation !== inspectGenerationRef.current) return;
      try {
        const res = await api.post<{ suggestions: SuggestedSpecies[]; notWildlife: { looksLike: string } | null }>(
          `/trips/${id}/inspect`,
          {
            relativePath: key,
            regionId: suggestEnabled ? regionId : null,
          },
        );
        if (generation !== inspectGenerationRef.current) return;
        setReviewRows((prev) =>
          prev.map((r) =>
            r.key === key
              ? { ...r, suggestions: res.suggestions, notWildlife: res.notWildlife, isInspecting: false }
              : r,
          ),
        );
      } catch {
        if (generation !== inspectGenerationRef.current) return;
        setReviewRows((prev) => prev.map((r) => (r.key === key ? { ...r, isInspecting: false } : r)));
      }
    });
  }

  function selectReviewRegion(regionId: string | null) {
    setReviewRegionId(regionId);
    if (regionId) localStorage.setItem(LAST_REGION_KEY, regionId);
    else localStorage.removeItem(LAST_REGION_KEY);
    // A region picked or changed mid-batch re-checks every photo not yet imported.
    if (regionId && suggestEnabled)
      void inspectRows(
        shownRows.filter((r) => r.status !== "done").map((r) => r.key),
        regionId,
      );
  }

  function selectCullOption(option: CullMarksOption) {
    setCullOption(option);
    // Rejected photos coming back into the review get their species check now.
    const unchecked = [...uncheckedRejectsRef.current];
    if (option !== "skip" && unchecked.length > 0) {
      uncheckedRejectsRef.current = new Set();
      void inspectRows(unchecked, reviewRegionId);
    }
  }

  // A background job: each file costs an exiftool read and a resize, too slow to await in one request.
  async function importReady() {
    if (!id) return;
    const toImport = shownRows.filter((r) => r.speciesId && (r.status === "ready" || r.status === "error"));
    if (toImport.length === 0) return;
    const previousRows = reviewRows;
    setImportRequested(true);
    setPendingImports(toImport.map((r) => r.key));
    setReviewRows([]);
    const started = await importJob.start(`/trips/${id}/import`, {
      files: toImport.map((r) => ({ relativePath: r.key, speciesId: r.speciesId })),
      regionId: reviewRegionId,
      cullMarks: cullOption,
    });
    if (!started) {
      setPendingImports([]);
      setReviewRows(previousRows);
    }
  }

  function removeReviewRow(key: string) {
    setReviewRows((prev) => prev.filter((r) => r.key !== key));
    review.forgetRow(key);
  }

  async function relocateFolder(which: TripFolder) {
    if (!id) return;
    setRelocateError(null);
    const native = await pickFolderNative();
    if (native === undefined) {
      setRelocating(which);
      return;
    }
    if (!native) return;
    await applyRelocate(which, native);
  }

  async function applyRelocate(which: TripFolder, folder: string) {
    if (!id) return;
    setRelocating(null);
    setRelocateError(null);
    try {
      await api.patch(`/trips/${id}`, { [which]: folder });
      void load();
      // A rescan relinks every existing photo by content hash (see scan.ts).
      void startScan();
    } catch (err) {
      setRelocateError(errorMessage(err, "Couldn't relocate this trip's folder"));
    }
  }

  // With "skip", photos a culling app rejected leave the review (they're still counted above it).
  const shownRows = cullOption === "skip" ? reviewRows.filter((r) => !isRejected(r)) : reviewRows;
  const cullRejected = reviewRows.filter(isRejected).length;
  const readyCount = shownRows.filter((r) => r.speciesId && r.status === "ready").length;
  const notWildlifeCount = shownRows.filter((r) => r.notWildlife && !r.speciesId).length;
  const review = useImportReview(shownRows, setReviewRows, {
    onAllAssignedEnter: () => void importReady(),
    enterStartsImport: !importing && readyCount > 0,
  });

  return {
    scanJob,
    scanning,
    scanStatus,
    startScan,
    importJob,
    importStatus,
    importRequested,
    importing,
    importedSoFar,
    pendingImports,
    reviewRows: shownRows,
    scannedCount: reviewRows.length,
    cullRejected,
    cullOption,
    selectCullOption,
    readyCount,
    notWildlifeCount,
    review,
    removeReviewRow,
    reviewRegionId,
    selectReviewRegion,
    importReady,
    relocating,
    setRelocating,
    relocateError,
    relocateFolder,
    applyRelocate,
  };
}

export type TripScanImport = ReturnType<typeof useTripScanImport>;
