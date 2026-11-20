import ProgressiveImg from "../../components/ProgressiveImg";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
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
  ZAxis,
} from "recharts";
import { Tooltip as ControlTooltip } from "../../components/Tooltip";
import InfoTip from "../../components/InfoTip";
import FilterPopover, { FilterFieldLabel } from "../../components/FilterPopover";
import { DateRangeField } from "../../components/PhotoGridControls";
import { formatMonthName, formatNumber } from "../../lib/format";
import { ChartCard, OptionSelect } from "./StatsUi";
import Panel from "../../components/Panel";
import {
  EXIF_METRICS,
  GEAR_METRICS,
  GEAR_TYPES,
  MONTHLY_METRICS,
  SCATTER_AXES,
  groupScatterPoints,
  type ExifMetric,
  type GearMetric,
  type GearType,
  type MonthlyMetric,
  type ScatterAxisKey,
} from "./statsHelpers";
import type { ScatterPoint, StatsResponse } from "./types";
import { useSpeciesName } from "../../lib/speciesName";
import EmptyState from "../../components/EmptyState";
import Button from "../../components/Button";

const ACCENT = "var(--color-accent)";
const INK = "var(--color-ink)";
const MUTED = "var(--color-muted)";
const LINE = "var(--color-line)";

// One look for every chart's hover: what the bar or point is, then "Photos: 12". Recharts'
// default prints the raw data key ("newLifers : 3").
function ValueTooltip({
  active,
  payload,
  label,
  name,
  formatLabel,
}: {
  active?: boolean;
  payload?: Array<{ value?: number | string; payload?: Record<string, unknown> }>;
  label?: string | number;
  name: string;
  /** Gets the hovered row too, for a fuller label than the axis has room for. */
  formatLabel?: (label: string | number, row: Record<string, unknown>) => string;
}) {
  if (!active || !payload?.length || label == null) return null;
  const value = payload[0].value;
  return (
    <div className="rounded-panel border border-line bg-surface px-2 py-1.5 text-footnote shadow-md">
      <p className="font-medium text-ink">{formatLabel ? formatLabel(label, payload[0].payload ?? {}) : label}</p>
      <p className="text-muted">
        {name}: <span className="text-ink">{typeof value === "number" ? formatNumber(value) : value}</span>
      </p>
    </div>
  );
}

// The axis says "Aug 26"; the hover spells out "August 2026".
const fullMonth = (label: string | number, row: Record<string, unknown>) => {
  const [year, month] = String(row.month ?? "")
    .split("-")
    .map(Number);
  return year && month ? `${formatMonthName(month - 1)} ${year}` : String(label);
};
// The hovered bar's column, lighter than the bars themselves.
const HOVER_CURSOR = { fill: "var(--color-surface-muted)" };

type KeyedOption = { value: string; labelKey: string };

const translateOptions = (options: ReadonlyArray<KeyedOption>, t: TFunction) =>
  options.map((o) => ({ value: o.value, label: t(o.labelKey) }));

const metricLabel = (options: ReadonlyArray<KeyedOption>, value: string, t: TFunction) => {
  const option = options.find((o) => o.value === value);
  return option ? t(option.labelKey) : value;
};

const KEEPER_INFO_PARAGRAPHS = ["stats.charts.keeperInfo", "stats.charts.keeperInfoRating"];

const SCATTER_AXIS_OPTIONS = (prefix: string, t: TFunction) =>
  Object.entries(SCATTER_AXES).map(([value, a]) => ({
    value,
    label: t("stats.options.axisOption", { axis: prefix, field: t(a.labelKey) }),
  }));

