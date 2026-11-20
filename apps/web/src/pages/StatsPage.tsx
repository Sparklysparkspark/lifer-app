import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";
import CollectionStatsPanel from "../components/CollectionStats";
import { LoadingScreen } from "../components/LoadingScreen";
import Lightbox, { type LightboxSlide } from "../components/Lightbox";
import Button from "../components/Button";
import FormMessage from "../components/FormMessage";
import { useSettings } from "../hooks/useSettings";
import { usePersistedState } from "../hooks/usePersistedState";
import { buttonClasses } from "../lib/buttonClasses";
import { backStateFor } from "../lib/backLabel";
import type { PhotoFilter, ScatterPoint } from "./stats/types";
import {
  exifRows,
  gearRows,
  headlineStats,
  portfolioHighlights,
  scatterPointsFor,
  shutterTicks,
  type ExifMetric,
  type GearMetric,
  type GearType,
  type MonthlyMetric,
  type ScatterAxisKey,
} from "./stats/statsHelpers";
import { useStatsData } from "./stats/useStatsData";
import { useStatsDownloads } from "./stats/useStatsDownloads";
import StatsPhotosPopover from "./stats/StatsPhotosPopover";
import PhotoSetModal from "./stats/PhotoSetModal";
import { slidesFor, type PhotoSetPhoto } from "./stats/photoSet";
import { api, apiPath } from "../api/client";
import { formatNumber } from "../lib/format";
import StatsHighlights from "./stats/StatsHighlights";
import {
  CountriesCard,
  ExifChart,
  GearChart,
  MonthlyChart,
  PhotoScatterChart,
  TimeOfDayChart,
} from "./stats/StatsCharts";
import CollectionIntelligence from "./stats/CollectionIntelligence";
import { useSpeciesName } from "../lib/speciesName";
import { useScrollMemory } from "../hooks/useScrollMemory";
import { useReadyMarker } from "../lib/readyMarker";
import { connectionMessage } from "../lib/userMessage";

const NO_STATS_ICON = (
  <svg
    viewBox="0 0 24 24"
    className="h-6 w-6 text-muted"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4 20V10M12 20V4M20 20v-6" />
  </svg>
);

type ExifDim = "focalLength" | "iso" | "aperture" | "shutter";
type PhotoSet = { title: string; photos: PhotoSetPhoto[] };

