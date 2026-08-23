import { useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { mapWithConcurrency } from "../lib/concurrency";
import SpeciesPicker, { type SpeciesResult } from "../components/SpeciesPicker";
import Lightbox from "../components/Lightbox";
import BackToCollectionLink from "../components/BackToCollectionLink";

// Phase 5 (spec §9): "a decade of photos onboarded in an evening." Three things chain
// together here — drag a whole folder in, auto-guess the species from folder names/XMP
// keywords so most rows need zero typing, and a keyboard-driven picker (type/arrow/enter)
// for the rest, with bulk-assign for whatever's left after that.
type RowStatus = "pending" | "inspecting" | "ready" | "uploading" | "done" | "error";

interface ImportRow {
  key: string;
  file: File;
  previewUrl: string;
  folderHint: string | null;
  keywords: string[] | null;
  speciesId: string | null;
  speciesLabel: string | null;
  autoMatched: boolean;
  status: RowStatus;
  captureId?: string;
  error?: string;
}

const INSPECT_CONCURRENCY = 4;
const UPLOAD_CONCURRENCY = 2;

function folderHintFromFile(file: File): string | null {
  // webkitRelativePath is only populated when the file came from a <input webkitdirectory>
  // folder pick — "MyPhotos/Mallard/img001.jpg" -> "Mallard" (spec: "folder-structure
  // import: treat directory names as species names"). Plain drag-and-drop files have no
  // relative path, so this is null for those (a known limitation of drag-and-drop).
  const relPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  if (!relPath) return null;
  const parts = relPath.split("/");
  return parts.length >= 2 ? parts[parts.length - 2] : null;
}

async function findSpeciesMatch(candidate: string): Promise<SpeciesResult | null> {
  if (!candidate.trim()) return null;
  const res = await api.get<{ results: SpeciesResult[] }>(`/species?q=${encodeURIComponent(candidate)}`);
  return res.results[0] ?? null;
}

function isExactMatch(candidate: string, result: SpeciesResult): boolean {
  const norm = (s: string) => s.trim().toLowerCase();
  return norm(candidate) === norm(result.common_name ?? "") || norm(candidate) === norm(result.scientific_name);
}

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

  function addFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList).filter((f) => f.type === "image/jpeg" || f.type === "image/jpg");
    const newRows: ImportRow[] = files.map((file) => ({
      key: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`,
      file,
      previewUrl: URL.createObjectURL(file),
      folderHint: folderHintFromFile(file),
      keywords: null,
      speciesId: null,
      speciesLabel: null,
      autoMatched: false,
      status: "pending",
    }));
    setRows((prev) => [...prev, ...newRows]);
    inspectRows(newRows);
  }

  async function inspectRows(newRows: ImportRow[]) {
    setRows((prev) => prev.map((r) => (newRows.some((n) => n.key === r.key) ? { ...r, status: "inspecting" } : r)));

    await mapWithConcurrency(newRows, INSPECT_CONCURRENCY, async (row) => {
      let keywords: string[] = [];
      try {
        const form = new FormData();
        form.append("file", row.file);
        const res = await api.post<{ keywords: string[] }>("/uploads/inspect", form);
        keywords = res.keywords;
      } catch {
        // Inspection is best-effort — a failure here just means no auto-match, not a
        // blocked import; the row still gets a manual picker.
      }

      const candidates = [row.folderHint, ...keywords].filter((c): c is string => !!c);
      let match: SpeciesResult | null = null;
      let exact = false;
      for (const candidate of candidates) {
        const result = await findSpeciesMatch(candidate);
        if (result && isExactMatch(candidate, result)) {
          match = result;
          exact = true;
          break;
        }
        if (result && !match) match = result; // keep the first hit as a non-exact suggestion
      }

      setRows((prev) =>
        prev.map((r) =>
          r.key === row.key
            ? {
                ...r,
                keywords,
                status: "ready",
                speciesId: exact ? match!.id : r.speciesId,
                speciesLabel: exact ? (match!.common_name ?? match!.scientific_name) : r.speciesLabel,
                autoMatched: exact,
              }
            : r,
        ),
      );
    });
  }

  function assignSpecies(keys: string[], result: SpeciesResult) {
    setRows((prev) =>
      prev.map((r) =>
        keys.includes(r.key)
          ? { ...r, speciesId: result.id, speciesLabel: result.common_name ?? result.scientific_name, autoMatched: false }
          : r,
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
          className="rounded-lg border-2 border-dashed border-line p-8 text-center"
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
            accept="image/jpeg"
            className="hidden"
            onChange={(e) => e.target.files && addFiles(e.target.files)}
          />
          <p className="text-sm text-muted">
            Drag JPEGs in, or{" "}
            <button onClick={() => folderInputRef.current?.click()} className="text-ink underline">
              choose a folder
            </button>{" "}
            /{" "}
            <button onClick={() => filesInputRef.current?.click()} className="text-ink underline">
              choose files
            </button>
          </p>
          <p className="mt-1 text-xs text-muted">
            Folder names and XMP keywords/tags on the files are used to auto-guess the species. Drag-and-drop only sees
            individual files, not folder structure — use "choose a folder" for folder-name matching.
          </p>
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
                    {row.status === "inspecting" && <p className="text-xs text-muted">Reading keywords…</p>}
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
                        {row.speciesId
                          ? `${row.speciesLabel}${row.autoMatched ? " (auto-matched)" : ""}`
                          : "Click to assign species…"}
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
