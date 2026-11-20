import { useEffect, useState } from "react";
import VersionSuggestions from "../components/VersionSuggestions";
import VersionNotice, { useVersionNotice } from "../components/VersionNotice";
import Button from "../components/Button";
import { docsUrl } from "../lib/docs";
import { openExternal } from "../lib/openExternal";
import { Link, useNavigate } from "react-router-dom";
import { useDeploymentMode } from "../hooks/useDeploymentMode";
import { useTranslation } from "react-i18next";
import { enqueueRawUploads } from "../lib/uploadQueue";
import PageHeader from "../components/PageHeader";
import FilePickArea from "../components/FilePickArea";
import PhotoImportRows from "../components/PhotoImportRows";
import SkippedPhotosManager from "../components/importReview/SkippedPhotosManager";
import { RAW_EXTENSIONS, extname } from "../lib/rawExtensions";
import FormMessage from "../components/FormMessage";
import { useSpeciesName } from "../lib/speciesName";
import { api } from "../api/client";
import Select from "../components/Select";
import { isTripActive, localIsoDate, type TripSummary } from "@lifer/shared";
import { usePersistedState } from "../hooks/usePersistedState";
import { NO_TRIP, defaultTripChoice } from "../lib/tripChoice";

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
  const mode = useDeploymentMode();
  const { t } = useTranslation();
  const versionNotice = useVersionNotice();
  const speciesName = useSpeciesName();
  const [rawResults, setRawResults] = useState<RawImportOutcome[] | null>(null);
  const [rawError, setRawError] = useState<string | null>(null);
  // The batch's trip: its photos join it and are filed in its folder. Suggested from the active
  // trips, always the user's to change; null while several are active and they haven't chosen.
  const [trips, setTrips] = useState<TripSummary[]>([]);
  const [lastPick, setLastPick] = usePersistedState<string | null>("importTripPick", null);
  const [picked, setPicked] = useState<string | null>(null);
  const today = localIsoDate();
  const choice = picked ?? defaultTripChoice(trips, today, lastPick);
  const tripId = choice && choice !== NO_TRIP ? choice : undefined;
  const chosenTrip = trips.find((trip) => trip.id === tripId);
  const activeTrips = trips.filter((trip) => isTripActive(trip, today));
  const otherTrips = trips.filter((trip) => !isTripActive(trip, today));
  function pickTrip(value: string) {
    setPicked(value);
    setLastPick(value);
  }
  useEffect(() => {
    api
      .get("/trips")
      .then((res) => setTrips(res.trips))
      .catch(() => {});
  }, []);

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
          <h2 id="import-photos-heading" className="mb-2 text-callout font-semibold text-ink">
            {t("import.bulk.photos.title")}
          </h2>
          {trips.length > 0 && (
            <div className="mb-item w-64 space-y-1">
              {chosenTrip && (
                <p className="text-callout font-medium text-ink">
                  {t("import.bulk.trip.addingTo", { name: chosenTrip.name })}
                </p>
              )}
              <Select
                variant="form"
                label={t("import.bulk.trip.label")}
                labelClassName="block space-y-1 text-callout text-ink"
                value={choice ?? ""}
                onChange={(e) => pickTrip(e.target.value)}
              >
                {choice === null && (
                  <option value="" disabled>
                    {t("import.bulk.trip.choose")}
                  </option>
                )}
                <option value={NO_TRIP}>{t("import.bulk.trip.none")}</option>
                {[
                  { label: t("import.bulk.trip.active"), group: activeTrips },
                  { label: t("import.bulk.trip.other"), group: otherTrips },
                ].map(
                  ({ label, group }) =>
                    group.length > 0 && (
                      <optgroup key={label} label={label}>
                        {group.map((trip) => (
                          <option key={trip.id} value={trip.id}>
                            {trip.name}
                          </option>
                        ))}
                      </optgroup>
                    ),
                )}
              </Select>
              {choice === null && <p className="text-footnote text-muted">{t("import.bulk.trip.chooseHint")}</p>}
            </div>
          )}
          {/* Back to the collection, on the batch's region, once everything is uploading (uploads
              continue in the background). Stays put when some rows weren't included, since leaving
              would drop them. */}
          {/* Several trips are active: the user says which (or none) before any photos are added. */}
          {choice !== null && (
            <PhotoImportRows
              tripId={tripId}
              suggestedRegionId={chosenTrip?.regionId}
              onImportStarted={(everyRowIncluded, regionId) =>
                everyRowIncluded && navigate(regionId ? `/?region=${regionId}` : "/")
              }
            />
          )}
          <p className="mt-2 text-footnote text-muted">
            {t("versions.importHint")}{" "}
            <Button variant="link" size="sm" onClick={() => openExternal(docsUrl("/guides/photo-versions"))}>
              {t("versions.notice.howItWorks")}
            </Button>
          </p>
          {/* Photos left out of earlier imports, which picking their folder again skips. */}
          <SkippedPhotosManager />
        </section>

        {/* What the background pass grouped, then what it only suggests. */}
        <VersionNotice notice={versionNotice} />
        <VersionSuggestions />

        {mode === "desktop" && (
          <p className="text-subheadline text-muted">
            {t("import.bulk.lightroom.hint")}{" "}
            <Link to="/import/lightroom" className="text-accent underline">
              {t("import.bulk.lightroom.link")}
            </Link>
          </p>
        )}

        {/* Closed by default: the drop area above takes RAWs too. This is only for RAWs of photos already imported. */}
        <details className="group space-y-item">
          <summary className="cursor-pointer list-none text-callout font-semibold text-ink marker:content-none">
            <span className="mr-2 inline-block transition-transform group-open:rotate-90" aria-hidden="true">
              ›
            </span>
            {t("import.bulk.raw.title")}
          </summary>
          <FilePickArea
            prompt={t("import.bulk.raw.description")}
            accept={[...RAW_EXTENSIONS].join(",")}
            onFiles={handleRawFiles}
            compact
          />
          <FormMessage error={rawError} />
          {rawResults && (
            <div className="space-y-1">
              <p className="text-footnote font-medium text-muted">
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
                  <p key={i} className="text-footnote text-muted">
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
        </details>
      </main>
    </div>
  );
}
