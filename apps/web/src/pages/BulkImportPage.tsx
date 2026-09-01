import { useRef, useState } from "react";
import { enqueueRawUploads } from "../lib/uploadQueue";
import BackToCollectionLink from "../components/BackToCollectionLink";
import PhotoImportRows from "../components/PhotoImportRows";
import { RAW_EXTENSIONS, extname } from "../lib/rawExtensions";

interface RawImportOutcome {
  filename: string;
  linked: boolean;
  collision: boolean;
  speciesCommonName?: string | null;
  speciesScientificName?: string;
  error?: string;
  _key?: string;
}

export default function BulkImportPage() {
  // Separate from the JPEG batch (see PhotoImportRows): no species is picked here at all,
  // since a folder of RAWs pulled off a card can span any number of species. Each RAW is
  // matched independently against JPEGs already in the library (by filename + EXIF timestamp,
  // same logic as a species page's own "Choose a folder…" RAW picker — see
  // RawUpload.tsx/uploads/routes.ts's processOneRawUpload) and filed into the matching
  // species' RAW folder automatically. A RAW with no match, or an ambiguous match, is left
  // untouched on disk rather than guessed at.
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

  return (
    <div className="min-h-screen bg-canvas">
      <header className="page-header flex items-center justify-between border-b border-line bg-surface px-6 py-4">
        <div>
          <BackToCollectionLink className="text-sm text-muted hover:underline" />
          <h1 className="mt-1 text-lg font-semibold text-ink">Bulk import</h1>
        </div>
      </header>

      <main className="space-y-4 p-6">
        <PhotoImportRows />

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
      </main>
    </div>
  );
}
