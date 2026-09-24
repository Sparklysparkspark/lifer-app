import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { errorMessage } from "../lib/errorMessage";
import { mapWithConcurrency } from "../lib/concurrency";
import { registerExternalJob, settleExternalJob, type PossibleDuplicate } from "../lib/uploadQueue";
import SpeciesPicker, { type SpeciesResult, type SuggestedSpecies } from "./SpeciesPicker";
import SuggestionCard from "./SuggestionCard";
import RegionBrowser from "./RegionBrowser";
import Lightbox, { type LightboxSlide } from "./Lightbox";
import { isRawFile, RAW_EXTENSIONS } from "../lib/rawExtensions";

// Same localStorage key CollectionPage uses for its own region browsing — reusing it means
// picking a region here also becomes the default the next time the Collection page opens, and
// vice versa, rather than tracking two independent "which region am I looking at" states.
const LAST_REGION_KEY = "lifer:lastRegionId";

// Phase 5 (spec §9): "a decade of photos onboarded in an evening." AI photo matching was tried
// here (see packages-id/ archive) but shelved after regressions — revisited as embedding-based
// species auto-suggest (see ~/.claude/plans/vast-prancing-turing.md): a background call to
// POST /captures/suggest-species per row surfaces one-click suggestions in that row's
// SpeciesPicker, but assignment itself stays fully manual — suggestions never auto-assign.
type RowStatus = "pending" | "ready" | "uploading" | "done" | "error";

interface ImportRow {
  key: string;
  file: File;
  previewUrl: string;
  speciesId: string | null;
  speciesLabel: string | null;
  status: RowStatus;
  suggestions: SuggestedSpecies[];
  /** Set if this exact photo (by content, not filename) matches one you've already imported —
   *  checked at add-time so it's visible before you've even picked a species, same /uploads/
   *  inspect check UploadDropzone's own flow already uses (see uploadQueue.ts), just surfaced
   *  inline per-row here instead of through a global banner prompt. `undefined` = not checked
   *  yet, `null` = checked, no duplicate found. */
  possibleDuplicate?: PossibleDuplicate | null;
  captureId?: string;
  error?: string;
  /** True while the duplicate-check/species-suggestion request for this row is in flight —
   *  that call can take a couple seconds (a real inference pass, not a cache hit), so without
   *  this the row just sits with no suggestions and no indication anything is happening,
   *  reading as "there's nothing to suggest" rather than "still working on it." */
  isInspecting?: boolean;
  /** A camera RAW has no browser-renderable preview of its own (sharp/the browser can't decode
   *  raw sensor data) — previewUrl (the raw file's own blob URL) would just be a broken-image
   *  icon. Shown as a plain badge until this fills in, once /uploads/inspect's response comes
   *  back with the RAW's embedded JPEG preview extracted server-side (data URL, so no second
   *  request needed to fetch it) — `undefined` = not checked yet, `null` = checked, camera/
   *  format has no embedded preview to extract. */
  isRaw?: boolean;
  rawPreviewUrl?: string | null;
  /** Routed through an entirely different pair of endpoints from a photo row — /uploads/video
   *  instead of /uploads for the actual import, and suggest-species-from-video (frame sampling)
   *  instead of /uploads/inspect for suggestions (video has no duplicate-check story yet). */
  isVideo?: boolean;
  /** Set when suggestions couldn't be computed at all (e.g. no readable video frames), so the
   *  row doesn't read as "no species matched". */
  suggestError?: string;
}

const VIDEO_MIME_TYPES = new Set(["video/mp4", "video/quicktime"]);
const VIDEO_EXTENSIONS = [".mp4", ".mov"];
function isVideoFile(file: File): boolean {
  return VIDEO_MIME_TYPES.has(file.type) || VIDEO_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext));
}

const UPLOAD_CONCURRENCY = 2;
// /uploads/inspect runs CPU-bound embedding inference server-side whenever a region is set (see
// inspectFile) — a small concurrency cap keeps a big batch drop from queuing dozens of
// inference calls at once, same reasoning as UPLOAD_CONCURRENCY above.
const INSPECT_CONCURRENCY = 2;

