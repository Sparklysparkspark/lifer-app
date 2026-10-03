import { useRef, useState } from "react";
import { enqueueRawUploads } from "../lib/uploadQueue";
import FormMessage from "./FormMessage";
import { RAW_EXTENSIONS, extname } from "../lib/rawExtensions";

interface RawUploadOutcome {
  filename: string;
  linked: boolean;
  collision: boolean;
  speciesCommonName?: string | null;
  speciesScientificName?: string;
  error?: string;
  /** Filed under this species with no matching JPEG (only from "Choose RAW files…"). */
  filed?: boolean;
  /** Identical content already on file for this species, not re-added. */
  duplicate?: boolean;
  /** Routes a result back to its row when two files in a batch share a filename. Never rendered. */
  _key?: string;
}

// RAW upload matched by EXIF fingerprint against already-uploaded JPEGs, which decides the species.
// Uploads run on the shared background queue, so they continue if this unmounts.
export default function RawUpload({
  speciesId,
  volumeId,
  matchOnly,
  onFiled,
}: {
  speciesId: string;
  /** Registered drive to save into, or "" for the main library (see VolumeDestinationPicker). */
  volumeId: string;
  /** Hides "Choose RAW files…", which files unmatched RAWs under `speciesId`. For contexts with
   *  no single species, like a trip. */
  matchOnly?: boolean;
  onFiled?: () => void;
}) {
  const [results, setResults] = useState<RawUploadOutcome[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Only directly chosen files fall back to this species; a folder may span many species, so
  // only its matched RAWs are filed. The destination drive applies either way.
  function handleFiles(fileList: FileList, allowUnmatchedFallback: boolean) {
    const files = Array.from(fileList).filter((f) => RAW_EXTENSIONS.has(extname(f.name)));
    setError(null);
    if (files.length === 0) {
      setError("No supported RAW files found in that selection");
      return;
    }
    // Keyed per file, not by filename, which RAWs in different subfolders can share.
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
          ? "Point this at a folder of RAWs. Each is matched by camera timestamp/serial against photos you've already added and filed into the right species' RAW folder. Anything that doesn't match a photo you've kept is left untouched on your own drive."
          : "Point this at RAW files. Each is matched by camera timestamp/serial against your uploads and filed straight into the right species' RAW folder. A RAW with no match still gets filed here, under this species, since that's already known. Point it at a whole export folder instead, though, and only the RAWs that match a JPEG you've kept get imported. A folder could span species this page has no way to know about, so anything else in it is left untouched on your own drive."}
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
      <FormMessage error={error} className="mt-2" />
      {results && (
        <div className="mt-2 space-y-1">
          <p className="text-xs font-medium text-muted">
            {successCount} of {results.length} added
          </p>
          {/* A folder run can be hundreds of files, so plain "no match" rows are left out. */}
          {results
            .filter((r) => r.linked || r.filed || r.duplicate || r.error || r.collision)
            .map((r, i) => (
              <p key={i} className="text-xs text-muted">
                <span className="text-ink">{r.filename}</span>
                {": "}
                {r.error ? (
                  <span className="text-rose-700 dark:text-rose-400">{r.error}</span>
                ) : r.collision ? (
                  <span className="text-amber-600">matched more than one photo with the same camera fingerprint, skipped</span>
                ) : r.duplicate ? (
                  <span className="text-muted">already added, skipped</span>
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
