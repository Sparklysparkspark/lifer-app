import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { enqueueRawUploads } from "../lib/uploadQueue";
import PageHeader from "../components/PageHeader";
import PhotoImportRows from "../components/PhotoImportRows";
import { RAW_EXTENSIONS, extname } from "../lib/rawExtensions";
import FormMessage from "../components/FormMessage";
import { useSpeciesName } from "../lib/speciesName";

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
  // RAWs need no species: each is matched to an imported JPEG by filename and EXIF timestamp
  // (same as RawUpload) and filed under that species. No match or an ambiguous one is skipped.
  const navigate = useNavigate();
  const { t } = useTranslation();
  const speciesName = useSpeciesName();
  const [rawResults, setRawResults] = useState<RawImportOutcome[] | null>(null);
  const [rawError, setRawError] = useState<string | null>(null);
  const rawFilesInputRef = useRef<HTMLInputElement>(null);
  const rawFolderInputRef = useRef<HTMLInputElement>(null);

  function handleRawFiles(fileList: FileList) {
    const files = Array.from(fileList).filter((f) => RAW_EXTENSIONS.has(extname(f.name)));
    setRawError(null);
    if (files.length === 0) {
      setRawError(t("upload.raw.noneFound"));
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
                ? {
                    ...(result ?? {
                      filename: file.name,
                      linked: false,
                      collision: false,
                      error: requestError ?? t("upload.failed"),
                    }),
                    _key: key,
                  }
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
    <div className="flex-1 bg-canvas">
      <PageHeader sticky title={t("import.bulk.title")} />

      <main className="space-y-4 p-6">
        {/* Back to the collection once everything is uploading (uploads continue in the background).
            Stays put when some rows weren't included, since leaving would drop them. */}
        <PhotoImportRows onImportStarted={(everyRowIncluded) => everyRowIncluded && navigate("/")} />

        <div className="rounded-lg border border-line bg-surface p-4">
          <h2 className="text-sm font-medium text-ink">{t("import.bulk.raw.title")}</h2>
          <p className="mt-1 text-xs text-muted">{t("import.bulk.raw.description")}</p>
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
              {t("upload.raw.chooseFiles")}
            </label>
            <label htmlFor="bulk-raw-folder-input" className="cursor-pointer text-sm text-muted hover:underline">
              {t("upload.raw.chooseFolder")}
            </label>
          </div>
          <FormMessage error={rawError} className="mt-2" />
          {rawResults && (
            <div className="mt-2 space-y-1">
              <p className="text-xs font-medium text-muted">
                {t("import.bulk.raw.linkedCount", { linked: rawSuccessCount, total: rawResults.length })}
              </p>
              {rawResults
                .filter((r) => r.linked || r.error || r.collision)
                .map((r, i) => (
                  <p key={i} className="text-xs text-muted">
                    <span className="text-ink">{r.filename}</span>
                    {": "}
                    {r.error ? (
                      <span className="text-red-600 dark:text-red-400">{r.error}</span>
                    ) : r.collision ? (
                      <span className="text-amber-600 dark:text-amber-400">{t("upload.raw.collision")}</span>
                    ) : (
                      <span className="text-emerald-700 dark:text-emerald-400">
                        {t("upload.raw.filedUnder", {
                          name: speciesName({
                            commonName: r.speciesCommonName,
                            scientificName: r.speciesScientificName ?? "",
                          }),
                        })}
                      </span>
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