export function MonthlyChart({
  perMonth,
  metric,
  onMetricChange,
}: {
  perMonth: StatsResponse["perMonth"];
  metric: MonthlyMetric;
  onMetricChange: (metric: MonthlyMetric) => void;
}) {
  const { t } = useTranslation();
  return (
    <ChartCard
      title={t("stats.charts.byMonth")}
      controls={
        <div className="flex items-center gap-2">
          <OptionSelect
            ariaLabel={t("stats.charts.monthlyMetric")}
            value={metric}
            onChange={(v) => onMetricChange(v as MonthlyMetric)}
            options={translateOptions(MONTHLY_METRICS, t)}
          />
          <InfoTip paragraphs={KEEPER_INFO_PARAGRAPHS.map((key) => t(key))} align="right" />
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
          <YAxis
            tick={{ fontSize: 11, fill: MUTED }}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            domain={[0, "dataMax"]}
          />
          <Tooltip content={<ValueTooltip name={metricLabel(MONTHLY_METRICS, metric, t)} formatLabel={fullMonth} />} />
          <Area type="monotone" dataKey={metric} stroke={ACCENT} fill={ACCENT} fillOpacity={0.15} strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

type ScatterGroup = ScatterPoint & { photos: ScatterPoint[]; count: number };

// Up to this many thumbnails in a dot's card; the rest open with "View all".
const CARD_THUMBS = 12;
// Just long enough to cross from a dot onto its card.
const CARD_CLOSE_DELAY_MS = 120;

/** A dot's card: its photos as thumbnails that open one by one, and its settings. Stays open while
 *  the pointer is on it, so a photo can be picked. */
function ScatterCard({
  group,
  xKey,
  yKey,
  onOpen,
  onViewAll,
}: {
  group: ScatterGroup;
  xKey: ScatterAxisKey;
  yKey: ScatterAxisKey;
  onOpen: (startIndex: number) => void;
  onViewAll: () => void;
}) {
  const { t } = useTranslation();
  const speciesName = useSpeciesName();
  const photos = group.photos.filter((photo) => photo.photoId);
  const names = [...new Set(group.photos.map((photo) => speciesName(photo)))];
  const xVal = group[xKey];
  const yVal = group[yKey];
  return (
    <div className="w-max max-w-xs rounded-panel border border-line bg-surface p-2 text-footnote shadow-md">
      <p className="font-medium text-ink">
        {group.count > 1 ? t("stats.charts.photoCount", { count: group.count }) : names[0]}
      </p>
      {group.count > 1 && (
        <p className="text-ink">
          {names.length > 2
            ? t("stats.charts.namesAndMore", { names: names.slice(0, 2).join(", ") })
            : names.join(", ")}
        </p>
      )}
      <p className="text-muted">
        {xVal != null ? SCATTER_AXES[xKey].format(xVal) : t("stats.charts.notAvailable")} ·{" "}
        {yVal != null ? SCATTER_AXES[yKey].format(yVal) : t("stats.charts.notAvailable")}
      </p>
      {photos.length > 0 && (
        <div className="mt-1.5 grid grid-cols-4 gap-1">
          {photos.slice(0, CARD_THUMBS).map((photo, i) => (
            <ControlTooltip key={photo.photoId} content={{ label: speciesName(photo) }}>
              {(tip) => (
                // raw-control: the photo thumbnail is the button
                <button
                  type="button"
                  {...tip}
                  onClick={() => onOpen(i)}
                  aria-label={speciesName(photo)}
                  className="rounded-badge focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <ProgressiveImg
                    thumbSrc={`/api/photos/${photo.photoId}/thumb`}
                    alt={speciesName(photo)}
                    className="h-14 w-14 rounded-badge object-cover hover:opacity-80"
                  />
                </button>
              )}
            </ControlTooltip>
          ))}
        </div>
      )}
      {photos.length > CARD_THUMBS && (
        <Button variant="link" size="sm" onClick={onViewAll} className="mt-1">
          {t("stats.charts.viewAll", { count: photos.length })}
        </Button>
      )}
    </div>
  );
}

const ALL = "";
const gearOptions = (values: Array<string | null>, all: string) => [
  { value: ALL, label: all },
  ...[...new Set(values.filter((v): v is string => !!v))].sort().map((v) => ({ value: v, label: v })),
];

// Every photo plotted on two settings the user picks, narrowed by body, lens and date in its
// Filters panel. A shutter-speed axis is logarithmic.
export function PhotoScatterChart({
  points,
  shutterTicks,
  x,
  y,
  onXChange,
  onYChange,
  onOpenPoints,
  onViewAll,
}: {
  points: ScatterPoint[];
  shutterTicks: number[];
  x: ScatterAxisKey;
  y: ScatterAxisKey;
  onXChange: (axis: ScatterAxisKey) => void;
  onYChange: (axis: ScatterAxisKey) => void;
  /** The photos behind a dot (one, or several at the same settings), opened at `startIndex`. */
  onOpenPoints: (points: ScatterPoint[], startIndex: number) => void;
  /** Every photo behind a dot as a grid, under a title naming the count and settings. */
  onViewAll: (points: ScatterPoint[], title: string) => void;
}) {
  const { t } = useTranslation();
  const [camera, setCamera] = useState(ALL);
  const [lens, setLens] = useState(ALL);
  // YYYY-MM-DD, inclusive.
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [dateRangeOpen, setDateRangeOpen] = useState(false);
  const cameraOptions = useMemo(
    () =>
      gearOptions(
        points.map((p) => p.camera),
        t("stats.charts.allBodies"),
      ),
    [points, t],
  );
  // The lens list follows the body picked, so it only offers lenses used on it.
  const lensOptions = useMemo(
    () =>
      gearOptions(
        points.filter((p) => !camera || p.camera === camera).map((p) => p.lens),
        t("stats.charts.allLenses"),
      ),
    [points, camera, t],
  );
  const years = useMemo(
    () => [...new Set(points.map((p) => p.takenAt?.slice(0, 4)).filter((v): v is string => !!v))].sort().reverse(),
    [points],
  );
  // The year a range covers exactly, for the Year shortcut; "" for all time or a custom range.
  const year = dateFrom.endsWith("-01-01") && dateTo === `${dateFrom.slice(0, 4)}-12-31` ? dateFrom.slice(0, 4) : "";
  const shown = useMemo(
    () =>
      points.filter((p) => {
        if (camera && p.camera !== camera) return false;
        if (lens && p.lens !== lens) return false;
        if (!dateFrom && !dateTo) return true;
        const day = p.takenAt?.slice(0, 10);
        return !!day && (!dateFrom || day >= dateFrom) && (!dateTo || day <= dateTo);
      }),
    [points, camera, lens, dateFrom, dateTo],
  );
  const activeFilters = (camera ? 1 : 0) + (lens ? 1 : 0) + (dateFrom || dateTo ? 1 : 0);
  // Photos whose dots would overlap share one, sized by how many, so none is hidden under another.
  const groups = useMemo(
    () => groupScatterPoints(shown, x, y, { logX: x === "shutterSeconds", logY: y === "shutterSeconds" }),
    [shown, x, y],
  );
  const maxCount = Math.max(1, ...groups.map((g) => g.count));

  // The hovered dot's card, placed beside it; it closes a moment after the pointer leaves both.
  const [card, setCard] = useState<{ group: ScatterGroup; cx: number; cy: number } | null>(null);
  const [width, setWidth] = useState(0);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keepCard = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const closeCardSoon = () => {
    keepCard();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setCard(null);
    }, CARD_CLOSE_DELAY_MS);
  };
  useEffect(() => keepCard, []);
  const open = (group: ScatterGroup, startIndex: number) => {
    const photos = group.photos.filter((photo) => photo.photoId);
    if (photos.length === 0) return;
    setCard(null);
    onOpenPoints(photos, startIndex);
  };
  // The card opens toward whichever side has room.
  const onRight = !card || card.cx < width / 2;

  return (
    <ChartCard
      title={t("stats.charts.distribution")}
      controls={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <FilterPopover activeCount={activeFilters}>
            {cameraOptions.length > 2 && (
              <div>
                <FilterFieldLabel>{t("stats.charts.body")}</FilterFieldLabel>
                <OptionSelect
                  ariaLabel={t("stats.charts.cameraBody")}
                  value={camera}
                  onChange={(v) => {
                    setCamera(v);
                    setLens(ALL);
                  }}
                  options={cameraOptions}
                />
              </div>
            )}
            {lensOptions.length > 2 && (
              <div>
                <FilterFieldLabel>{t("stats.charts.lens")}</FilterFieldLabel>
                <OptionSelect
                  ariaLabel={t("stats.charts.lens")}
                  value={lens}
                  onChange={setLens}
                  options={lensOptions}
                />
              </div>
            )}
            {years.length > 1 && (
              <div>
                <FilterFieldLabel>{t("stats.charts.year")}</FilterFieldLabel>
                <OptionSelect
                  ariaLabel={t("stats.charts.year")}
                  value={year}
                  onChange={(v) => {
                    setDateFrom(v ? `${v}-01-01` : "");
                    setDateTo(v ? `${v}-12-31` : "");
                  }}
                  options={[
                    { value: "", label: t("stats.charts.allYears") },
                    ...years.map((y) => ({ value: y, label: y })),
                  ]}
                />
              </div>
            )}
            <DateRangeField
              dateFrom={dateFrom}
              dateTo={dateTo}
              onDateFromChange={setDateFrom}
              onDateToChange={setDateTo}
              open={dateRangeOpen}
              onOpen={() => setDateRangeOpen(true)}
              onClear={() => {
                setDateFrom("");
                setDateTo("");
                setDateRangeOpen(false);
              }}
            />
          </FilterPopover>
          <OptionSelect
            ariaLabel={t("stats.charts.xAxis")}
            value={x}
            onChange={(v) => onXChange(v as ScatterAxisKey)}
            options={SCATTER_AXIS_OPTIONS("X", t)}
          />
          <OptionSelect
            ariaLabel={t("stats.charts.yAxis")}
            value={y}
            onChange={(v) => onYChange(v as ScatterAxisKey)}
            options={SCATTER_AXIS_OPTIONS("Y", t)}
          />
        </div>
      }
    >
      {/* Recharts doesn't always report leaving a dot, so moving anywhere else in the chart, or out
          of it, closes the card too. */}
      <div
        className="relative"
        onMouseMove={(e) => {
          const target = e.target as Element;
          const onDotOrCard = target.closest(".recharts-scatter-symbol, [data-scatter-card]");
          if (card && !onDotOrCard && !closeTimer.current) closeCardSoon();
        }}
        onMouseLeave={() => {
          keepCard();
          setCard(null);
        }}
      >
        <ResponsiveContainer width="100%" height={300} onResize={(w) => setWidth(w)}>
          <ScatterChart margin={{ top: 15, right: 20, bottom: 15, left: 15 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={LINE} />
            <XAxis
              type="number"
              dataKey={x}
              name={t(SCATTER_AXES[x].labelKey)}
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
                value: t(SCATTER_AXES[x].labelKey),
                position: "insideBottom",
                offset: -8,
                fontSize: 11,
                fill: MUTED,
              }}
            />
            <YAxis
              type="number"
              dataKey={y}
              name={t(SCATTER_AXES[y].labelKey)}
              width={70}
              tick={{ fontSize: 11, fill: MUTED }}
              axisLine={{ stroke: LINE }}
              tickLine={false}
              scale={y === "shutterSeconds" ? "log" : "linear"}
              domain={["dataMin", "dataMax"]}
              ticks={y === "shutterSeconds" ? shutterTicks : undefined}
              tickFormatter={(v: number) => SCATTER_AXES[y].format(v)}
              label={{
                value: t(SCATTER_AXES[y].labelKey),
                angle: -90,
                position: "insideLeft",
                offset: 10,
                fontSize: 11,
                fill: MUTED,
              }}
            />
            <ZAxis type="number" dataKey="count" domain={[1, maxCount]} range={[64, 400]} />
            <Scatter
              data={groups}
              fill={ACCENT}
              fillOpacity={0.55}
              cursor="pointer"
              onMouseEnter={(item: { payload?: ScatterGroup; cx?: number; cy?: number }) => {
                keepCard();
                if (item.payload && item.cx != null && item.cy != null)
                  setCard({ group: item.payload, cx: item.cx, cy: item.cy });
              }}
              onMouseLeave={closeCardSoon}
              onClick={(item: { payload?: ScatterGroup }) => item.payload && open(item.payload, 0)}
            />
          </ScatterChart>
        </ResponsiveContainer>
        {card && (
          <div
            data-scatter-card=""
            className="absolute z-10 -translate-y-1/2"
            style={onRight ? { left: card.cx + 8, top: card.cy } : { right: width - card.cx + 8, top: card.cy }}
            onMouseEnter={keepCard}
            onMouseLeave={closeCardSoon}
          >
            <ScatterCard
              group={card.group}
              xKey={x}
              yKey={y}
              onOpen={(i) => open(card.group, i)}
              onViewAll={() => {
                const photos = card.group.photos.filter((photo) => photo.photoId);
                const setting = (key: ScatterAxisKey) => {
                  const v = card.group[key];
                  return v != null ? SCATTER_AXES[key].format(v) : t("stats.charts.notAvailable");
                };
                const settings = `${setting(x)}, ${setting(y)}`;
                setCard(null);
                onViewAll(
                  photos,
                  t("stats.charts.setTitle", {
                    count: photos.length,
                    formatted: formatNumber(photos.length),
                    settings,
                  }),
                );
              }}
            />
          </div>
        )}
      </div>
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
  const { t } = useTranslation();
  return (
    <ChartCard
      title={t("stats.charts.gearUsage")}
      controls={
        <div className="flex items-center gap-2">
          <OptionSelect
            ariaLabel={t("stats.charts.gearType")}
            value={gearType}
            onChange={(v) => onGearTypeChange(v as GearType)}
            options={translateOptions(GEAR_TYPES, t)}
          />
          <OptionSelect
            ariaLabel={t("stats.charts.gearMetric")}
            value={metric}
            onChange={(v) => onMetricChange(v as GearMetric)}
            options={translateOptions(GEAR_METRICS, t)}
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
          <Tooltip content={<ValueTooltip name={metricLabel(GEAR_METRICS, metric, t)} />} cursor={HOVER_CURSOR} />
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
  onOpenBucket,
}: {
  data: { key: "count" | "species"; rows: Array<{ label: string; photoIds?: string[] }> };
  metric: ExifMetric;
  onMetricChange: (metric: ExifMetric) => void;
  /** A bar's photos: its position in `rows` (the bucket), label, photo count and a first sample. */
  onOpenBucket: (index: number, row: { label: string; count: number; photoIds: string[] }) => void;
}) {
  const { t } = useTranslation();
  return (
    <ChartCard
      title={t("stats.charts.exifDistribution")}
      controls={
        <OptionSelect
          ariaLabel={t("stats.charts.exifField")}
          value={metric}
          onChange={(v) => onMetricChange(v as ExifMetric)}
          options={translateOptions(EXIF_METRICS, t)}
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
          <Tooltip
            content={
              <ValueTooltip name={data.key === "species" ? t("stats.charts.species") : t("stats.charts.photos")} />
            }
            cursor={HOVER_CURSOR}
          />
          <Bar
            dataKey={data.key}
            fill={ACCENT}
            radius={[3, 3, 0, 0]}
            cursor={metric === "hitRate" ? undefined : "pointer"}
            onClick={(row: { payload?: { label: string; count?: number; photoIds?: string[] } }) => {
              const payload = row.payload;
              if (!payload?.photoIds?.length) return;
              onOpenBucket(data.rows.indexOf(payload), {
                label: payload.label,
                count: payload.count ?? payload.photoIds.length,
                photoIds: payload.photoIds,
              });
            }}
          />
        </BarChart>
      </ResponsiveContainer>
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
  // The hovered hour turns green like the busiest one, instead of a beige band over beige bars.
  const { t } = useTranslation();
  const [hoveredHour, setHoveredHour] = useState<number | null>(null);
  return (
    <ChartCard title={t("stats.charts.timeOfDay")}>
      <ResponsiveContainer width="100%" height={180}>
        <BarChart
          data={timeOfDay}
          onMouseMove={(state) =>
            setHoveredHour(state.activeTooltipIndex != null ? Number(state.activeTooltipIndex) : null)
          }
          onMouseLeave={() => setHoveredHour(null)}
        >
          <XAxis
            dataKey="hour"
            tickFormatter={(h: number) => (h % 3 === 0 ? timeOfDay[h].label : "")}
            tick={{ fontSize: 10, fill: MUTED }}
            axisLine={{ stroke: LINE }}
            tickLine={false}
            interval={0}
          />
          <YAxis tick={{ fontSize: 11, fill: MUTED }} axisLine={false} tickLine={false} allowDecimals={false} />
          <Tooltip
            content={
              <ValueTooltip name={t("stats.charts.photos")} formatLabel={(h) => timeOfDay[Number(h)]?.label ?? ""} />
            }
            cursor={false}
          />
          <Bar dataKey="count" radius={[3, 3, 0, 0]}>
            {timeOfDay.map((d, i) => (
              <Cell key={d.hour} fill={d.hour === busiestHour || i === hoveredHour ? ACCENT : LINE} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

// Above this many countries the card lists them; below, one line says it all.
const COUNTRY_LIST_MIN = 5;

export function CountriesCard({ countries }: { countries: StatsResponse["countriesPhotographed"] }) {
  const { t } = useTranslation();
  if (countries.countries.length === 0) {
    return (
      <Panel>
        <EmptyState compact title={t("stats.charts.noCountries")} />
      </Panel>
    );
  }
  if (countries.countries.length < COUNTRY_LIST_MIN) {
    return (
      <Panel as="section" className="text-callout text-ink">
        <span className="text-muted">{t("stats.charts.photographedIn", { count: countries.count })} </span>
        {countries.countries.map((c, i) => (
          <span key={c.id}>
            {i > 0 && ", "}
            <Link to={`/gallery?regionId=${c.id}`} className="text-link hover:underline">
              {c.name}
            </Link>{" "}
            <span className="text-footnote text-muted">{t("stats.charts.countryPhotos", { count: c.photoCount })}</span>
          </span>
        ))}
      </Panel>
    );
  }
  return (
    <ChartCard title={t("stats.charts.countriesTitle", { count: countries.count })}>
      <ul className="grid grid-cols-2 gap-1.5 text-callout sm:grid-cols-3">
        {countries.countries.map((c) => (
          <li key={c.id}>
            <Link
              to={`/gallery?regionId=${c.id}`}
              className="flex items-center justify-between gap-2 rounded-control text-ink hover:text-link"
            >
              <span className="truncate">{c.name}</span>
              <span className="text-footnote text-muted">
                {t("stats.charts.countryPhotos", { count: c.photoCount })}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </ChartCard>
  );
}
