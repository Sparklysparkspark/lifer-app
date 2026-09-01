import { useRef, useState } from "react";
import { enqueueRawUploads } from "../lib/uploadQueue";

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
  /** Internal only — identifies this placeholder's own list entry so a result can be routed
   *  back to the right row even when two files in the same (or overlapping) batch share a
   *  filename, e.g. same-named RAWs in different subfolders. Never rendered. */
  _key?: string;
}

// Standalone RAW upload, matched by EXIF fingerprint against already-uploaded JPEGs, with no
// species picker needed since the match determines the species. Accepts many files (or a
// whole folder) at once; each is matched independently, so a mixed batch of hits/misses/
// collisions is reported per file rather than all-or-nothing. Requests run through the shared
// background queue (lib/uploadQueue) — closing this dialog, or navigating away entirely,
// doesn't stop or lose them; only this component's own inline result list goes away if it's
// not mounted to receive it (the global upload banner still shows progress either way).
export default function RawUpload({
  speciesId,
  volumeId,
  matchOnly,
  onFiled,
}: {
  speciesId: string;
  /** Registered external drive to save into, or "" for the primary drive — see
   *  VolumeDestinationPicker, rendered by the parent dialog above both upload controls. */
  volumeId: string;
  /** Hides "Choose RAW files…" (the unmatched-fallback picker, which files an orphan RAW
   *  straight under `speciesId`) — for a context with no single species to fall back to, like
   *  a trip spanning many species (see TripDetailPage.tsx's build-mode panel). Matching against
   *  already-uploaded JPEGs (via "Choose a folder…") needs no species hint at all — the match
   *  itself determines the species — so this only removes the picker that WOULD need one. */
  matchOnly?: boolean;
  onFiled?: () => void;
}) {
  const [results, setResults] = useState<RawUploadOutcome[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // allowUnmatchedFallback is only ever true from the "Choose RAW files…" picker below, never
  // from "Choose a folder…" — this page knows which species a directly-chosen file belongs
  // to, whereas a folder full of RAWs may span many species, so only files that match an
  // existing JPEG should be filed from a folder upload. The destination drive (volumeId)
  // applies either way — it's a storage preference, independent of which species matched.
  function handleFiles(fileList: FileList, allowUnmatchedFallback: boolean) {
    const files = Array.from(fileList).filter((f) => RAW_EXTENSIONS.has(extname(f.name)));
    setError(null);
    if (files.length === 0) {
      setError("No supported RAW files found in that selection");
      return;
    }
    // A unique key per file in this batch — not the filename, which two RAWs in the same
    // folder-wide upload can legitimately share (different subfolders) — so each result routes
    // back to its own placeholder row instead of the first pending row with a matching name.
    const batchId = `${Date.now()}-${Math.random()}`;
    const placeholders: RawUploadOutcome[] = files.map((f, i) => ({ filename: f.name, linked: false, collision: false, _key: `${batchId}-${i}` }));
    setResults((prev) => [...(prev ?? []), ...placeholders]);

    enqueueRawUploads<RawUploadOutcome>(
      speciesId,
      files,
      (_file, form) => {
        if (allowUnmatchedFallback) {
          form.append("speciesId", speciesId);
          form.append("allowUnmatchedFallback", "1");
        }
        if (volumeId) form.append("volumeId", volumeId);
      },
      (body) => body.results[0],
      {
        onResult: (file, result, requestError) => {
          const key = `${batchId}-${files.indexOf(file)}`;
          setResults((prev) =>
            (prev ?? []).map((r) =>
              r._key === key
                ? { ...(result ?? { filename: file.name, linked: false, collision: false, error: requestError ?? "Upload failed" }), _key: key }
                : r,
            ),
          );
        },
        onBatchSettled: () => {
          setResults((prev) => {
            if (prev?.some((r) => r.filed)) onFiled?.();
            return prev;
          });
        },
      },
    );

    if (filesInputRef.current) filesInputRef.current.value = "";
    if (folderInputRef.current) folderInputRef.current.value = "";
  }

  const successCount = results?.filter((r) => r.linked || r.filed).length ?? 0;

  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <h2 className="text-sm font-medium text-ink">Upload RAW files</h2>
      <p className="mt-1 text-xs text-muted">
        {matchOnly
          ? "Point this at a folder of RAWs — each is matched by camera timestamp/serial against photos you've already added and filed into the right species' RAW folder. Anything that doesn't match a photo you've kept is left untouched on your own drive."
          : "Point this at RAW files — each is matched by camera timestamp/serial against your uploads and filed straight into the right species' RAW folder. A RAW with no match still gets filed here, under this species, since that's already known. Point it at a whole export folder instead, though, and only the RAWs that match a JPEG you've kept get imported — a folder could span species this page has no way to know about, so anything else in it is left untouched on your own drive."}
      </p>
      {!matchOnly && (
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
      )}
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
        {!matchOnly && (
          <label htmlFor="raw-upload-files-input" className="cursor-pointer text-sm text-muted hover:underline">
            Choose RAW files…
          </label>
        )}
        <label htmlFor="raw-upload-folder-input" className="cursor-pointer text-sm text-muted hover:underline">
          Choose a folder…
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
