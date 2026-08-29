import { useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { mapWithConcurrency } from "../lib/concurrency";
import { enqueueRawUploads } from "../lib/uploadQueue";
import SpeciesPicker, { type SpeciesResult } from "../components/SpeciesPicker";
import Lightbox from "../components/Lightbox";
import BackToCollectionLink from "../components/BackToCollectionLink";

const RAW_EXTENSIONS = new Set([".cr2", ".cr3", ".nef", ".nrw", ".arw", ".raf", ".rw2", ".orf", ".dng", ".pef", ".srw", ".tif", ".tiff"]);

function extname(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

interface RawImportOutcome {
  filename: string;
  linked: boolean;
  collision: boolean;
  speciesCommonName?: string | null;
  speciesScientificName?: string;
  error?: string;
  _key?: string;
}

// Phase 5 (spec §9): "a decade of photos onboarded in an evening." AI photo matching was
// tried here (see packages-id/ archive) but shelved after regressions — species assignment is
// fully manual for now, with a keyboard-driven picker (type/arrow/enter) and bulk-assign for
// getting through a large batch quickly.
type RowStatus = "pending" | "ready" | "uploading" | "done" | "error";

interface ImportRow {
  key: string;
  file: File;
  previewUrl: string;
  speciesId: string | null;
  speciesLabel: string | null;
  status: RowStatus;
  captureId?: string;
  error?: string;
}

const UPLOAD_CONCURRENCY = 2;

export default function BulkImportPage() {
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [lastBatch, setLastBatch] = useState<Array<{ key: string; captureId: string }>>([]);
  // row.previewUrl is already a full-resolution local blob URL (URL.createObjectURL(file),
  // see addFiles below), so this reuses the same Lightbox the rest of the app uses for
  // full-size viewing with no extra fetch — the whole file is already sitting in the browser.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);

  // Separate from the JPEG batch above: no species is picked here at all, since a folder of
  // RAWs pulled off a card can span any number of species. Each RAW is matched independently
  // against JPEGs already in the library (by filename + EXIF timestamp, same logic as a
  // species page's own "Choose a folder…" RAW picker — see RawUpload.tsx/uploads/routes.ts's
  // processOneRawUpload) and filed into the matching species' RAW folder automatically. A RAW
  // with no match, or an ambiguous match, is left untouched on disk rather than guessed at.
  const [rawResults, setRawResults] = useState<RawImportOutcome[] | null>(null);
  const [rawError, setRawError] = useState<string | null>(null);
  const rawFilesInputRef = useRef<HTMLInputElement>(null);
  const rawFolderInputRef = useRef<HTMLInputElement>(null);

  function handleRawFiles(fileList: FileList) {
    const files = Array.from(fileList).filter((f) => RAW_EXTENSIONS.has(extname(f.name)));
    setRawError(null);
    if (files.length === 0) {
      setRawError("No supported RAW files found in that selection");
      return;
    }
    const batchId = `${Date.now()}-${Math.random()}`;
    const placeholders: RawImportOutcome[] = files.map((f, i) => ({
      filename: f.name,
      linked: false,
      collision: false,
      _key: `${batchId}-${i}`,
    }));
    setRawResults((prev) => [...(prev ?? []), ...placeholders]);

    enqueueRawUploads<RawImportOutcome>(
      "",
      files,
      () => {},
      (body) => body.results[0],
      {
        onResult: (file, result, requestError) => {
          const key = `${batchId}-${files.indexOf(file)}`;
          setRawResults((prev) =>
            (prev ?? []).map((r) =>
              r._key === key
                ? { ...(result ?? { filename: file.name, linked: false, collision: false, error: requestError ?? "Upload failed" }), _key: key }
                : r,
            ),
          );
        },
      },
    );

    if (rawFilesInputRef.current) rawFilesInputRef.current.value = "";
    if (rawFolderInputRef.current) rawFolderInputRef.current.value = "";
  }

  const rawSuccessCount = rawResults?.filter((r) => r.linked).length ?? 0;

  function addFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
    const newRows: ImportRow[] = files.map((file) => ({
      key: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`,
      file,
      previewUrl: URL.createObjectURL(file),
      speciesId: null,
      speciesLabel: null,
      status: "ready",
    }));
    setRows((prev) => [...prev, ...newRows]);
  }

  function assignSpecies(keys: string[], result: SpeciesResult) {
    setRows((prev) =>
      prev.map((r) =>
        keys.includes(r.key) ? { ...r, speciesId: result.id, speciesLabel: result.common_name ?? result.scientific_name } : r,
      ),
    );
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
        form.append("file", row.file);
        const res = await api.post<{ captureId: string }>("/uploads", form);
        committed.push({ key: row.key, captureId: res.captureId });
        setRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, status: "done", captureId: res.captureId } : r)));
      } catch (err) {
        const message = err instanceof ApiError ? err.message : "Upload failed";
        setRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, status: "error", error: message } : r)));
      }
    });

    setLastBatch(committed);
    setImporting(false);
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
    <div className="min-h-screen bg-canvas">
      <header className="page-header flex items-center justify-between border-b border-line bg-surface px-6 py-4">
        <div>
          <BackToCollectionLink className="text-sm text-muted hover:underline" />
          <h1 className="mt-1 text-lg font-semibold text-ink">Bulk import</h1>
        </div>
        <div className="flex items-center gap-3 text-sm">
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
      </header>

      <main className="space-y-4 p-6">
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
          }}
          onClick={() => filesInputRef.current?.click()}
          className="cursor-pointer rounded-lg border-2 border-dashed border-line p-8 text-center"
        >
          <input
            ref={folderInputRef}
            type="file"
            multiple
            // @ts-expect-error non-standard but widely supported attribute for whole-folder picks
            webkitdirectory=""
            directory=""
            className="hidden"
            onChange={(e) => e.target.files && addFiles(e.target.files)}
          />
          <input
            ref={filesInputRef}
            type="file"
            multiple
            accept="image/*"
            className="hidden"
            onChange={(e) => e.target.files && addFiles(e.target.files)}
          />
          <p className="text-sm text-muted">
            Drag JPEGs in, or{" "}
            <button
              onClick={(e) => {
                e.stopPropagation();
                folderInputRef.current?.click();
              }}
              className="text-ink underline"
            >
              choose a folder
            </button>{" "}
            /{" "}
            <button
              onClick={(e) => {
                e.stopPropagation();
                filesInputRef.current?.click();
              }}
              className="text-ink underline"
            >
              choose files
            </button>
          </p>
          <p className="mt-1 text-xs text-muted">Assign a species to each photo below, then import.</p>
        </div>

        <div className="rounded-lg border border-line bg-surface p-4">
          <h2 className="text-sm font-medium text-ink">Bulk import RAW files</h2>
          <p className="mt-1 text-xs text-muted">
            Point this at a whole export folder or SD card instead of assigning species one by one. Each RAW is
            matched against photos already in your library by camera timestamp and filed straight into the right
            species' RAW folder, no species picker needed. Anything that doesn't match a photo you've already kept
            is left untouched on your drive rather than guessed at.
          </p>
          <input
            ref={rawFilesInputRef}
            type="file"
            multiple
            accept={[...RAW_EXTENSIONS].join(",")}
            className="hidden"
            id="bulk-raw-files-input"
            onChange={(e) => e.target.files && handleRawFiles(e.target.files)}
          />
          <input
            ref={rawFolderInputRef}
            type="file"
            multiple
            // @ts-expect-error non-standard, but supported in every browser Lifer targets (Chromium/Firefox/Safari)
            webkitdirectory=""
            className="hidden"
            id="bulk-raw-folder-input"
            onChange={(e) => e.target.files && handleRawFiles(e.target.files)}
          />
          <div className="mt-2 flex gap-4">
            <label htmlFor="bulk-raw-files-input" className="cursor-pointer text-sm text-muted hover:underline">
              Choose RAW files…
            </label>
            <label htmlFor="bulk-raw-folder-input" className="cursor-pointer text-sm text-muted hover:underline">
              Choose a folder…
            </label>
          </div>
          {rawError && <p className="mt-2 text-sm text-red-600">{rawError}</p>}
          {rawResults && (
            <div className="mt-2 space-y-1">
              <p className="text-xs font-medium text-muted">
                {rawSuccessCount} of {rawResults.length} linked
              </p>
              {rawResults
                .filter((r) => r.linked || r.error || r.collision)
                .map((r, i) => (
                  <p key={i} className="text-xs text-muted">
                    <span className="text-ink">{r.filename}</span>
                    {": "}
                    {r.error ? (
                      <span className="text-red-600">{r.error}</span>
                    ) : r.collision ? (
                      <span className="text-amber-600">matched more than one photo with the same camera fingerprint — skipped</span>
                    ) : (
                      <span className="text-emerald-700">filed under {r.speciesCommonName ?? r.speciesScientificName}</span>
                    )}
                  </p>
                ))}
            </div>
          )}
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
            </div>

            <div className="divide-y divide-line rounded-lg border border-line bg-surface">
              {rows.map((row, i) => (
                <div key={row.key} className="flex items-center gap-3 p-3">
                  <input
                    type="checkbox"
                    checked={selected.has(row.key)}
                    onChange={() => toggleSelected(row.key)}
                    className="h-4 w-4"
                  />
                  <img
                    src={row.previewUrl}
                    alt=""
                    onClick={() => setLightboxIndex(i)}
                    className="h-14 w-14 cursor-pointer rounded-md object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-ink">{row.file.name}</p>
                    {focusedRowKey === row.key ? (
                      <div className="mt-1 w-64">
                        <SpeciesPicker
                          autoFocus
                          placeholder="Type a species…"
                          onSelect={(r) => assignAndAdvance(row.key, r)}
                        />
                      </div>
                    ) : (
                      <button
                        onClick={() => setFocusedRowKey(row.key)}
                        className={`mt-0.5 text-xs ${row.speciesId ? "text-ink" : "text-muted"} hover:underline`}
                      >
                        {row.speciesId ? row.speciesLabel : "Click to assign species…"}
                      </button>
                    )}
                  </div>
                  <span className="text-xs text-muted">
                    {row.status === "done" ? "✓ Imported" : row.status === "error" ? row.error : row.status === "uploading" ? "Uploading…" : ""}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </main>
      {lightboxIndex != null && (
        <Lightbox
          slides={rows.map((r) => ({ url: r.previewUrl, caption: r.file.name }))}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
}