export default function StatsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const speciesName = useSpeciesName();
  const [filter, setFilter] = useState<PhotoFilter>("all");
  // Matches the rest of the app, which shows RAW-only photos by default.
  const [includeRaw, setIncludeRaw] = usePersistedState("stats.includeRaw", true);
  // The charts' choices live here, so they survive the charts unmounting for an empty filter.
  const [gearType, setGearType] = useState<GearType>("cameras");
  const [gearMetric, setGearMetric] = useState<GearMetric>("photoCount");
  const [exifMetric, setExifMetric] = useState<ExifMetric>("focalLength");
  const [monthlyMetric, setMonthlyMetric] = useState<MonthlyMetric>("newLifers");
  const [scatterX, setScatterX] = useState<ScatterAxisKey>("focalLength");
  const [scatterY, setScatterY] = useState<ScatterAxisKey>("shutterSeconds");
  const [lightbox, setLightbox] = useState<{ slides: LightboxSlide[]; index: number } | null>(null);
  // A chart mark's photos as a grid (a scatter dot's View all, an EXIF bar).
  const [photoSet, setPhotoSet] = useState<PhotoSet | null>(null);
  const downloads = useStatsDownloads(filter, includeRaw);
  const namingStyles = useSettings().settings?.speciesNamingStyles ?? [];
  const data = useStatsData(filter, includeRaw);
  const { stats, loadError } = data;
  useScrollMemory(!!stats);
  useReadyMarker(!!stats);

  const highlights = useMemo(() => portfolioHighlights(data.portfolio), [data.portfolio]);
  const scatterPoints = useMemo(
    () => scatterPointsFor(stats?.scatter ?? [], scatterX, scatterY),
    [stats, scatterX, scatterY],
  );
  const scatterShutterTicks = useMemo(
    () => shutterTicks(scatterPoints.map((p) => p.shutterSeconds).filter((v): v is number => v != null)),
    [scatterPoints],
  );
  const gearData = useMemo(() => (stats ? gearRows(stats, gearType) : []), [stats, gearType]);
  const exifData = useMemo(
    () => (stats ? exifRows(stats, exifMetric) : { key: "count" as const, rows: [] }),
    [stats, exifMetric],
  );

  const pointPhotos = (points: ScatterPoint[]): PhotoSetPhoto[] =>
    points.map((point) => ({
      photoId: point.photoId!,
      caption: speciesName(point),
      info: { focalLengthMm: point.focalLength, aperture: point.aperture, shutter: point.shutterLabel, iso: point.iso },
    }));
  const setTitle = (count: number, settings: string) =>
    t("stats.charts.setTitle", { count, formatted: formatNumber(count), settings });

  // An EXIF bar opens at once on its sample, which is the start of its full list, then fills in the rest.
  function openBucket(dim: ExifDim, index: number, row: { label: string; count: number; photoIds: string[] }) {
    const title = setTitle(row.count, row.label);
    const sample = row.photoIds.map((photoId) => ({ photoId }));
    setPhotoSet({ title, photos: sample });
    if (row.count <= sample.length) return;
    api
      .get(
        apiPath(
          "/stats/exif-bucket",
          {},
          { dim, bucket: index + 1, filter, ...(includeRaw ? {} : { includeRaw: "0" as const }) },
        ),
      )
      .then((r) =>
        setPhotoSet((open) =>
          open?.title === title ? { title, photos: r.photoIds.map((photoId) => ({ photoId })) } : open,
        ),
      )
      // The sample stays up; the grid still opens and its photos still page.
      .catch(() => undefined);
  }

  // The header stays up while the body loads.
  if (!stats) {
    return (
      <div className="flex-1 bg-canvas">
        <PageHeader sticky topLevel title={t("nav.stats")} />
        {loadError ? (
          <EmptyState
            title={t("stats.loadFailed")}
            error={loadError}
            action={{ label: t("common.retry"), onClick: data.retry }}
          />
        ) : (
          <LoadingScreen showBackLink={false} label={t("stats.loading")} />
        )}
      </div>
    );
  }

  const headlines = headlineStats(stats);
  // An empty library has nothing to filter or export; an empty filter still needs its picker.
  const noKeepers = stats.totalKeepers === 0 && filter === "all" && includeRaw;

  return (
    <div className="flex-1 bg-canvas">
      <PageHeader
        topLevel
        sticky
        title={t("nav.stats")}
        actions={
          <>
            {/* Views of the same library that used to sit on Home. */}
            {!noKeepers && (
              <>
                <Link
                  to="/year-in-review"
                  state={backStateFor(location, t)}
                  className={buttonClasses("secondary", "sm")}
                >
                  {t("stats.yearInReview")}
                </Link>
                <Link to="/explore" state={backStateFor(location, t)} className={buttonClasses("secondary", "sm")}>
                  {t("explorer.title")}
                </Link>
              </>
            )}
            {!noKeepers && (
              <StatsPhotosPopover
                filter={filter}
                onFilterChange={setFilter}
                includeRaw={includeRaw}
                onIncludeRawChange={setIncludeRaw}
                counted={stats.totalKeepers}
              />
            )}
            {!noKeepers && (
              <Button variant="secondary" size="sm" onClick={downloads.exportCsv} loading={downloads.exporting}>
                {downloads.exporting ? t("stats.exporting") : t("stats.exportCsv")}
              </Button>
            )}
          </>
        }
      />
      {/* Stats still up from before (another filter, an earlier visit) say why they didn't refresh. */}
      {(downloads.exportError || loadError != null) && (
        <div className="px-page pt-4">
          <FormMessage error={downloads.exportError ?? connectionMessage(loadError) ?? t("stats.loadFailed")} />
        </div>
      )}
      {data.sectionError && (
        <div className="px-page pt-4">
          <FormMessage error={t("stats.sectionsFailed")} />
        </div>
      )}

      {stats.totalKeepers === 0 ? (
        <EmptyState
          icon={NO_STATS_ICON}
          title={t("stats.empty.title")}
          description={t("stats.empty.description")}
          action={noKeepers ? { label: t("nav.importPhotos"), onClick: () => navigate("/import") } : undefined}
        />
      ) : (
        <div className="mx-auto max-w-5xl space-y-section p-page">
          {/* The life-list count is the page's headline number, so it leads. */}
          <CollectionStatsPanel />
          <StatsHighlights stats={stats} headlines={headlines} />
          <MonthlyChart perMonth={stats.perMonth} metric={monthlyMetric} onMetricChange={setMonthlyMetric} />
          <PhotoScatterChart
            points={scatterPoints}
            shutterTicks={scatterShutterTicks}
            x={scatterX}
            y={scatterY}
            onXChange={setScatterX}
            onYChange={setScatterY}
            onOpenPoints={(points, startIndex) =>
              setLightbox({ index: startIndex, slides: slidesFor(pointPhotos(points)) })
            }
            onViewAll={(points, title) => setPhotoSet({ title, photos: pointPhotos(points) })}
          />
          <GearChart
            rows={gearData}
            gearType={gearType}
            metric={gearMetric}
            onGearTypeChange={setGearType}
            onMetricChange={setGearMetric}
          />
          <ExifChart
            data={exifData}
            metric={exifMetric}
            onMetricChange={setExifMetric}
            onOpenBucket={(index, row) => exifMetric !== "hitRate" && openBucket(exifMetric, index, row)}
          />
          <TimeOfDayChart timeOfDay={stats.timeOfDay} busiestHour={headlines.busiestHour?.hour} />
          <CountriesCard countries={stats.countriesPhotographed} />
          <CollectionIntelligence
            highlights={highlights}
            archiveHealth={data.archiveHealth}
            photographyDna={data.photographyDna}
            years={data.years}
            namingStyles={namingStyles}
          />
        </div>
      )}

      {photoSet && (
        <PhotoSetModal
          title={photoSet.title}
          photos={photoSet.photos}
          onClose={() => setPhotoSet(null)}
          footer={
            <Button
              variant="secondary"
              size="sm"
              loading={downloads.bucketDownloading}
              onClick={() => downloads.downloadBucket(photoSet.photos.map((p) => p.photoId))}
            >
              {downloads.bucketDownloading ? t("stats.charts.downloading") : t("stats.charts.downloadAll")}
            </Button>
          }
        />
      )}
      {lightbox && (
        <Lightbox
          slides={lightbox.slides}
          index={lightbox.index}
          onIndexChange={(index) => setLightbox({ ...lightbox, index })}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}
