import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
} from "recharts";
import { api, CLIENT_HEADER } from "../api/client";
import { downloadFile } from "../lib/downloadFile";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";
import CollectionStatsPanel from "../components/CollectionStats";
import { LoadingScreen, Spinner } from "../components/LoadingScreen";
import Lightbox, { type LightboxSlide } from "../components/Lightbox";
import InfoTip from "../components/InfoTip";
import Button from "../components/Button";
import FormMessage from "../components/FormMessage";
import SharedSelect from "../components/Select";
import { useSettings } from "../hooks/useSettings";
import { pluralize } from "../lib/pluralize";
import { taxonDisplayLabel } from "@lifer/shared";

interface StatsResponse {
  totalKeepers: number;
  insights: string[];
  perMonth: Array<{ month: string; label: string; newLifers: number; keepers: number }>;
  gearUsage: {
    cameras: Array<{ model: string; photoCount: number; speciesCount: number }>;
    lenses: Array<{ model: string; photoCount: number; speciesCount: number }>;
    combos: Array<{ camera: string; lens: string; photoCount: number; speciesCount: number }>;
  };
  timeOfDay: Array<{ hour: number; label: string; count: number }>;
  exifDistributions: {
    focalLength: Array<{ label: string; count: number; photoIds: string[] }>;
    iso: Array<{ label: string; count: number; photoIds: string[] }>;
    aperture: Array<{ label: string; count: number; photoIds: string[] }>;
    shutter: Array<{ label: string; count: number; photoIds: string[] }>;
  };
  hitRateByFocalLength: Array<{ label: string; species: number }>;
  scatter: Array<{
    focalLength: number | null;
    aperture: number | null;
    iso: number | null;
    shutterSeconds: number | null;
    shutterLabel: string | null;
    scientificName: string;
    commonName: string | null;
    photoId: string | null;
  }>;
  countriesPhotographed: { count: number; countries: Array<{ name: string; photoCount: number }> };
  ghostSpecies: Array<{ speciesId: string; scientificName: string; commonName: string | null }>;
  lostSpecies: Array<{ speciesId: string; scientificName: string; commonName: string | null }>;
  rediscoveredSpecies: Array<{ speciesId: string; scientificName: string; commonName: string | null }>;
}

interface SpeciesPortfolioResponse {
  species: Array<{
    speciesId: string;
    commonName: string | null;
    scientificName: string;
    taxonClass: string;
    totalPhotos: number;
    rated4Plus: number;
    bestRating: number | null;
    earliestTakenAt: string | null;
    latestTakenAt: string | null;
  }>;
}
interface ArchiveHealthResponse {
  total: number;
  missingDate: number;
}
interface PhotographyDnaResponse {
  taxonBreakdown: Array<{ taxonClass: string; count: number; percent: number }>;
  categoryBreakdown: Array<{ key: string; count: number; percent: number }>;
  medianFocalLengthMm: number | null;
  medianShutterSeconds: number | null;
  medianIso: number | null;
}
interface YearComparisonResponse {
  a: { year: number; speciesCount: number; photoCount: number; avgFocalLength: number | null; avgIso: number | null };
  b: { year: number; speciesCount: number; photoCount: number; avgFocalLength: number | null; avgIso: number | null };
}

type PhotoFilter = "all" | "featured" | "topRated";

const ACCENT = "var(--color-accent)";
const INK = "var(--color-ink)";
const MUTED = "var(--color-muted)";
const LINE = "var(--color-line)";

function NoValue() {
  return <span className="text-muted">n/a</span>;
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-ink">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
    </div>
  );
}

