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
import InfoTip from "../../components/InfoTip";
import { pluralize } from "../../lib/pluralize";
import { ChartCard, OptionSelect } from "./StatsUi";
import {
  EXIF_METRICS,
  GEAR_METRICS,
  GEAR_TYPES,
  MONTHLY_METRICS,
  SCATTER_AXES,
  type ExifMetric,
  type GearMetric,
  type GearType,
  type MonthlyMetric,
  type ScatterAxisKey,
} from "./statsHelpers";
import type { ScatterPoint, StatsResponse } from "./types";

const ACCENT = "var(--color-accent)";
const INK = "var(--color-ink)";
const MUTED = "var(--color-muted)";
const LINE = "var(--color-line)";
const TOOLTIP_STYLE = {
  background: "var(--color-surface)",
  border: `1px solid ${LINE}`,
  borderRadius: 6,
  fontSize: 12,
};

const KEEPER_INFO_PARAGRAPHS = [
  'A "keeper" is any photo you\'ve edited/adjusted and kept, except one rated 1 star.',
  "Rate a photo 1 star to exclude it from your stats, useful for an ID shot you only kept to confirm the species, not one you'd count as a real photo.",
];

const SCATTER_AXIS_OPTIONS = (prefix: string) =>
  Object.entries(SCATTER_AXES).map(([value, a]) => ({ value, label: `${prefix}: ${a.label}` }));

export function MonthlyChart({
  perMonth,
  metric,
  onMetricChange,
}: {
  perMonth: StatsResponse["perMonth"];
  metric: MonthlyMetric;
  onMetricChange: (metric: MonthlyMetric) => void;
}) {
  return (
    <ChartCard
      title="By month"
      controls={
        <div className="flex items-center gap-2">
          <OptionSelect
            ariaLabel="Monthly metric"
            value={metric}
            onChange={(v) => onMetricChange(v as MonthlyMetric)}
            options={[...MONTHLY_METRICS]}
          />
          <InfoTip paragraphs={KEEPER_INFO_PARAGRAPHS} align="right" />
        </div>
      }
    >
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={perMonth}>
          <CartesianGrid strokeDasharray="3 3" stroke={LINE} vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: MUTED }}
            tickLine={false}
            axisLine={{ stroke: LINE }}
            minTickGap={40}
          />
          <YAxis tick={{ fontSize: 11, fill: MUTED }} tickLine={false} axisLine={false} allowDecimals={false} />
          <Tooltip contentStyle={TOOLTIP_STYLE} />
          <Area type="monotone" dataKey={metric} stroke={ACCENT} fill={ACCENT} fillOpacity={0.15} strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

function ScatterTooltip({
  active,
  payload,
  xKey,
  yKey,
}: {
  active?: boolean;
  payload?: Array<{ payload: ScatterPoint }>;
  xKey: ScatterAxisKey;
  yKey: ScatterAxisKey;
}) {
  if (!active || !payload?.[0]) return null;
  const p = payload[0].payload;
  const xVal = p[xKey];
  const yVal = p[yKey];
  return (
    <div className="flex items-center gap-2 rounded-md border border-line bg-surface p-2 text-xs shadow-md">
      {p.photoId && (
        <img src={`/api/photos/${p.photoId}/thumb`} alt="" loading="lazy" className="h-12 w-12 rounded object-cover" />
      )}
      <div>
        <p className="font-medium text-ink">{p.commonName ?? p.scientificName}</p>
        <p className="text-muted">
          {xVal != null ? SCATTER_AXES[xKey].format(xVal) : "N/A"} ·{" "}
          {yVal != null ? SCATTER_AXES[yKey].format(yVal) : "N/A"}
        </p>
        {p.photoId && <p className="text-muted">Click to view full size</p>}
      </div>
    </div>
  );
}

