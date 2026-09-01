import { useEffect, useMemo, useState } from "react";
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
import { api } from "../api/client";
import BackToCollectionLink from "../components/BackToCollectionLink";
import CollectionStatsPanel from "../components/CollectionStats";
import { Spinner } from "../components/LoadingScreen";
import Lightbox, { type LightboxSlide } from "../components/Lightbox";
import InfoTip from "../components/InfoTip";

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
    focalLength: Array<{ label: string; count: number }>;
    iso: Array<{ label: string; count: number }>;
    aperture: Array<{ label: string; count: number }>;
    shutter: Array<{ label: string; count: number }>;
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

type PhotoFilter = "all" | "featured" | "topRated";

const ACCENT = "var(--color-accent)";
const INK = "var(--color-ink)";
const MUTED = "var(--color-muted)";
const LINE = "var(--color-line)";

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
  controls?: React.ReactNode;
  children: React.ReactNode;
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

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
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

// Extended well past what a fixed "1/8000 is the fastest anyone shoots" assumption would cover —
// modern mirrorless electronic shutters go to 1/32000 and beyond, and a photographer who actually
// has shots that fast should see real labeled ticks out there, not have their points plot past
// the last one with no reference. Picked from the same "nice" 1/2-ish progression a camera's own
// shutter dial uses, so labels always read as speeds a photographer recognizes.
const NICE_SHUTTER_DENOMINATORS = [30, 60, 125, 250, 500, 1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000];

