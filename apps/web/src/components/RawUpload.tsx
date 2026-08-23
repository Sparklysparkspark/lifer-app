import { useRef, useState } from "react";
import { api, ApiError } from "../api/client";

const RAW_EXTENSIONS = new Set([".cr2", ".cr3", ".nef", ".nrw", ".arw", ".raf", ".rw2", ".orf", ".dng", ".pef", ".srw", ".tif", ".tiff"]);

function extname(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

interface RawUploadOutcome {
  filename: string;
  linked: boolean;
  collision: boolean;
  speciesCommonName?: string | null;
  speciesScientificName?: string;
  error?: string;
  /** Filed straight into this species' RAW folder — no matching JPEG needed. Only possible
   *  via "Choose RAW files…", not "Choose a folder…" — see handleFiles' own comment. */
  filed?: boolean;
  /** Identical content already on file for this species — not re-added. */
  duplicate?: boolean;
}

// Standalone RAW upload, matched by EXIF fingerprint against already-uploaded JPEGs, with no
// species picker needed since the match determines the species. Accepts many files (or a
// whole folder) at once; each is matched independently, so a mixed batch of hits/misses/
// collisions is reported per file rather than all-or-nothing.
export default function RawUpload({ speciesId, onFiled }: { speciesId: string; onFiled?: () => void }) {
  const [results, setResults] = useState<RawUploadOutcome[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const filesInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // One request per file instead of one giant multipart request for the whole batch — a
  // folder of real camera RAWs can easily add up to several hundred MB combined even though
  // each file alone is well within the per-file limit. Filtered to RAW extensions client-side
  // first (a folder picker also grabs JPEGs, .DS_Store, XMP sidecars, etc.) so a request is
  // never wasted on a file the server would just skip anyway. Sent concurrently — the
  // browser's own per-origin connection limit throttles this naturally, no manual concurrency
  // cap needed.
  //
  // allowUnmatchedFallback is only ever true from the "Choose RAW files…" picker below, never
  // from "Choose a folder…" — this page knows which species a directly-chosen file belongs
  // to, whereas a folder full of RAWs may span many species, so only files that match an
  // existing JPEG should be filed from a folder upload.
  async function handleFiles(fileList: FileList, allowUnmatchedFallback: boolean) {
    const files = Array.from(fileList).filter((f) => RAW_EXTENSIONS.has(extname(f.name)));
    setError(null);
    setResults(null);
    if (files.length === 0) {
      setError("No supported RAW files found in that selection");
      return;
    }
    setUploading(true);
    try {
      const outcomes = await Promise.all(
        files.map(async (file): Promise<RawUploadOutcome> => {
          try {
            const form = new FormData();
            if (allowUnmatchedFallback) {
              form.append("speciesId", speciesId);
              form.append("allowUnmatchedFallback", "1");
            }
            form.append("file", file);
            const res = await api.post<{ results: RawUploadOutcome[] }>("/uploads/raw", form);
            return res.results[0];
          } catch (err) {
            return { filename: file.name, linked: false, collision: false, error: err instanceof ApiError ? err.message : "Upload failed" };
          }
        }),
      );
      setResults(outcomes);
      if (outcomes.some((o) => o.filed)) onFiled?.();
    } finally {
      setUploading(false);
      if (filesInputRef.current) filesInputRef.current.value = "";
      if (folderInputRef.current) folderInputRef.current.value = "";
    }
  }

  const successCount = results?.filter((r) => r.linked || r.filed).length ?? 0;

  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <h2 className="text-sm font-medium text-ink">Upload RAW files</h2>
      <p className="mt-1 text-xs text-muted">
        Point this at RAW files — each is matched by camera timestamp/serial against your uploads and filed straight
        into the right species' RAW folder. A RAW with no match still gets filed here, under this species, since
        that's already known. Point it at a whole export folder instead, though, and only the RAWs that match a JPEG
        you've kept get imported — a folder could span species this page has no way to know about, so anything else
        in it is left untouched on your own drive.
      </p>
      <input
        ref={filesInputRef}
        type="file"
        multiple
        accept={[...RAW_EXTENSIONS].join(",")}
        className="hidden"
        id="raw-upload-files-input"
        onChange={(e) => {
          if (e.target.files) handleFiles(e.target.files, true);
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        // @ts-expect-error non-standard, but supported in every browser Lifer targets (Chromium/Firefox/Safari)
        webkitdirectory=""
        className="hidden"
        id="raw-upload-folder-input"
        onChange={(e) => {
          if (e.target.files) handleFiles(e.target.files, false);
        }}
      />
      <div className="mt-2 flex gap-4">
        <label htmlFor="raw-upload-files-input" className="cursor-pointer text-sm text-muted hover:underline">
          {uploading ? "Matching…" : "Choose RAW files…"}
        </label>
        <label htmlFor="raw-upload-folder-input" className="cursor-pointer text-sm text-muted hover:underline">
          {uploading ? "Matching…" : "Choose a folder…"}
        </label>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {results && (
        <div className="mt-2 space-y-1">
          <p className="text-xs font-medium text-muted">
            {successCount} of {results.length} added
          </p>
          {/* A folder-wide run can be hundreds of files; a plain "no matching photo" result
             for most of them is noise rather than information, so only real outcomes (a
             match, a collision, a duplicate, or an actual error) are listed. */}
          {results
            .filter((r) => r.linked || r.filed || r.duplicate || r.error || r.collision)
            .map((r, i) => (
              <p key={i} className="text-xs text-muted">
                <span className="text-ink">{r.filename}</span>
                {": "}
                {r.error ? (
                  <span className="text-red-600">{r.error}</span>
                ) : r.collision ? (
                  <span className="text-amber-600">matched more than one photo with the same camera fingerprint — skipped</span>
                ) : r.duplicate ? (
                  <span className="text-muted">already added — skipped</span>
                ) : r.filed ? (
                  <span className="text-emerald-700">added to {r.speciesCommonName ?? r.speciesScientificName}'s RAW folder</span>
                ) : (
                  <span className="text-emerald-700">filed under {r.speciesCommonName ?? r.speciesScientificName}</span>
                )}
              </p>
            ))}
        </div>
      )}
    </div>
  );
}