// Every photo plotted on two settings the user picks. A shutter-speed axis is logarithmic.
export function PhotoScatterChart({
  points,
  shutterTicks,
  x,
  y,
  onXChange,
  onYChange,
  onOpenPoint,
}: {
  points: ScatterPoint[];
  shutterTicks: number[];
  x: ScatterAxisKey;
  y: ScatterAxisKey;
  onXChange: (axis: ScatterAxisKey) => void;
  onYChange: (axis: ScatterAxisKey) => void;
  onOpenPoint: (point: ScatterPoint) => void;
}) {
  return (
    <ChartCard
      title="Your photo distribution"
      controls={
        <div className="flex items-center gap-2">
          <OptionSelect
            ariaLabel="X axis"
            value={x}
            onChange={(v) => onXChange(v as ScatterAxisKey)}
            options={SCATTER_AXIS_OPTIONS("X")}
          />
          <OptionSelect
            ariaLabel="Y axis"
            value={y}
            onChange={(v) => onYChange(v as ScatterAxisKey)}
            options={SCATTER_AXIS_OPTIONS("Y")}
          />
        </div>
      }
    >
      <ResponsiveContainer width="100%" height={300}>
        <ScatterChart margin={{ top: 15, right: 20, bottom: 15, left: 15 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={LINE} />
          <XAxis
            type="number"
            dataKey={x}
            name={SCATTER_AXES[x].label}
            tick={{ fontSize: 11, fill: MUTED }}
            axisLine={{ stroke: LINE }}
            tickLine={false}
            scale={x === "shutterSeconds" ? "log" : "linear"}
            // Not [0, max]: a 0 tick collides with the Y axis's bottom label.
            domain={["dataMin", "dataMax"]}
            // Pixel padding keeps the first X label clear of the Y axis's bottom label.
            padding={{ left: 24 }}
            ticks={x === "shutterSeconds" ? shutterTicks : undefined}
            tickFormatter={(v: number) => SCATTER_AXES[x].format(v)}
            label={{
              value: SCATTER_AXES[x].label,
              position: "insideBottom",
              offset: -8,
              fontSize: 11,
              fill: MUTED,
            }}
          />
          <YAxis
            type="number"
            dataKey={y}
            name={SCATTER_AXES[y].label}
            width={70}
            tick={{ fontSize: 11, fill: MUTED }}
            axisLine={{ stroke: LINE }}
            tickLine={false}
            scale={y === "shutterSeconds" ? "log" : "linear"}
            domain={["dataMin", "dataMax"]}
            ticks={y === "shutterSeconds" ? shutterTicks : undefined}
            tickFormatter={(v: number) => SCATTER_AXES[y].format(v)}
            label={{
              value: SCATTER_AXES[y].label,
              angle: -90,
              position: "insideLeft",
              offset: 10,
              fontSize: 11,
              fill: MUTED,
            }}
          />
          <Tooltip content={<ScatterTooltip xKey={x} yKey={y} />} cursor={{ strokeDasharray: "3 3" }} />
          <Scatter
            data={points}
            fill={ACCENT}
            fillOpacity={0.55}
            cursor="pointer"
            onClick={(item: { payload?: ScatterPoint }) => {
              const point = item.payload;
              if (!point?.photoId) return;
              onOpenPoint(point);
            }}
          />
        </ScatterChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function GearChart({
  rows,
  gearType,
  metric,
  onGearTypeChange,
  onMetricChange,
}: {
  rows: Array<{ label: string; photoCount: number; speciesCount: number }>;
  gearType: GearType;
  metric: GearMetric;
  onGearTypeChange: (type: GearType) => void;
  onMetricChange: (metric: GearMetric) => void;
}) {
  return (
    <ChartCard
      title="Gear usage"
      controls={
        <div className="flex items-center gap-2">
          <OptionSelect
            ariaLabel="Gear type"
            value={gearType}
            onChange={(v) => onGearTypeChange(v as GearType)}
            options={[...GEAR_TYPES]}
          />
          <OptionSelect
            ariaLabel="Gear metric"
            value={metric}
            onChange={(v) => onMetricChange(v as GearMetric)}
            options={[...GEAR_METRICS]}
          />
        </div>
      }
    >
      <ResponsiveContainer width="100%" height={Math.max(120, rows.length * 34)}>
        <BarChart data={rows} layout="vertical" margin={{ left: 8 }}>
          <XAxis type="number" hide allowDecimals={false} />
          <YAxis
            type="category"
            dataKey="label"
            width={160}
            tick={{ fontSize: 11, fill: INK }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip contentStyle={TOOLTIP_STYLE} />
          <Bar dataKey={metric} fill={ACCENT} radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

// Clicking a bar (except the species hit rate) lists the photos behind it, which can all be
// downloaded or opened one at a time.
export function ExifChart({
  data,
  metric,
  onMetricChange,
  bucket,
  onBucketChange,
  bucketDownloading,
  onDownloadBucket,
  onOpenPhoto,
}: {
  data: { key: "count" | "species"; rows: Array<{ label: string; photoIds?: string[] }> };
  metric: ExifMetric;
  onMetricChange: (metric: ExifMetric) => void;
  bucket: { label: string; photoIds: string[] } | null;
  onBucketChange: (bucket: { label: string; photoIds: string[] } | null) => void;
  bucketDownloading: boolean;
  onDownloadBucket: (photoIds: string[]) => void;
  onOpenPhoto: (photoId: string) => void;
}) {
  return (
    <ChartCard
      title="EXIF distribution"
      controls={
        <OptionSelect
          ariaLabel="EXIF field"
          value={metric}
          onChange={(v) => onMetricChange(v as ExifMetric)}
          options={[...EXIF_METRICS]}
        />
      }
    >
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data.rows}>
          <XAxis
            dataKey="label"
            tick={{ fontSize: 10, fill: MUTED }}
            axisLine={{ stroke: LINE }}
            tickLine={false}
            interval={0}
            angle={-20}
            textAnchor="end"
            height={45}
          />
          <YAxis tick={{ fontSize: 11, fill: MUTED }} axisLine={false} tickLine={false} allowDecimals={false} />
          <Tooltip contentStyle={TOOLTIP_STYLE} />
          <Bar
            dataKey={data.key}
            fill={ACCENT}
            radius={[3, 3, 0, 0]}
            cursor={metric === "hitRate" ? undefined : "pointer"}
            onClick={(row: { payload?: { label: string; photoIds?: string[] } }) => {
              const photoIds = row.payload?.photoIds;
              if (!photoIds || photoIds.length === 0) return;
              onBucketChange({ label: row.payload!.label, photoIds });
            }}
          />
        </BarChart>
      </ResponsiveContainer>
      {bucket && (
        <div className="mt-3 border-t border-line pt-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-ink">
              {bucket.label}: {pluralize(bucket.photoIds.length, "photo")}
            </p>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => onDownloadBucket(bucket.photoIds)}
                disabled={bucketDownloading}
                className="text-xs text-accent hover:underline disabled:opacity-50"
              >
                {bucketDownloading ? "Downloading…" : "Download all"}
              </button>
              <button type="button" onClick={() => onBucketChange(null)} className="text-xs text-muted hover:underline">
                Close
              </button>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {bucket.photoIds.slice(0, 60).map((id) => (
              <button key={id} type="button" onClick={() => onOpenPhoto(id)}>
                <img src={`/api/photos/${id}/thumb`} alt="" loading="lazy" className="h-16 w-16 rounded object-cover" />
              </button>
            ))}
          </div>
        </div>
      )}
    </ChartCard>
  );
}

export function TimeOfDayChart({
  timeOfDay,
  busiestHour,
}: {
  timeOfDay: StatsResponse["timeOfDay"];
  busiestHour: number | undefined;
}) {
  return (
    <ChartCard title="Time of day">
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={timeOfDay}>
          <XAxis
            dataKey="hour"
            tickFormatter={(h: number) => (h % 3 === 0 ? timeOfDay[h].label : "")}
            tick={{ fontSize: 10, fill: MUTED }}
            axisLine={{ stroke: LINE }}
            tickLine={false}
            interval={0}
          />
          <YAxis tick={{ fontSize: 11, fill: MUTED }} axisLine={false} tickLine={false} allowDecimals={false} />
          <Tooltip labelFormatter={(h) => timeOfDay[Number(h)]?.label ?? ""} contentStyle={TOOLTIP_STYLE} />
          <Bar dataKey="count" radius={[3, 3, 0, 0]}>
            {timeOfDay.map((d) => (
              <Cell key={d.hour} fill={d.hour === busiestHour ? ACCENT : LINE} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function CountriesCard({ countries }: { countries: StatsResponse["countriesPhotographed"] }) {
  return (
    <ChartCard title={`Countries photographed in (${countries.count})`}>
      {countries.countries.length === 0 ? (
        <p className="text-sm text-muted">
          No region data on your captures yet. Pick a region during import (used for species suggestions) and it'll show
          up here.
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-1.5 text-sm sm:grid-cols-3">
          {countries.countries.map((c) => (
            <li key={c.name} className="flex items-center justify-between gap-2 text-ink">
              <span className="truncate">{c.name}</span>
              <span className="text-xs text-muted">{c.photoCount}</span>
            </li>
          ))}
        </ul>
      )}
    </ChartCard>
  );
}
