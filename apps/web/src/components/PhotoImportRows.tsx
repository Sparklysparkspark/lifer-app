import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { mapWithConcurrency } from "../lib/concurrency";
import type { PossibleDuplicate } from "../lib/uploadQueue";
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
  /** A camera RAW has no browser-renderable preview (sharp/the browser can't decode raw
   *  sensor data) — shown as a placeholder icon instead of trying to load previewUrl as an
   *  <img>, which would just be a broken-image icon. */
  isRaw?: boolean;
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
export default function PhotoImportRows({ tripId, onImported }: { tripId?: string; onImported?: () => void }) {
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
  const [speciesGallery, setSpeciesGallery] = useState<{ slides: LightboxSlide[]; label: string } | null>(null);

  async function viewSpeciesGallery(speciesId: string, label: string) {
    const caption = (credit: string | null) => (credit ? `${label} · ${credit}` : label);
    try {
      const res = await api.get<{ photos: Array<{ url: string; credit: string | null }> }>(`/species/${speciesId}/reference-photos`);
      const slides =
        res.photos.length > 0
          ? res.photos.map((p) => ({ url: p.url, caption: caption(p.credit) }))
          : [{ url: `/api/species/${speciesId}/reference-photo/display`, caption: caption(null) }];
      setSpeciesGallery({ slides, label });
    } catch {
      // Best-effort — fall back to the single photo SuggestionCard's own thumbnail already
      // pointed at, rather than a dead click.
      setSpeciesGallery({ slides: [{ url: `/api/species/${speciesId}/reference-photo/display`, caption: caption(null) }], label });
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
      mapWithConcurrency(pending, INSPECT_CONCURRENCY, async (row) => inspectFile(row.key, row.file, id));
    }
  }

  function addFiles(fileList: FileList | File[]) {
    // A camera RAW's file.type is usually empty (browsers don't recognize CR2/NEF/ARW/etc. as
    // a registered image MIME type) — filtering on that alone silently dropped every RAW a
    // user dragged in here. Falls back to extension for exactly those files.
    const files = Array.from(fileList).filter((f) => f.type.startsWith("image/") || isRawFile(f.name));
    const newRows: ImportRow[] = files.map((file) => ({
      key: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`,
      file,
      previewUrl: URL.createObjectURL(file),
      speciesId: null,
      speciesLabel: null,
      status: "ready",
      suggestions: [],
      isRaw: isRawFile(file.name),
    }));
    setRows((prev) => [...prev, ...newRows]);
    mapWithConcurrency(newRows, INSPECT_CONCURRENCY, async (row) => inspectFile(row.key, row.file, suggestEnabled ? regionId : null));
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
      const res = await api.post<{ possibleDuplicate: PossibleDuplicate | null; suggestions: SuggestedSpecies[] }>(
        "/uploads/inspect",
        form,
      );
      setRows((prev) =>
        prev.map((r) => (r.key === key ? { ...r, possibleDuplicate: res.possibleDuplicate, suggestions: res.suggestions } : r)),
      );
    } catch {
      // leave this row unflagged/without suggestions
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

  // "type, arrow, enter, next" (spec §9 Phase 5) — after assigning one row, jump straight to
  // the next row that still needs a species instead of leaving the user to click again.
  function assignAndAdvance(key: string, result: SpeciesResult) {
    assignSpecies([key], result);
    const idx = rows.findIndex((r) => r.key === key);
    const next = rows.slice(idx + 1).find((r) => !r.speciesId);
    setFocusedRowKey(next ? next.key : null);
  }

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
      try {
        const form = new FormData();
        form.append("mode", "store");
        form.append("speciesId", row.speciesId!);
        if (tripId) form.append("tripId", tripId);
        form.append("file", row.file);
        // A RAW that matched an already-imported edited JPEG comes back with linkedExisting:
        // true and no new photo of its own — it's filed as that capture's RAW sibling, not a
        // new row in the collection, but still counts as "done" here since the file is safely
        // stored either way.
        const res = await api.post<{ captureId: string; linkedExisting?: boolean }>("/uploads", form);
        committed.push({ key: row.key, captureId: res.captureId });
        setRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, status: "done", captureId: res.captureId } : r)));
      } catch (err) {
        const message = err instanceof ApiError ? err.message : "Upload failed";
        setRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, status: "error", error: message } : r)));
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

  const readyCount = rows.filter((r) => r.speciesId && r.status === "ready").length;
  const doneCount = rows.filter((r) => r.status === "done").length;

  return (
    <div className="space-y-4">
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
        onClick={() => document.getElementById(`photo-import-files-${tripId ?? "general"}`)?.click()}
        className="cursor-pointer rounded-lg border-2 border-dashed border-line p-8 text-center"
      >
        <input
          id={`photo-import-folder-${tripId ?? "general"}`}
          type="file"
          multiple
          // @ts-expect-error non-standard but widely supported attribute for whole-folder picks
          webkitdirectory=""
          directory=""
          className="hidden"
          onChange={(e) => e.target.files && addFiles(e.target.files)}
        />
        <input
          id={`photo-import-files-${tripId ?? "general"}`}
          type="file"
          multiple
          accept={`image/*,${[...RAW_EXTENSIONS].join(",")}`}
          className="hidden"
          onChange={(e) => e.target.files && addFiles(e.target.files)}
        />
        <p className="text-sm text-muted">
          Drag JPEGs or RAWs in, or{" "}
          <button
            onClick={(e) => {
              e.stopPropagation();
              document.getElementById(`photo-import-folder-${tripId ?? "general"}`)?.click();
            }}
            className="text-ink underline"
          >
            choose a folder
          </button>{" "}
          /{" "}
          <button
            onClick={(e) => {
              e.stopPropagation();
              document.getElementById(`photo-import-files-${tripId ?? "general"}`)?.click();
            }}
            className="text-ink underline"
          >
            choose files
          </button>
        </p>
        <p className="mt-1 text-xs text-muted">Assign a species to each photo below, then import.</p>
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
                {importing ? "Importing…" : `Import ${readyCount || ""} photo${readyCount === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>

          <div className="divide-y divide-line rounded-lg border border-line bg-surface">
            {rows.map((row, i) => {
              // A near-certain top match (essentially the same photo as one already embedded,
              // e.g. your own past capture) makes the rest of the ranked list noise rather
              // than a real choice — show just that one instead of a confident 100% match
              // sitting above four much-less-likely also-rans.
              const topIsCertain = row.suggestions.length > 0 && Math.round(row.suggestions[0].score * 100) >= 100;
              const visibleSuggestions = topIsCertain ? row.suggestions.slice(0, 1) : row.suggestions;
              return (
              <div key={row.key} className="p-3">
                <div className="flex items-center gap-3">
                  <input type="checkbox" checked={selected.has(row.key)} onChange={() => toggleSelected(row.key)} className="h-4 w-4" />
                  {row.isRaw ? (
                    // Browsers can't decode camera RAW sensor data — createObjectURL "works"
                    // (doesn't throw) but the blob URL just renders as a broken image, so this
                    // shows a plain RAW badge instead of a doomed <img>.
                    <div
                      onClick={() => setLightboxIndex(i)}
                      className="flex h-14 w-14 cursor-pointer items-center justify-center rounded-md bg-surface-muted text-[10px] font-medium uppercase text-muted"
                    >
                      RAW
                    </div>
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
                      <button
                        onClick={() => setFocusedRowKey(row.key)}
                        title={row.speciesId ? "Click to change, or see other suggestions again" : undefined}
                        className={`mt-0.5 text-xs ${row.speciesId ? "text-ink" : "text-muted"} hover:underline`}
                      >
                        {row.speciesId ? row.speciesLabel : "Type a species…"}
                      </button>
                    )}
                  </div>
                  <span className="text-xs text-muted">
                    {row.status === "done" ? "✓ Imported" : row.status === "error" ? row.error : row.status === "uploading" ? "Uploading…" : ""}
                  </span>
                  {row.status !== "uploading" && row.status !== "done" && (
                    <button
                      onClick={() => removeRow(row.key)}
                      title="Remove this photo from the import list"
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
                  <div className="mt-2 flex gap-2 overflow-x-auto pl-7">
                    {visibleSuggestions.map((s) => (
                      <SuggestionCard
                        key={s.id}
                        suggestion={s}
                        matchPercent={topIsCertain || row.suggestions.length === 1 ? 100 : Math.round(s.score * 100)}
                        onSelect={() => assignAndAdvance(row.key, s)}
                        onViewPhoto={() => viewSpeciesGallery(s.id, s.common_name ?? s.scientific_name)}
                      />
                    ))}
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
          slides={rows.map((r) => ({ url: r.previewUrl, caption: r.file.name }))}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}

      {speciesGallery && (
        <Lightbox
          slides={speciesGallery.slides}
          index={0}
          onIndexChange={() => {}}
          onClose={() => setSpeciesGallery(null)}
        />
      )}
    </div>
  );
}
