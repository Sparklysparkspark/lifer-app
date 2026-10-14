import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { enqueueRawUploads } from "../lib/uploadQueue";
import PageHeader from "../components/PageHeader";
import FilePickArea from "../components/FilePickArea";
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
  /** Still uploading: a placeholder until its result replaces it. */
  pending?: boolean;
}

export default function BulkImportPage() {
  // RAWs need no species: each is matched to an imported JPEG by filename and EXIF timestamp
  // (same as RawUpload) and filed under that species. No match or an ambiguous one is skipped.
  const navigate = useNavigate();
  const { t } = useTranslation();
  const speciesName = useSpeciesName();
  const [rawResults, setRawResults] = useState<RawImportOutcome[] | null>(null);
  const [rawError, setRawError] = useState<string | null>(null);

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
      pending: true,
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
  }

  const rawSuccessCount = rawResults?.filter((r) => r.linked).length ?? 0;
  const rawUnmatchedCount = rawResults?.filter((r) => !r.pending && !r.linked && !r.collision && !r.error).length ?? 0;
  const rawPendingCount = rawResults?.filter((r) => r.pending).length ?? 0;

  return (
    <div className="flex-1 bg-canvas">
      <PageHeader sticky topLevel title={t("import.bulk.title")} />

      <main className="space-y-section p-page">
        <section aria-labelledby="import-photos-heading">
          <h2 id="import-photos-heading" className="mb-2 text-sm font-semibold text-ink">
            {t("import.bulk.photos.title")}
          </h2>
          {/* Back to the collection once everything is uploading (uploads continue in the background).
              Stays put when some rows weren't included, since leaving would drop them. */}
          <PhotoImportRows onImportStarted={(everyRowIncluded) => everyRowIncluded && navigate("/")} />
        </section>

        <section aria-labelledby="import-raw-heading" className="space-y-item">
          <h2 id="import-raw-heading" className="mb-2 text-sm font-semibold text-ink">
            {t("import.bulk.raw.title")}
          </h2>
          <FilePickArea
            prompt={t("import.bulk.raw.description")}
            accept={[...RAW_EXTENSIONS].join(",")}
            onFiles={handleRawFiles}
            compact
          />
          <FormMessage error={rawError} />
          {rawResults && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted">
                {[
                  rawSuccessCount > 0 && t("import.bulk.raw.linkedCount", { count: rawSuccessCount }),
                  rawUnmatchedCount > 0 && t("import.bulk.raw.unmatchedCount", { count: rawUnmatchedCount }),
                  rawPendingCount > 0 && t("import.bulk.raw.pendingCount", { count: rawPendingCount }),
                ]
                  .filter(Boolean)
                  .join(" · ")}
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
        </section>
      </main>
    </div>
  );
}