function ChartCard({
  title,
  controls,
  children,
  className,
}: {
  title: string;
  controls?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-line bg-surface p-4 ${className ?? ""}`}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {controls}
      </div>
      {children}
    </div>
  );
}

// The shared toolbar Select, fed from an options array.
function OptionSelect({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  ariaLabel?: string;
}) {
  return (
    <SharedSelect value={value} onChange={(e) => onChange(e.target.value)} aria-label={ariaLabel}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </SharedSelect>
  );
}

// Axes the scatter plot's X/Y dropdowns can pick between.
const SCATTER_AXES = {
  focalLength: { label: "Focal length", format: (v: number) => `${v}mm` },
  aperture: { label: "Aperture", format: (v: number) => `f/${v}` },
  iso: { label: "ISO", format: (v: number) => `${v}` },
  shutterSeconds: { label: "Shutter speed", format: (v: number) => (v >= 1 ? `${v}s` : `1/${Math.round(1 / v)}`) },
} as const;
type ScatterAxisKey = keyof typeof SCATTER_AXES;

// Camera-dial speeds out to 1/128000 so fast electronic shutters still get labeled ticks.
const NICE_SHUTTER_DENOMINATORS = [30, 60, 125, 250, 500, 1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000];

// Ticks span only what the data covers.
function shutterTicks(values: number[]): number[] {
  if (values.length === 0) return NICE_SHUTTER_DENOMINATORS.slice(0, 9).map((d) => 1 / d);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const covering = NICE_SHUTTER_DENOMINATORS.filter((d) => 1 / d >= min && 1 / d <= max);
  return (covering.length >= 2 ? covering : NICE_SHUTTER_DENOMINATORS).map((d) => 1 / d);
}

const GEAR_TYPES = [
  { value: "cameras", label: "Cameras" },
  { value: "lenses", label: "Lenses" },
  { value: "combos", label: "Camera + lens" },
] as const;
const GEAR_METRICS = [
  { value: "photoCount", label: "Photos" },
  { value: "speciesCount", label: "Species" },
] as const;

const EXIF_METRICS = [
  { value: "focalLength", label: "Photos by focal length" },
  { value: "iso", label: "ISO" },
  { value: "aperture", label: "Aperture" },
  { value: "shutter", label: "Shutter speed" },
  { value: "hitRate", label: "Species by focal length" },
] as const;

const MONTHLY_METRICS = [
  { value: "newLifers", label: "New lifers" },
  { value: "keepers", label: "Total keepers" },
] as const;
const KEEPER_INFO_PARAGRAPHS = [
  "A \"keeper\" is any photo you've edited/adjusted and kept, except one rated 1 star.",
  "Rate a photo 1 star to exclude it from your stats, useful for an ID shot you only kept to confirm the species, not one you'd count as a real photo.",
];

function ScatterTooltip({ active, payload, xKey, yKey }: { active?: boolean; payload?: Array<{ payload: StatsResponse["scatter"][number] }>; xKey: ScatterAxisKey; yKey: ScatterAxisKey }) {
  if (!active || !payload?.[0]) return null;
  const p = payload[0].payload;
  const xVal = p[xKey];
  const yVal = p[yKey];
  return (
    <div className="flex items-center gap-2 rounded-md border border-line bg-surface p-2 text-xs shadow-md">
      {p.photoId && <img src={`/api/photos/${p.photoId}/thumb`} alt="" loading="lazy" className="h-12 w-12 rounded object-cover" />}
      <div>
        <p className="font-medium text-ink">{p.commonName ?? p.scientificName}</p>
        <p className="text-muted">
          {xVal != null ? SCATTER_AXES[xKey].format(xVal) : "N/A"} · {yVal != null ? SCATTER_AXES[yKey].format(yVal) : "N/A"}
        </p>
        {p.photoId && <p className="text-muted">Click to view full size</p>}
      </div>
    </div>
  );
}

export default function StatsPage() {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [filter, setFilter] = useState<PhotoFilter>("all");
  const [gearType, setGearType] = useState<(typeof GEAR_TYPES)[number]["value"]>("cameras");
  const [gearMetric, setGearMetric] = useState<(typeof GEAR_METRICS)[number]["value"]>("photoCount");
  const [exifMetric, setExifMetric] = useState<(typeof EXIF_METRICS)[number]["value"]>("focalLength");
  const [monthlyMetric, setMonthlyMetric] = useState<(typeof MONTHLY_METRICS)[number]["value"]>("newLifers");
  const [scatterX, setScatterX] = useState<ScatterAxisKey>("focalLength");
  const [scatterY, setScatterY] = useState<ScatterAxisKey>("shutterSeconds");
  const [lightboxSlide, setLightboxSlide] = useState<LightboxSlide | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [portfolio, setPortfolio] = useState<SpeciesPortfolioResponse | null>(null);
  const [archiveHealth, setArchiveHealth] = useState<ArchiveHealthResponse | null>(null);
  const [photographyDna, setPhotographyDna] = useState<PhotographyDnaResponse | null>(null);
  const [yearA, setYearA] = useState<number | null>(null);
  const [yearB, setYearB] = useState<number | null>(null);
  const [yearComparison, setYearComparison] = useState<YearComparisonResponse | null>(null);
  const [sectionError, setSectionError] = useState(false);
  const namingStyles = useSettings().settings?.speciesNamingStyles ?? [];

  useEffect(() => {
    const controller = new AbortController();
    setLoadError(null);
    api
      .get<StatsResponse>(`/stats?filter=${filter}`, { signal: controller.signal })
      .then(setStats)
      .catch(() => {
        if (!controller.signal.aborted) setLoadError("Couldn't load stats. Try again.");
      });
    return () => controller.abort();
  }, [filter, reloadKey]);

  // Always over the whole library, not narrowed by the keeper filter.
  useEffect(() => {
    const controller = new AbortController();
    const opts = { signal: controller.signal };
    api
      .get<SpeciesPortfolioResponse>("/stats/species-portfolio", opts)
      .then(setPortfolio)
      .catch(() => {
        if (!controller.signal.aborted) setPortfolio({ species: [] });
      });
    api
      .get<ArchiveHealthResponse>("/stats/archive-health", opts)
      .then(setArchiveHealth)
      .catch(() => {
        if (!controller.signal.aborted) setSectionError(true);
      });
    api
      .get<PhotographyDnaResponse>("/stats/photography-dna", opts)
      .then(setPhotographyDna)
      .catch(() => {
        if (!controller.signal.aborted) setSectionError(true);
      });
    return () => controller.abort();
  }, []);

  // Years to compare come from the portfolio's photo dates; defaults to the two most recent.
  const availableYears = useMemo(() => {
    if (!portfolio) return [];
    const years = new Set<number>();
    for (const s of portfolio.species) {
      if (s.earliestTakenAt) years.add(new Date(s.earliestTakenAt).getFullYear());
      if (s.latestTakenAt) years.add(new Date(s.latestTakenAt).getFullYear());
    }
    return [...years].sort((a, b) => b - a);
  }, [portfolio]);

  useEffect(() => {
    if (availableYears.length > 0 && yearA === null) setYearA(availableYears[0]);
    if (availableYears.length > 1 && yearB === null) setYearB(availableYears[1]);
  }, [availableYears, yearA, yearB]);

  useEffect(() => {
    if (yearA === null || yearB === null) return;
    const controller = new AbortController();
    api
      .get<YearComparisonResponse>(`/stats/year-comparison?yearA=${yearA}&yearB=${yearB}`, { signal: controller.signal })
      .then(setYearComparison)
      .catch(() => {
        if (!controller.signal.aborted) setSectionError(true);
      });
    return () => controller.abort();
  }, [yearA, yearB]);

  const mostPhotographed = useMemo(
    () => (portfolio ? [...portfolio.species].sort((a, b) => b.totalPhotos - a.totalPhotos).slice(0, 10) : []),
    [portfolio],
  );
  const oneAndDone = useMemo(() => (portfolio ? portfolio.species.filter((s) => s.totalPhotos === 1) : []), [portfolio]);
  // Only species whose single photo you rated 1 star yourself.
  const needsBetterPhoto = useMemo(
    () => (portfolio ? portfolio.species.filter((s) => s.totalPhotos === 1 && s.bestRating === 1) : []),
    [portfolio],
  );

  const scatterPoints = useMemo(
    () => (stats?.scatter ?? []).filter((p) => p[scatterX] != null && p[scatterY] != null),
    [stats, scatterX, scatterY],
  );
  const scatterShutterTicks = useMemo(
    () => shutterTicks(scatterPoints.map((p) => p.shutterSeconds).filter((v): v is number => v != null)),
    [scatterPoints],
  );

  const gearData = useMemo(() => {
    if (!stats) return [];
    if (gearType === "combos") return stats.gearUsage.combos.map((c) => ({ label: `${c.camera} + ${c.lens}`, photoCount: c.photoCount, speciesCount: c.speciesCount }));
    return stats.gearUsage[gearType].map((g) => ({ label: g.model, photoCount: g.photoCount, speciesCount: g.speciesCount }));
  }, [stats, gearType]);

  const exifData: {
    key: "count" | "species";
    rows: Array<{ label: string; count?: number; species?: number; photoIds?: string[] }>;
  } = useMemo(() => {
    if (!stats) return { key: "count", rows: [] };
    if (exifMetric === "hitRate") return { key: "species", rows: stats.hitRateByFocalLength };
    return { key: "count", rows: stats.exifDistributions[exifMetric] };
  }, [stats, exifMetric]);

  // Clicking an EXIF bar lists the photos behind it.
  const [barBucket, setBarBucket] = useState<{ label: string; photoIds: string[] } | null>(null);
  const [bucketDownloading, setBucketDownloading] = useState(false);
  async function downloadBucket(photoIds: string[]) {
    setBucketDownloading(true);
    try {
      for (const id of photoIds) {
        await downloadFile(`/api/photos/${id}/original?download=1`, `${id}.jpg`);
      }
    } catch {
      setExportError("Couldn't download every photo. Try again.");
    } finally {
      setBucketDownloading(false);
    }
  }

  async function handleExport() {
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch(`/api/stats/export.csv?filter=${filter}`, { credentials: "same-origin", headers: CLIENT_HEADER });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const csv = await res.text();
      const filename = `lifer-stats-${filter}-${new Date().toISOString().slice(0, 10)}.csv`;

      if (window.liferSetup) {
        // Desktop: a native Save As dialog.
        const { save } = await import("@tauri-apps/plugin-dialog");
        const { writeTextFile } = await import("@tauri-apps/plugin-fs");
        const path = await save({ defaultPath: filename, filters: [{ name: "CSV", extensions: ["csv"] }] });
        if (!path) return; // user cancelled the dialog
        await writeTextFile(path, csv);
      } else {
        const blob = new Blob([csv], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        // Revoking right away can cancel the download before the browser reads the blob.
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Couldn't export stats");
    } finally {
      setExporting(false);
    }
  }

  // The header stays up while the body loads.
  if (!stats) {
    return (
      <div className="flex-1 bg-canvas">
        <PageHeader sticky title="Stats" />
        {loadError ? (
          <div className="mx-auto flex max-w-md flex-col items-center gap-3 p-10 text-center">
            <FormMessage error={loadError} />
            <Button variant="secondary" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
              Retry
            </Button>
          </div>
        ) : (
          <LoadingScreen showBackLink={false} label="Loading stats…" />
        )}
      </div>
    );
  }

  const topCamera = stats.gearUsage.cameras[0];
  const topFocalLength = [...stats.exifDistributions.focalLength].sort((a, b) => b.count - a.count)[0];
  const busiestHour = [...stats.timeOfDay].sort((a, b) => b.count - a.count)[0];
  const bestMonth = [...stats.perMonth].sort((a, b) => b.newLifers - a.newLifers)[0];

  return (
    <div className="flex-1 bg-canvas">
      <PageHeader sticky
        title="Stats"
        actions={
          <>
            <OptionSelect
              ariaLabel="Photos to count"
              value={filter}
              onChange={(v) => setFilter(v as PhotoFilter)}
              options={[
                { value: "all", label: "All keepers" },
                { value: "featured", label: "Featured only" },
                { value: "topRated", label: "Top rated (5-star)" },
              ]}
            />
            <Button variant="secondary" size="sm" onClick={handleExport} loading={exporting}>
              {exporting ? "Exporting…" : "Export CSV"}
            </Button>
          </>
        }
      />
      {(exportError || loadError) && (
        <div className="px-6 pt-4">
          <FormMessage error={exportError ?? loadError} />
        </div>
      )}
      {sectionError && (
        <div className="px-6 pt-4">
          <FormMessage error="Some sections couldn't load. Reload the page to try again." />
        </div>
      )}

      {stats.totalKeepers === 0 ? (
        <EmptyState
          icon={
            <svg viewBox="0 0 24 24" className="h-6 w-6 text-muted" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 20V10M12 20V4M20 20v-6" />
            </svg>
          }
          title="No stats yet"
          description="Stats are built from your edited photos (RAW-only imports don't count), so import and edit a few to see them here."
        />
      ) : (
        <div className="mx-auto max-w-5xl space-y-6 p-6">
          {/* Insight cards: the "how do I shoot" fingerprint. */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {topCamera && (
              <StatCard label="Top camera" value={topCamera.model} sub={`${Math.round((topCamera.photoCount / stats.totalKeepers) * 100)}% of keepers`} />
            )}
            {topFocalLength && topFocalLength.count > 0 && <StatCard label="Favorite focal length" value={topFocalLength.label} sub="most common range" />}
            {busiestHour && busiestHour.count > 0 && (
              <StatCard label="Peak shooting time" value={busiestHour.label} sub={`${Math.round((busiestHour.count / stats.totalKeepers) * 100)}% of keepers`} />
            )}
            {bestMonth && bestMonth.newLifers > 0 && <StatCard label="Best month" value={bestMonth.label} sub={pluralize(bestMonth.newLifers, "lifer")} />}
          </div>

          {stats.insights.length > 0 && (
            <div className="rounded-xl border border-line bg-surface p-4">
              <ul className="space-y-1.5 text-sm text-ink">
                {stats.insights.map((fact, i) => (
                  <li key={i}>{fact}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Only shown once you've found one; most photographers never will. */}
          {(stats.ghostSpecies.length > 0 || stats.lostSpecies.length > 0 || stats.rediscoveredSpecies.length > 0) && (
            <div className="grid gap-3 sm:grid-cols-2">
              {stats.rediscoveredSpecies.length > 0 && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950/30 sm:col-span-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                    Rediscovered ({stats.rediscoveredSpecies.length})
                  </p>
                  <p className="mt-0.5 text-xs text-muted">Was Ghost or Lost when you found it, but not anymore, you helped.</p>
                  <ul className="mt-2 space-y-0.5 text-sm text-ink">
                    {stats.rediscoveredSpecies.map((s) => (
                      <li key={s.speciesId}>{s.commonName ?? s.scientificName}</li>
                    ))}
                  </ul>
                </div>
              )}
              {stats.ghostSpecies.length > 0 && (
                <div className="rounded-xl border border-violet-200 bg-violet-50 p-4 dark:border-violet-900 dark:bg-violet-950/30">
                  <p className="text-xs font-medium uppercase tracking-wide text-violet-700 dark:text-violet-400">
                    Ghost species ({stats.ghostSpecies.length})
                  </p>
                  <p className="mt-0.5 text-xs text-muted">Rarely documented anywhere, but you found them.</p>
                  <ul className="mt-2 space-y-0.5 text-sm text-ink">
                    {stats.ghostSpecies.map((s) => (
                      <li key={s.speciesId}>{s.commonName ?? s.scientificName}</li>
                    ))}
                  </ul>
                </div>
              )}
              {stats.lostSpecies.length > 0 && (
                <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 dark:border-rose-900 dark:bg-rose-950/30">
                  <p className="text-xs font-medium uppercase tracking-wide text-rose-700 dark:text-rose-400">
                    Lost species ({stats.lostSpecies.length})
                  </p>
                  <p className="mt-0.5 text-xs text-muted">Not recorded anywhere else in over 25 years.</p>
                  <ul className="mt-2 space-y-0.5 text-sm text-ink">
                    {stats.lostSpecies.map((s) => (
                      <li key={s.speciesId}>{s.commonName ?? s.scientificName}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Monthly trend: new lifers or total keepers */}
          <ChartCard
            title="By month"
            controls={
              <div className="flex items-center gap-2">
                <OptionSelect ariaLabel="Monthly metric" value={monthlyMetric} onChange={(v) => setMonthlyMetric(v as typeof monthlyMetric)} options={[...MONTHLY_METRICS]} />
                <InfoTip paragraphs={KEEPER_INFO_PARAGRAPHS} align="right" />
              </div>
            }
          >
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={stats.perMonth}>
                <CartesianGrid strokeDasharray="3 3" stroke={LINE} vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: MUTED }} tickLine={false} axisLine={{ stroke: LINE }} minTickGap={40} />
                <YAxis tick={{ fontSize: 11, fill: MUTED }} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip contentStyle={{ background: "var(--color-surface)", border: `1px solid ${LINE}`, borderRadius: 6, fontSize: 12 }} />
                <Area type="monotone" dataKey={monthlyMetric} stroke={ACCENT} fill={ACCENT} fillOpacity={0.15} strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Signature scatter: pick your own X/Y */}
          <ChartCard
            title="Your photo distribution"
            controls={
              <div className="flex items-center gap-2">
                <OptionSelect ariaLabel="X axis" value={scatterX} onChange={(v) => setScatterX(v as ScatterAxisKey)} options={Object.entries(SCATTER_AXES).map(([value, a]) => ({ value, label: `X: ${a.label}` }))} />
                <OptionSelect ariaLabel="Y axis" value={scatterY} onChange={(v) => setScatterY(v as ScatterAxisKey)} options={Object.entries(SCATTER_AXES).map(([value, a]) => ({ value, label: `Y: ${a.label}` }))} />
              </div>
            }
          >
            <ResponsiveContainer width="100%" height={300}>
              <ScatterChart margin={{ top: 15, right: 20, bottom: 15, left: 15 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={LINE} />
                <XAxis
                  type="number"
                  dataKey={scatterX}
                  name={SCATTER_AXES[scatterX].label}
                  tick={{ fontSize: 11, fill: MUTED }}
                  axisLine={{ stroke: LINE }}
                  tickLine={false}
                  scale={scatterX === "shutterSeconds" ? "log" : "linear"}
                  // Not [0, max]: a 0 tick collides with the Y axis's bottom label.
                  domain={["dataMin", "dataMax"]}
                  // Pixel padding keeps the first X label clear of the Y axis's bottom label.
                  padding={{ left: 24 }}
                  ticks={scatterX === "shutterSeconds" ? scatterShutterTicks : undefined}
                  tickFormatter={(v: number) => SCATTER_AXES[scatterX].format(v)}
                  label={{ value: SCATTER_AXES[scatterX].label, position: "insideBottom", offset: -8, fontSize: 11, fill: MUTED }}
                />
                <YAxis
                  type="number"
                  dataKey={scatterY}
                  name={SCATTER_AXES[scatterY].label}
                  width={70}
                  tick={{ fontSize: 11, fill: MUTED }}
                  axisLine={{ stroke: LINE }}
                  tickLine={false}
                  scale={scatterY === "shutterSeconds" ? "log" : "linear"}
                  domain={["dataMin", "dataMax"]}
                  ticks={scatterY === "shutterSeconds" ? scatterShutterTicks : undefined}
                  tickFormatter={(v: number) => SCATTER_AXES[scatterY].format(v)}
                  label={{ value: SCATTER_AXES[scatterY].label, angle: -90, position: "insideLeft", offset: 10, fontSize: 11, fill: MUTED }}
                />
                <Tooltip content={<ScatterTooltip xKey={scatterX} yKey={scatterY} />} cursor={{ strokeDasharray: "3 3" }} />
                <Scatter
                  data={scatterPoints}
                  fill={ACCENT}
                  fillOpacity={0.55}
                  cursor="pointer"
                  onClick={(item: { payload?: StatsResponse["scatter"][number] }) => {
                    const point = item.payload;
                    if (!point?.photoId) return;
                    setLightboxSlide({
                      url: `/api/photos/${point.photoId}/display`,
                      caption: point.commonName ?? point.scientificName,
                      info: {
                        focalLengthMm: point.focalLength,
                        aperture: point.aperture,
                        shutter: point.shutterLabel,
                        iso: point.iso,
                      },
                    });
                  }}
                />
              </ScatterChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Gear usage */}
          <ChartCard
            title="Gear usage"
            controls={
              <div className="flex items-center gap-2">
                <OptionSelect ariaLabel="Gear type" value={gearType} onChange={(v) => setGearType(v as typeof gearType)} options={[...GEAR_TYPES]} />
                <OptionSelect ariaLabel="Gear metric" value={gearMetric} onChange={(v) => setGearMetric(v as typeof gearMetric)} options={[...GEAR_METRICS]} />
              </div>
            }
          >
            <ResponsiveContainer width="100%" height={Math.max(120, gearData.length * 34)}>
              <BarChart data={gearData} layout="vertical" margin={{ left: 8 }}>
                <XAxis type="number" hide allowDecimals={false} />
                <YAxis type="category" dataKey="label" width={160} tick={{ fontSize: 11, fill: INK }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ background: "var(--color-surface)", border: `1px solid ${LINE}`, borderRadius: 6, fontSize: 12 }} />
                <Bar dataKey={gearMetric} fill={ACCENT} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* EXIF distributions */}
          <ChartCard title="EXIF distribution" controls={<OptionSelect ariaLabel="EXIF field" value={exifMetric} onChange={(v) => setExifMetric(v as typeof exifMetric)} options={[...EXIF_METRICS]} />}>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={exifData.rows}>
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: MUTED }} axisLine={{ stroke: LINE }} tickLine={false} interval={0} angle={-20} textAnchor="end" height={45} />
                <YAxis tick={{ fontSize: 11, fill: MUTED }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={{ background: "var(--color-surface)", border: `1px solid ${LINE}`, borderRadius: 6, fontSize: 12 }} />
                <Bar
                  dataKey={exifData.key}
                  fill={ACCENT}
                  radius={[3, 3, 0, 0]}
                  cursor={exifMetric === "hitRate" ? undefined : "pointer"}
                  onClick={(row: { payload?: { label: string; photoIds?: string[] } }) => {
                    const photoIds = row.payload?.photoIds;
                    if (!photoIds || photoIds.length === 0) return;
                    setBarBucket({ label: row.payload!.label, photoIds });
                  }}
                />
              </BarChart>
            </ResponsiveContainer>
            {barBucket && (
              <div className="mt-3 border-t border-line pt-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-ink">
                    {barBucket.label}: {pluralize(barBucket.photoIds.length, "photo")}
                  </p>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => downloadBucket(barBucket.photoIds)}
                      disabled={bucketDownloading}
                      className="text-xs text-accent hover:underline disabled:opacity-50"
                    >
                      {bucketDownloading ? "Downloading…" : "Download all"}
                    </button>
                    <button type="button" onClick={() => setBarBucket(null)} className="text-xs text-muted hover:underline">
                      Close
                    </button>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {barBucket.photoIds.slice(0, 60).map((id) => (
                    <button key={id} type="button" onClick={() => setLightboxSlide({ url: `/api/photos/${id}/display` })}>
                      <img src={`/api/photos/${id}/thumb`} alt="" loading="lazy" className="h-16 w-16 rounded object-cover" />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </ChartCard>

          {/* Time of day */}
          <ChartCard title="Time of day">
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={stats.timeOfDay}>
                <XAxis dataKey="hour" tickFormatter={(h: number) => (h % 3 === 0 ? stats.timeOfDay[h].label : "")} tick={{ fontSize: 10, fill: MUTED }} axisLine={{ stroke: LINE }} tickLine={false} interval={0} />
                <YAxis tick={{ fontSize: 11, fill: MUTED }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip labelFormatter={(h) => stats.timeOfDay[Number(h)]?.label ?? ""} contentStyle={{ background: "var(--color-surface)", border: `1px solid ${LINE}`, borderRadius: 6, fontSize: 12 }} />
                <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                  {stats.timeOfDay.map((d) => (
                    <Cell key={d.hour} fill={d.hour === busiestHour?.hour ? ACCENT : LINE} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Countries photographed */}
          <ChartCard title={`Countries photographed in (${stats.countriesPhotographed.count})`}>
            {stats.countriesPhotographed.countries.length === 0 ? (
              <p className="text-sm text-muted">
                No region data on your captures yet. Pick a region during import (used for species suggestions) and it'll
                show up here.
              </p>
            ) : (
              <ul className="grid grid-cols-2 gap-1.5 text-sm sm:grid-cols-3">
                {stats.countriesPhotographed.countries.map((c) => (
                  <li key={c.name} className="flex items-center justify-between gap-2 text-ink">
                    <span className="truncate">{c.name}</span>
                    <span className="text-xs text-muted">{c.photoCount}</span>
                  </li>
                ))}
              </ul>
            )}
          </ChartCard>

          {/* Collection intelligence: always over the whole library, unaffected by the filter. */}
          <div>
            <h2 className="mb-2 text-sm font-semibold text-ink">Collection intelligence</h2>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <ChartCard title="Most photographed">
                {mostPhotographed.length === 0 ? (
                  <p className="text-sm text-muted">No photos yet.</p>
                ) : (
                  <ol className="space-y-1 text-sm">
                    {mostPhotographed.map((s, i) => (
                      <li key={s.speciesId} className="flex items-center justify-between gap-2">
                        <span className="truncate text-ink">
                          <span className="text-muted">{i + 1}.</span> {s.commonName ?? s.scientificName}
                        </span>
                        <span className="shrink-0 text-xs text-muted">{pluralize(s.totalPhotos, "photo")}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </ChartCard>

              <ChartCard title="One-and-done species" controls={<InfoTip align="right" paragraphs={["Species you've photographed exactly once. Candidates for going back for a better shot."]} />}>
                {oneAndDone.length === 0 ? (
                  <p className="text-sm text-muted">Every species you've photographed has 2+ photos.</p>
                ) : (
                  <>
                    <p className="mb-2 text-sm text-ink">
                      <span className="font-semibold">{oneAndDone.length}</span> species represented by only one photograph.
                    </p>
                    <ul className="grid grid-cols-2 gap-1 text-xs text-muted sm:grid-cols-3">
                      {oneAndDone.slice(0, 30).map((s) => (
                        <li key={s.speciesId} className="truncate">
                          {s.commonName ?? s.scientificName}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </ChartCard>

              <ChartCard
                title="Could use a better photo"
                controls={<InfoTip paragraphs={["Species with only one photo, and you've rated it 1 star yourself."]} />}
              >
                {needsBetterPhoto.length === 0 ? (
                  <p className="text-sm text-muted">Nothing stands out. No single-photo species is rated 1 star.</p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {needsBetterPhoto.slice(0, 10).map((s) => (
                      <li key={s.speciesId} className="flex items-center justify-between gap-2 text-ink">
                        <span className="truncate">{s.commonName ?? s.scientificName}</span>
                        <span className="shrink-0 text-xs text-muted">1 photo, rated ★</span>
                      </li>
                    ))}
                  </ul>
                )}
              </ChartCard>

              <ChartCard title="Archive health" controls={<InfoTip align="right" paragraphs={["How much of your library is missing data a normal photo would have."]} />}>
                {!archiveHealth ? (
                  <Spinner />
                ) : (
                  <ul className="space-y-1.5 text-sm text-ink">
                    <li className="flex items-center justify-between">
                      {archiveHealth.missingDate > 0 ? (
                        <Link to="/gallery?missingDate=1" className="text-accent hover:underline">
                          Missing date
                        </Link>
                      ) : (
                        <span>Missing date</span>
                      )}
                      <span className="text-muted">{archiveHealth.missingDate} / {archiveHealth.total}</span>
                    </li>
                  </ul>
                )}
              </ChartCard>

              <ChartCard title="Photography DNA" controls={<InfoTip paragraphs={["A statistical fingerprint of how you shoot wildlife: what you photograph and what kind of shot you tend to get."]} />}>
                {!photographyDna ? (
                  <Spinner />
                ) : (
                  <div className="space-y-3 text-sm">
                    <div>
                      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">By taxon</p>
                      {photographyDna.taxonBreakdown.slice(0, 5).map((t) => (
                        <div key={t.taxonClass} className="flex items-center justify-between text-ink">
                          <span>{taxonDisplayLabel(t.taxonClass, namingStyles)}</span>
                          <span className="text-muted">{t.percent}%</span>
                        </div>
                      ))}
                    </div>
                    <div>
                      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">By kind of shot</p>
                      {photographyDna.categoryBreakdown.map((c) => (
                        <div key={c.key} className="flex items-center justify-between text-ink">
                          <span className="capitalize">{c.key}</span>
                          <span className="text-muted">{c.percent}%</span>
                        </div>
                      ))}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                      {photographyDna.medianFocalLengthMm != null && <span>Median focal length: {Math.round(photographyDna.medianFocalLengthMm)}mm</span>}
                      {photographyDna.medianShutterSeconds != null && (
                        <span>Median shutter: {SCATTER_AXES.shutterSeconds.format(photographyDna.medianShutterSeconds)}</span>
                      )}
                      {photographyDna.medianIso != null && <span>Median ISO: {Math.round(photographyDna.medianIso)}</span>}
                    </div>
                  </div>
                )}
              </ChartCard>

              <ChartCard
                title="Year over year"
                controls={
                  availableYears.length > 1 && (
                    <div className="flex items-center gap-1.5 text-xs">
                      <OptionSelect
                        ariaLabel="First year"
                        value={String(yearA ?? "")}
                        onChange={(v) => setYearA(Number(v))}
                        options={availableYears.map((y) => ({ value: String(y), label: String(y) }))}
                      />
                      <span className="text-muted">vs</span>
                      <OptionSelect
                        ariaLabel="Second year"
                        value={String(yearB ?? "")}
                        onChange={(v) => setYearB(Number(v))}
                        options={availableYears.map((y) => ({ value: String(y), label: String(y) }))}
                      />
                    </div>
                  )
                }
              >
                {availableYears.length < 2 ? (
                  <p className="text-sm text-muted">Need photos from at least two different years to compare.</p>
                ) : !yearComparison ? (
                  <Spinner />
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted">
                        <th className="pb-1 font-medium"></th>
                        <th className="pb-1 font-medium">{yearComparison.a.year}</th>
                        <th className="pb-1 font-medium">{yearComparison.b.year}</th>
                      </tr>
                    </thead>
                    <tbody className="text-ink">
                      <tr>
                        <td className="text-muted">Species</td>
                        <td>{yearComparison.a.speciesCount}</td>
                        <td>{yearComparison.b.speciesCount}</td>
                      </tr>
                      <tr>
                        <td className="text-muted">Photos</td>
                        <td>{yearComparison.a.photoCount}</td>
                        <td>{yearComparison.b.photoCount}</td>
                      </tr>
                      <tr>
                        <td className="text-muted">Avg focal length</td>
                        <td>{yearComparison.a.avgFocalLength != null ? `${yearComparison.a.avgFocalLength}mm` : <NoValue />}</td>
                        <td>{yearComparison.b.avgFocalLength != null ? `${yearComparison.b.avgFocalLength}mm` : <NoValue />}</td>
                      </tr>
                      <tr>
                        <td className="text-muted">Avg ISO</td>
                        <td>{yearComparison.a.avgIso ?? <NoValue />}</td>
                        <td>{yearComparison.b.avgIso ?? <NoValue />}</td>
                      </tr>
                    </tbody>
                  </table>
                )}
              </ChartCard>
            </div>
          </div>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-ink">Collection breakdown</h2>
            <CollectionStatsPanel />
          </div>
        </div>
      )}

      {lightboxSlide && <Lightbox slides={[lightboxSlide]} index={0} onIndexChange={() => {}} onClose={() => setLightboxSlide(null)} />}
    </div>
  );
}