// Shared by BulkImportPage (general import) and TripDetailPage's Build-a-Trip flow — same
// "drop a batch of photos, assign a species to each (or select several and bulk-assign), then
// import" experience either way. `tripId`, when present, is threaded straight through to
// /uploads (already supports it — see uploads/routes.ts's mode=store tripId handling, which
// resolves the trip's own folder as the destination and sets captures.trip_id), the only thing
// that actually differs between the two callers.
export default function PhotoImportRows({
  tripId,
  albumId,
  onImported,
}: {
  tripId?: string;
  /** Same idea as tripId above, for Album's own "Import Album" flow - threaded straight through
   *  to /uploads (already supports it, see uploads/routes.ts's own albumId handling), which links
   *  each newly-created capture into this album via album_captures. Unlike tripId, this never
   *  changes where the file is stored - an album doesn't have its own folder. */
  albumId?: string;
  onImported?: () => void;
}) {
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [lastBatch, setLastBatch] = useState<Array<{ key: string; captureId: string }>>([]);
  // row.previewUrl is already a full-resolution local blob URL (URL.createObjectURL(file),
  // see addFiles below), so this reuses the same Lightbox the rest of the app uses for
  // full-size viewing with no extra fetch — the whole file is already sitting in the browser.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  // A bigger view of a suggestion's reference photos — separate from the row-photo lightbox
  // above, since this shows every reference photo of a CANDIDATE species (main + gallery), so a
  // user can flip through them to compare against their own new photo rather than judging a
  // match off one single thumbnail. Fetched fresh per click via GET /species/:id/reference-
  // photos rather than reusing the single `reference-photo/thumb` URL SuggestionCard's own
  // thumbnail already uses.
  const [speciesGallery, setSpeciesGallery] = useState<{ slides: LightboxSlide[]; label: string; index: number } | null>(null);

  async function viewSpeciesGallery(speciesId: string, label: string) {
    const caption = (credit: string | null) => (credit ? `${label} · ${credit}` : label);
    try {
      const res = await api.get<{ photos: Array<{ url: string; credit: string | null }> }>(`/species/${speciesId}/reference-photos`);
      const slides =
        res.photos.length > 0
          ? res.photos.map((p) => ({ url: p.url, caption: caption(p.credit) }))
          : [{ url: `/api/species/${speciesId}/reference-photo/display`, caption: caption(null) }];
      setSpeciesGallery({ slides, label, index: 0 });
    } catch {
      // Best-effort — fall back to the single photo SuggestionCard's own thumbnail already
      // pointed at, rather than a dead click.
      setSpeciesGallery({ slides: [{ url: `/api/species/${speciesId}/reference-photo/display`, caption: caption(null) }], label, index: 0 });
    }
  }

  // A blob: URL isn't tied to this component's lifecycle — it stays alive in the browser until
  // explicitly revoked, not just because the element referencing it unmounted. removeRow below
  // already revokes one when a photo is explicitly taken out, but a user who instead just
  // navigates away with rows still sitting here (imported or not) would otherwise leak every
  // one of those for the rest of the session. Mirrored into a ref (rather than reading `rows`
  // directly) so the unmount-only cleanup effect below can see the latest rows without re-
  // running on every rows change itself.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  useEffect(() => {
    return () => {
      for (const row of rowsRef.current) URL.revokeObjectURL(row.previewUrl);
    };
  }, []);

  // Experimental (see Settings → species-suggest toggle): defaults to on, but this component
  // never fetches suggestions unless the account setting confirms it's actually enabled — a
  // disabled setting must skip the work, not just hide it in the UI.
  const [suggestEnabled, setSuggestEnabled] = useState(false);
  useEffect(() => {
    api.get<{ speciesSuggestEnabled: boolean }>("/settings").then((res) => setSuggestEnabled(res.speciesSuggestEnabled));
  }, []);

  // Suggestions need a region to narrow candidates against (region_species) — asking the user
  // to pick one up front, once per batch, is both cheaper and more accurate than trying to guess
  // it from EXIF GPS, which many cameras/exports don't even carry. Defaults to whichever region
  // was last viewed on the Collection page (same localStorage key), since that's almost always
  // the region a returning user cares about right now.
  const [regionId, setRegionId] = useState<string | null>(() => localStorage.getItem(LAST_REGION_KEY));

  // A free-text place name (e.g. "Prince George"), independent of exact GPS — most real
  // workflows described a whole import session sharing one location, so it's set once per
  // batch here rather than per photo. Not persisted across sessions like regionId (a location
  // label is specific to wherever this particular outing was, not a lasting preference).
  const [locationLabel, setLocationLabel] = useState("");

  function selectRegion(id: string | null) {
    setRegionId(id);
    if (id) localStorage.setItem(LAST_REGION_KEY, id);
    else localStorage.removeItem(LAST_REGION_KEY);
    if (id && suggestEnabled) {
      // Retroactively re-inspect every row that doesn't have a captureId yet — covers both "the
      // user picked a region after already dropping photos in" and "region changed mid-batch."
      // Re-running the duplicate check here too is a little redundant (it can't have changed),
      // but it's the same one request either way, not a second round trip.
      const pending = rows.filter((r) => !r.captureId);
      mapWithConcurrency(pending, INSPECT_CONCURRENCY, async (row) =>
        row.isVideo ? inspectVideoFile(row.key, row.file, id) : inspectFile(row.key, row.file, id),
      );
    }
  }

  function addFiles(fileList: FileList | File[]) {
    // A camera RAW's file.type is usually empty (browsers don't recognize CR2/NEF/ARW/etc. as
    // a registered image MIME type) — filtering on that alone silently dropped every RAW a
    // user dragged in here. Falls back to extension for exactly those files.
    const files = Array.from(fileList).filter((f) => f.type.startsWith("image/") || isRawFile(f.name) || isVideoFile(f));
    const newRows: ImportRow[] = files.map((file) => ({
      key: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`,
      file,
      previewUrl: URL.createObjectURL(file),
      speciesId: null,
      speciesLabel: null,
      status: "ready",
      suggestions: [],
      isRaw: isRawFile(file.name),
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

  // One request does double duty: the duplicate check (see uploadQueue.ts's own checkDuplicate,
  // which this mirrors for UploadDropzone's flow) AND, given a region, species suggestions —
  // both need this photo's embedding, and /uploads/inspect computes it at most once server-side
  // rather than this making two separate round trips that would each redundantly re-embed the
  // identical file. Best-effort throughout: a failure just leaves this row unflagged/without
  // suggestions, never blocks assigning a species manually.
  async function inspectFile(key: string, file: File, forRegionId: string | null) {
    try {
      const form = new FormData();
      form.append("file", file);
      if (forRegionId) form.append("regionId", forRegionId);
      const res = await api.post<{
        possibleDuplicate: PossibleDuplicate | null;
        suggestions: SuggestedSpecies[];
        previewDataUrl: string | null;
      }>("/uploads/inspect", form);
      setRows((prev) =>
        prev.map((r) =>
          r.key === key
            ? { ...r, possibleDuplicate: res.possibleDuplicate, suggestions: res.suggestions, rawPreviewUrl: res.previewDataUrl, isInspecting: false }
            : r,
        ),
      );
    } catch {
      // leave this row unflagged/without suggestions
      setRows((prev) => prev.map((r) => (r.key === key ? { ...r, isInspecting: false } : r)));
    }
  }

  // A video's own version of inspectFile above — no duplicate-check story yet (video has no
  // sha256/embedding-based near-dup detection the way photos do), just species suggestions,
  // sampled from several frames spread across the clip server-side (see the route's own
  // comment for why several frames beat just one).
  async function inspectVideoFile(key: string, file: File, forRegionId: string | null) {
    try {
      const form = new FormData();
      form.append("file", file);
      if (forRegionId) form.append("regionId", forRegionId);
      const res = await api.post<{ suggestions: SuggestedSpecies[]; error?: string }>("/captures/suggest-species-from-video", form);
      setRows((prev) =>
        prev.map((r) => (r.key === key ? { ...r, suggestions: res.suggestions, suggestError: res.error, isInspecting: false } : r)),
      );
    } catch (err) {
      console.error(err);
      setRows((prev) =>
        prev.map((r) => (r.key === key ? { ...r, suggestError: errorMessage(err, "Couldn't analyze this video"), isInspecting: false } : r)),
      );
    }
  }

  function assignSpecies(keys: string[], result: SpeciesResult) {
    setRows((prev) =>
      prev.map((r) =>
        keys.includes(r.key) ? { ...r, speciesId: result.id, speciesLabel: result.common_name ?? result.scientific_name } : r,
      ),
    );
    // A picked species means this row is ready to import — checking its box automatically
    // gives an at-a-glance sense of what's done, and doubles as pre-selecting it for a bulk
    // action (e.g. removing a batch of already-assigned rows) without an extra click.
    setSelected((prev) => new Set([...prev, ...keys]));
  }

  function removeRow(key: string) {
    setRows((prev) => {
      const row = prev.find((r) => r.key === key);
      if (row) URL.revokeObjectURL(row.previewUrl);
      return prev.filter((r) => r.key !== key);
    });
    setSelected((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    if (focusedRowKey === key) setFocusedRowKey(null);
  }

  // Assign and close this row's search field — the next unassigned row's top suggestion is
  // highlighted (see activeRow/highlightIndex below) so the user can keep going via Enter/arrow
  // keys alone, but nothing about it is actually committed until they do.
  function assignAndAdvance(key: string, result: SpeciesResult) {
    assignSpecies([key], result);
    setFocusedRowKey(null);
  }

  const readyRows = rows.filter((r) => r.speciesId && r.status === "ready");
  const readyCount = readyRows.length;

  // The row keyboard actions apply to: the first still-unassigned row, in list order. Derived
  // rather than tracked in its own state so it always stays in sync with assignment/removal.
  const activeRow = rows.find((r) => !r.speciesId);
  const [highlightIndex, setHighlightIndex] = useState(0);
  useEffect(() => {
    setHighlightIndex(0);
  }, [activeRow?.key]);

  // Undoes a wrong Enter: clears the most recently assigned row before the current active point
  // and reopens it as the active row, with the suggestion it was previously assigned highlighted
  // (not reset to the top guess) — a stray Enter is one Up-arrow-then-Enter away from being
  // corrected instead of requiring a mouse trip back up the list.
  function goBackToPreviousRow() {
    const activeIdx = activeRow ? rows.findIndex((r) => r.key === activeRow.key) : rows.length;
    for (let i = activeIdx - 1; i >= 0; i--) {
      const row = rows[i];
      if (!row.speciesId) continue;
      const prevIndex = row.suggestions.findIndex((s) => s.id === row.speciesId);
      setRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, speciesId: null, speciesLabel: null } : r)));
      setSelected((prev) => {
        if (!prev.has(row.key)) return prev;
        const next = new Set(prev);
        next.delete(row.key);
        return next;
      });
      setHighlightIndex(prevIndex >= 0 ? prevIndex : 0);
      return;
    }
  }

  // Lets a whole batch be assigned without touching the mouse: Left/Right move the highlighted
  // suggestion (matching the suggestion cards' own horizontal layout), Up reopens the previous
  // row instead of the current one's top guess (see goBackToPreviousRow), Enter commits the
  // highlighted suggestion and moves on to the next row. Ignored while a text input has focus
  // (the manual species search box, or anything else on the page) so normal typing/arrow-key
  // text editing isn't hijacked.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        goBackToPreviousRow();
        return;
      }
      if (!activeRow) {
        // Every row already has a species chosen — Enter finishes the batch instead of doing
        // nothing, so the same type/enter rhythm that assigns species also starts the import.
        if (e.key === "Enter" && !importing && readyCount > 0) {
          e.preventDefault();
          importAll();
        }
        return;
      }
      if (activeRow.suggestions.length === 0) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIndex((i) => Math.min(i + 1, activeRow.suggestions.length - 1));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setHighlightIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const pick = activeRow.suggestions[highlightIndex];
        if (pick) assignAndAdvance(activeRow.key, pick);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeRow, highlightIndex, importing, readyCount, rows]);

  function toggleSelected(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function importAll() {
    const toImport = rows.filter((r) => r.speciesId && (r.status === "ready" || r.status === "error"));
    if (toImport.length === 0) return;
    setImporting(true);
    setRows((prev) => prev.map((r) => (toImport.some((t) => t.key === r.key) ? { ...r, status: "uploading" } : r)));

    const committed: Array<{ key: string; captureId: string }> = [];
    await mapWithConcurrency(toImport, UPLOAD_CONCURRENCY, async (row) => {
      // Registers this file in the SAME shared upload-jobs list UploadDropzone/RawUpload
      // already feed — the global banner and every species page's own "uploading" placeholder
      // square are both already reading from it, so a bulk-imported file lights those up too,
      // and (since this request is a plain fetch with no AbortController, same as every other
      // upload path in this app) keeps running to completion even if this whole screen unmounts
      // — leaving/closing the import screen mid-upload was never actually canceling anything,
      // it just gave no visible sign the work was still happening.
      const jobId = registerExternalJob(row.speciesId!, row.file.name);
      try {
        // A video has no "store/link/s3 mode" or RAW-sibling story to opt into — /uploads/video
        // is store-mode only, so `mode` is deliberately omitted for it (the field the photo
        // path below sends would just be ignored, but not sending it at all is clearer).
        const form = new FormData();
        if (!row.isVideo) form.append("mode", "store");
        form.append("speciesId", row.speciesId!);
        if (tripId) form.append("tripId", tripId);
        if (albumId) form.append("albumId", albumId);
        // Persisted on the capture (see migration 067) so the Stats page can answer "which
        // countries have I actually photographed in" without depending on sparse GPS EXIF.
        if (regionId) form.append("regionId", regionId);
        if (locationLabel.trim()) form.append("locationLabel", locationLabel.trim());
        form.append("file", row.file);
        if (row.isVideo) {
          const res = await api.post<{ captureId: string }>("/uploads/video", form);
          committed.push({ key: row.key, captureId: res.captureId });
          setRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, status: "done", captureId: res.captureId } : r)));
          settleExternalJob(jobId);
          return;
        }
        // A RAW that matched an already-imported edited JPEG comes back with linkedExisting:
        // true and no new photo of its own — it's filed as that capture's RAW sibling, not a
        // new row in the collection, but still counts as "done" here since the file is safely
        // stored either way.
        const res = await api.post<{ captureId: string; linkedExisting?: boolean }>("/uploads", form);
        committed.push({ key: row.key, captureId: res.captureId });
        setRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, status: "done", captureId: res.captureId } : r)));
        settleExternalJob(jobId);
      } catch (err) {
        const message = err instanceof ApiError ? err.message : "Upload failed";
        setRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, status: "error", error: message } : r)));
        settleExternalJob(jobId, message);
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
  // "Photo(s)"/"Video(s)" when the ready batch is all one kind, "file(s)" for a mixed batch —
  // matches the "N file(s)" wording already used just above for the whole row count.
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
          accept={`image/*,video/mp4,video/quicktime,${[...VIDEO_EXTENSIONS, ...RAW_EXTENSIONS].join(",")}`}
          className="hidden"
          onChange={(e) => e.target.files && addFiles(e.target.files)}
        />
        <p className="text-sm text-muted">
          Drag JPEGs, RAWs, or videos in, or{" "}
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
              {rows.length} file{rows.length === 1 ? "" : "s"} · {readyCount} ready to import · {doneCount} imported
            </span>
            {selected.size > 0 && (
              <div className="flex items-center gap-2">
                <span>Assign {selected.size} selected to:</span>
                <div className="w-56">
                  <SpeciesPicker
                    placeholder="Type a species…"
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
              <button
                onClick={importAll}
                disabled={importing || readyCount === 0}
                className="rounded-md bg-accent px-3 py-1.5 text-accent-fg disabled:opacity-40"
              >
                {importing ? "Importing…" : `Import ${readyCount || ""} ${readyNoun}${readyCount === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>

          <div className="divide-y divide-line rounded-lg border border-line bg-surface">
            {rows.map((row, i) => {
              // A near-certain top match (essentially the same photo as one already embedded,
              // e.g. your own past capture) makes the rest of the ranked list noise rather
              // than a real choice — show just that one instead of a confident 100% match
              // sitting above four much-less-likely also-rans. The margin-based `confident`
              // flag (embeddings.ts's markConfidence) gets the same treatment for the same
              // reason: once the top pick has already cleared that bar, a trailing 20-30%
              // "closest guess" alongside it reads as noise, not a real alternative worth a
              // second look.
              const topIsCertain = row.suggestions.length > 0 && Math.round(row.suggestions[0].score * 100) >= 100;
              const visibleSuggestions = topIsCertain || row.suggestions[0]?.confident ? row.suggestions.slice(0, 1) : row.suggestions;
              return (
              <div key={row.key} className="p-3">
                <div className="flex items-center gap-3">
                  <input type="checkbox" checked={selected.has(row.key)} onChange={() => toggleSelected(row.key)} className="h-4 w-4" />
                  {row.isRaw && !row.rawPreviewUrl ? (
                    // Browsers can't decode camera RAW sensor data — createObjectURL "works"
                    // (doesn't throw) but the blob URL just renders as a broken image. Shown
                    // until /uploads/inspect's response fills in rawPreviewUrl (the RAW's own
                    // embedded JPEG preview, extracted server-side) — permanently, only if this
                    // particular camera/format has no embedded preview to extract at all.
                    <div
                      onClick={() => setLightboxIndex(i)}
                      className="flex h-14 w-14 cursor-pointer items-center justify-center rounded-md bg-surface-muted text-[10px] font-medium uppercase text-muted"
                    >
                      RAW
                    </div>
                  ) : row.isRaw ? (
                    <img
                      src={row.rawPreviewUrl!}
                      alt=""
                      onClick={() => setLightboxIndex(i)}
                      className="h-14 w-14 cursor-pointer rounded-md object-cover"
                    />
                  ) : row.isVideo ? (
                    // Unlike RAW, a browser CAN decode the local blob directly — muted/no
                    // controls, just enough to show the clip's first frame as a real preview
                    // rather than a generic placeholder icon. preload="metadata" alone often
                    // never actually paints a frame (it only guarantees duration/dimensions are
                    // known, not that anything's been decoded) — nudging currentTime forward a
                    // hair once metadata loads forces a real frame to decode and render.
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
                    <img
                      src={row.previewUrl}
                      alt=""
                      onClick={() => setLightboxIndex(i)}
                      className="h-14 w-14 cursor-pointer rounded-md object-cover"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-ink">{row.file.name}</p>
                    {focusedRowKey === row.key ? (
                      <div className="mt-1 w-64">
                        <SpeciesPicker autoFocus placeholder="Type a species…" onSelect={(r) => assignAndAdvance(row.key, r)} />
                      </div>
                    ) : (
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <button
                          onClick={() => setFocusedRowKey(row.key)}
                          title={row.speciesId ? "Click to change, or see other suggestions again" : undefined}
                          className={`text-xs ${row.speciesId ? "text-ink" : "text-muted"} hover:underline`}
                        >
                          {row.speciesId ? row.speciesLabel : "Type a species…"}
                        </button>
                        {/* Right next to the picker, not off in the row's far-right status column —
                            this is exactly where the user's eye lands first, so that's where "still
                            working on a match" needs to show up, not somewhere they have to go looking. */}
                        {row.isInspecting && !row.speciesId && (
                          <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-accent/40 border-t-accent" />
                        )}
                        {!row.isInspecting && !row.speciesId && row.suggestError && (
                          <span className="text-xs text-muted">{row.suggestError}. Pick a species by hand.</span>
                        )}
                      </div>
                    )}
                  </div>
                  <span className="text-xs text-muted">
                    {row.status === "done" ? "✓ Imported" : row.status === "error" ? row.error : row.status === "uploading" ? "Uploading…" : ""}
                  </span>
                  {row.status !== "uploading" && row.status !== "done" && (
                    <button
                      onClick={() => removeRow(row.key)}
                      title={`Remove this ${row.isVideo ? "video" : "photo"} from the import list`}
                      aria-label="Remove"
                      className="text-muted hover:text-ink"
                    >
                      ✕
                    </button>
                  )}
                </div>
                {row.possibleDuplicate && (
                  <div className="mt-2 ml-7 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
                    <span>
                      {row.possibleDuplicate.exact
                        ? "Looks like you've already imported this photo before. Do you want to import it anyway?"
                        : "Looks like you've already imported a very similar photo (maybe edited or re-exported). Do you want to import it anyway?"}
                    </span>
                    <div className="ml-auto flex items-center gap-2">
                      <button onClick={() => removeRow(row.key)} className="font-medium underline">
                        Remove
                      </button>
                      <button
                        onClick={() => setRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, possibleDuplicate: null } : r)))}
                        className="font-medium underline"
                      >
                        Import anyway
                      </button>
                    </div>
                  </div>
                )}
                {/* An exact content match already has a known answer — showing species
                   suggestions alongside it would just be confusing/redundant, so those wait
                   until the duplicate warning above is actually dismissed. */}
                {!row.possibleDuplicate && (!row.speciesId || focusedRowKey === row.key) && visibleSuggestions.length > 0 && (
                  <div className="mt-2 pl-7">
                    {/* The backend always returns its best guesses, confident or not — flagged
                       here via the margin-based `confident` flag (embeddings.ts's
                       markConfidence), not a raw score comparison, since blending in the
                       zero-shot text signal means the score itself no longer sits on a fixed,
                       intuitively-"percent-like" scale a hardcoded cutoff could compare against. */}
                    {!topIsCertain && row.suggestions.length > 1 && !row.suggestions[0]?.confident && (
                      <p className="mb-1 text-xs text-muted">No confident match. Closest guesses:</p>
                    )}
                    {/* p-1 -m-1: the highlighted card's ring extends outside its own border box,
                       so without this padding overflow-x-auto clips the ring on the leftmost
                       card. The matching negative margin keeps the row's visible left edge in
                       the same place it was before. */}
                    <div className="-m-1 flex gap-2 overflow-x-auto p-1">
                    {visibleSuggestions.map((s, si) => (
                      <SuggestionCard
                        key={s.id}
                        suggestion={s}
                        matchPercent={topIsCertain ? 100 : s.matchPercent ?? Math.round(s.score * 100)}
                        highlighted={row.key === activeRow?.key && si === highlightIndex}
                        onSelect={() => assignAndAdvance(row.key, s)}
                        onViewPhoto={() => viewSpeciesGallery(s.id, s.common_name ?? s.scientific_name)}
                      />
                    ))}
                    </div>
                  </div>
                )}
              </div>
              );
            })}
          </div>
        </>
      )}

      {lightboxIndex != null && (
        <Lightbox
          slides={rows.map((r) => ({
            url: r.isRaw && r.rawPreviewUrl ? r.rawPreviewUrl : r.previewUrl,
            videoUrl: r.isVideo ? r.previewUrl : null,
            noPreview: r.isRaw && !r.rawPreviewUrl,
            caption: r.file.name,
          }))}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}

      {speciesGallery && (
        <Lightbox
          slides={speciesGallery.slides}
          index={speciesGallery.index}
          onIndexChange={(index) => setSpeciesGallery({ ...speciesGallery, index })}
          onClose={() => setSpeciesGallery(null)}
        />
      )}
    </div>
  );
}
