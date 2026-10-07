import { useMemo, useState } from "react";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";
import CollectionStatsPanel from "../components/CollectionStats";
import { LoadingScreen } from "../components/LoadingScreen";
import Lightbox, { type LightboxSlide } from "../components/Lightbox";
import Button from "../components/Button";
import FormMessage from "../components/FormMessage";
import { useSettings } from "../hooks/useSettings";
import type { PhotoFilter } from "./stats/types";
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
import { OptionSelect } from "./stats/StatsUi";
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

const FILTER_OPTIONS = [
  { value: "all", label: "All keepers" },
  { value: "featured", label: "Featured only" },
  { value: "topRated", label: "Top rated (5-star)" },
];

export default function StatsPage() {
  const [filter, setFilter] = useState<PhotoFilter>("all");
  // The charts' choices live here, so they survive the charts unmounting for an empty filter.
  const [gearType, setGearType] = useState<GearType>("cameras");
  const [gearMetric, setGearMetric] = useState<GearMetric>("photoCount");
  const [exifMetric, setExifMetric] = useState<ExifMetric>("focalLength");
  const [monthlyMetric, setMonthlyMetric] = useState<MonthlyMetric>("newLifers");
  const [scatterX, setScatterX] = useState<ScatterAxisKey>("focalLength");
  const [scatterY, setScatterY] = useState<ScatterAxisKey>("shutterSeconds");
  const [lightboxSlide, setLightboxSlide] = useState<LightboxSlide | null>(null);
  const downloads = useStatsDownloads(filter);
  const namingStyles = useSettings().settings?.speciesNamingStyles ?? [];
  const data = useStatsData(filter);
  const { stats, loadError } = data;

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

  // Clicking an EXIF bar lists the photos behind it.
  const [barBucket, setBarBucket] = useState<{ label: string; photoIds: string[] } | null>(null);

  // The header stays up while the body loads.
  if (!stats) {
    return (
      <div className="flex-1 bg-canvas">
        <PageHeader sticky title="Stats" />
        {loadError ? (
          <div className="mx-auto flex max-w-md flex-col items-center gap-3 p-10 text-center">
            <FormMessage error={loadError} />
            <Button variant="secondary" size="sm" onClick={data.retry}>
              Retry
            </Button>
          </div>
        ) : (
          <LoadingScreen showBackLink={false} label="Loading stats…" />
        )}
      </div>
    );
  }

  const headlines = headlineStats(stats);

  return (
    <div className="flex-1 bg-canvas">
      <PageHeader
        sticky
        title="Stats"
        actions={
          <>
            <OptionSelect
              ariaLabel="Photos to count"
              value={filter}
              onChange={(v) => setFilter(v as PhotoFilter)}
              options={FILTER_OPTIONS}
            />
            <Button variant="secondary" size="sm" onClick={downloads.exportCsv} loading={downloads.exporting}>
              {downloads.exporting ? "Exporting…" : "Export CSV"}
            </Button>
          </>
        }
      />
      {(downloads.exportError || loadError) && (
        <div className="px-6 pt-4">
          <FormMessage error={downloads.exportError ?? loadError} />
        </div>
      )}
      {data.sectionError && (
        <div className="px-6 pt-4">
          <FormMessage error="Some sections couldn't load. Reload the page to try again." />
        </div>
      )}

      {stats.totalKeepers === 0 ? (
        <EmptyState
          icon={NO_STATS_ICON}
          title="No stats yet"
          description="Stats are built from your edited photos (RAW-only imports don't count), so import and edit a few to see them here."
        />
      ) : (
        <div className="mx-auto max-w-5xl space-y-6 p-6">
          <StatsHighlights stats={stats} headlines={headlines} />
          <MonthlyChart perMonth={stats.perMonth} metric={monthlyMetric} onMetricChange={setMonthlyMetric} />
          <PhotoScatterChart
            points={scatterPoints}
            shutterTicks={scatterShutterTicks}
            x={scatterX}
            y={scatterY}
            onXChange={setScatterX}
            onYChange={setScatterY}
            onOpenPoint={(point) =>
              setLightboxSlide({
                url: `/api/photos/${point.photoId}/display`,
                caption: point.commonName ?? point.scientificName,
                info: {
                  focalLengthMm: point.focalLength,
                  aperture: point.aperture,
                  shutter: point.shutterLabel,
                  iso: point.iso,
                },
              })
            }
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
            bucket={barBucket}
            onBucketChange={setBarBucket}
            bucketDownloading={downloads.bucketDownloading}
            onDownloadBucket={downloads.downloadBucket}
            onOpenPhoto={(id) => setLightboxSlide({ url: `/api/photos/${id}/display` })}
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
          <div>
            <h2 className="mb-2 text-sm font-semibold text-ink">Collection breakdown</h2>
            <CollectionStatsPanel />
          </div>
        </div>
      )}

      {lightboxSlide && (
        <Lightbox slides={[lightboxSlide]} index={0} onIndexChange={() => {}} onClose={() => setLightboxSlide(null)} />
      )}
    </div>
  );
}
