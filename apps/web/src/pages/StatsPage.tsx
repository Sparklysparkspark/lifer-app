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
import { useSpeciesName } from "../lib/speciesName";
import { useScrollMemory } from "../hooks/useScrollMemory";

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
  const speciesName = useSpeciesName();
  const [filter, setFilter] = useState<PhotoFilter>("all");
  // The charts' choices live here, so they survive the charts unmounting for an empty filter.
  const [gearType, setGearType] = useState<GearType>("cameras");
  const [gearMetric, setGearMetric] = useState<GearMetric>("photoCount");
  const [exifMetric, setExifMetric] = useState<ExifMetric>("focalLength");
  const [monthlyMetric, setMonthlyMetric] = useState<MonthlyMetric>("newLifers");
  const [scatterX, setScatterX] = useState<ScatterAxisKey>("focalLength");
  const [scatterY, setScatterY] = useState<ScatterAxisKey>("shutterSeconds");
  const [lightbox, setLightbox] = useState<{ slides: LightboxSlide[]; index: number } | null>(null);
  const showPhoto = (slide: LightboxSlide) => setLightbox({ slides: [slide], index: 0 });
  const downloads = useStatsDownloads(filter);
  const namingStyles = useSettings().settings?.speciesNamingStyles ?? [];
  const data = useStatsData(filter);
  const { stats, loadError } = data;
  useScrollMemory(!!stats);

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
        <PageHeader sticky topLevel title="Stats" />
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
        topLevel
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
        <div className="px-page pt-4">
          <FormMessage error={downloads.exportError ?? loadError} />
        </div>
      )}
      {data.sectionError && (
        <div className="px-page pt-4">
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
              setLightbox({
                index: startIndex,
                slides: points.map((point) => ({
                  url: `/api/photos/${point.photoId}/display`,
                  caption: speciesName(point),
                  info: {
                    focalLengthMm: point.focalLength,
                    aperture: point.aperture,
                    shutter: point.shutterLabel,
                    iso: point.iso,
                  },
                })),
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
            onOpenPhoto={(id) => showPhoto({ url: `/api/photos/${id}/display` })}
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