// Ticks span exactly what the data covers — no padding beyond the actual min/max, since a tick
// (and the axis space it implies) for a speed nobody actually shot at is just wasted whitespace,
// not useful framing.
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
      {p.photoId && <img src={`/api/photos/${p.photoId}/thumb`} alt="" className="h-12 w-12 rounded object-cover" />}
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
  const [loading, setLoading] = useState(true);
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

  useEffect(() => {
    setLoading(true);
    api
      .get<StatsResponse>(`/stats?filter=${filter}`)
      .then(setStats)
      .finally(() => setLoading(false));
  }, [filter]);

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

  const exifData: { key: "count" | "species"; rows: Array<{ label: string; count?: number; species?: number }> } = useMemo(() => {
    if (!stats) return { key: "count", rows: [] };
    if (exifMetric === "hitRate") return { key: "species", rows: stats.hitRateByFocalLength };
    return { key: "count", rows: stats.exifDistributions[exifMetric] };
  }, [stats, exifMetric]);

  async function handleExport() {
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch(`/api/stats/export.csv?filter=${filter}`, { credentials: "include" });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const csv = await res.text();
      const filename = `lifer-stats-${filter}-${new Date().toISOString().slice(0, 10)}.csv`;

      if (window.liferSetup) {
        // Desktop app: a real native "Save As" dialog, so you pick exactly where this goes
        // instead of it silently landing in your OS's default downloads folder.
        const { save } = await import("@tauri-apps/plugin-dialog");
        const { writeTextFile } = await import("@tauri-apps/plugin-fs");
        const path = await save({ defaultPath: filename, filters: [{ name: "CSV", extensions: ["csv"] }] });
        if (!path) return; // user cancelled the dialog
        await writeTextFile(path, csv);
      } else {
        // Plain browser (self-hosted web access) — no native dialog available, fall back to
        // the browser's own download handling.
        const blob = new Blob([csv], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Couldn't export stats");
    } finally {
      setExporting(false);
    }
  }

  if (loading && !stats) return <Spinner label="Loading stats…" />;
  if (!stats) return null;

  const topCamera = stats.gearUsage.cameras[0];
  const topFocalLength = [...stats.exifDistributions.focalLength].sort((a, b) => b.count - a.count)[0];
  const busiestHour = [...stats.timeOfDay].sort((a, b) => b.count - a.count)[0];
  const bestMonth = [...stats.perMonth].sort((a, b) => b.newLifers - a.newLifers)[0];

  return (
    <div className="min-h-screen bg-canvas">
      <header className="page-header flex items-center justify-between border-b border-line bg-surface px-6 py-4">
        <div>
          <BackToCollectionLink className="text-sm text-muted hover:underline" />
          <h1 className="mt-1 text-lg font-semibold text-ink">Stats</h1>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={filter}
            onChange={(v) => setFilter(v as PhotoFilter)}
            options={[
              { value: "all", label: "All keepers" },
              { value: "featured", label: "Featured only" },
              { value: "topRated", label: "Top rated (5-star)" },
            ]}
          />
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:bg-surface-muted disabled:opacity-50"
          >
            {exporting ? "Exporting…" : "Export CSV"}
          </button>
        </div>
      </header>
      {exportError && <p className="border-b border-line bg-surface px-6 py-2 text-sm text-red-600">{exportError}</p>}

      {stats.totalKeepers === 0 ? (
        <div className="p-6">
          <p className="text-sm text-muted">
            No stats yet. Stats are built from your edited photos (RAW-only imports don't count), so import and edit a few
            to see them here.
          </p>
        </div>
      ) : (
        <div className="mx-auto max-w-5xl space-y-6 p-6">
          {/* Insight cards — the "how do I shoot" fingerprint. */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {topCamera && (
              <StatCard label="Top camera" value={topCamera.model} sub={`${Math.round((topCamera.photoCount / stats.totalKeepers) * 100)}% of keepers`} />
            )}
            {topFocalLength && topFocalLength.count > 0 && <StatCard label="Favorite focal length" value={topFocalLength.label} sub="most common range" />}
            {busiestHour && busiestHour.count > 0 && (
              <StatCard label="Peak shooting time" value={busiestHour.label} sub={`${Math.round((busiestHour.count / stats.totalKeepers) * 100)}% of keepers`} />
            )}
            {bestMonth && bestMonth.newLifers > 0 && <StatCard label="Best month" value={bestMonth.label} sub={`${bestMonth.newLifers} lifer${bestMonth.newLifers === 1 ? "" : "s"}`} />}
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

          {/* Ghost/Lost species — only shown if you've actually found one, since most
             photographers will never encounter either and the section would just take up
             space nobody cares about otherwise. */}
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

          {/* Monthly trend — new lifers or total keepers, picked from the dropdown */}
          <ChartCard
            title="By month"
            controls={
              <div className="flex items-center gap-2">
                <Select value={monthlyMetric} onChange={(v) => setMonthlyMetric(v as typeof monthlyMetric)} options={[...MONTHLY_METRICS]} />
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
                <Select value={scatterX} onChange={(v) => setScatterX(v as ScatterAxisKey)} options={Object.entries(SCATTER_AXES).map(([value, a]) => ({ value, label: `X: ${a.label}` }))} />
                <Select value={scatterY} onChange={(v) => setScatterY(v as ScatterAxisKey)} options={Object.entries(SCATTER_AXES).map(([value, a]) => ({ value, label: `Y: ${a.label}` }))} />
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
                  // 'dataMin'/'dataMax' rather than the implicit [0, dataMax] a plain linear
                  // axis defaults to — forcing 0 into the domain put a "0mm"-style tick right
                  // at the plot's bottom-left corner, exactly where the Y-axis's own bottom
                  // tick label also renders, so the two collided regardless of which two axes
                  // were picked. Real photo EXIF values are never anywhere near 0 anyway.
                  domain={["dataMin", "dataMax"]}
                  // Pixel padding, not domain padding — pushes the plotted range in from the
                  // left edge without adding any fake ticks or expanding the value range past
                  // what the data actually covers, just enough that the leftmost X label clears
                  // the Y-axis's own bottom label instead of overlapping it in the corner.
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

          {/* Gear usage — one chart, pick the gear type and metric instead of several fixed bar graphs */}
          <ChartCard
            title="Gear usage"
            controls={
              <div className="flex items-center gap-2">
                <Select value={gearType} onChange={(v) => setGearType(v as typeof gearType)} options={[...GEAR_TYPES]} />
                <Select value={gearMetric} onChange={(v) => setGearMetric(v as typeof gearMetric)} options={[...GEAR_METRICS]} />
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

          {/* EXIF distributions — one chart, pick the metric instead of four+ fixed bar graphs */}
          <ChartCard title="EXIF distribution" controls={<Select value={exifMetric} onChange={(v) => setExifMetric(v as typeof exifMetric)} options={[...EXIF_METRICS]} />}>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={exifData.rows}>
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: MUTED }} axisLine={{ stroke: LINE }} tickLine={false} interval={0} angle={-20} textAnchor="end" height={45} />
                <YAxis tick={{ fontSize: 11, fill: MUTED }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={{ background: "var(--color-surface)", border: `1px solid ${LINE}`, borderRadius: 6, fontSize: 12 }} />
                <Bar dataKey={exifData.key} fill={ACCENT} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
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

          {/* Existing rarity/year breakdown — a filter/collection view, not a photographer
              story, but still useful, so it stays here rather than being cut entirely. */}
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
