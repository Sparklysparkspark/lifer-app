import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import Button from "../../components/Button";
import SegmentedControl from "../../components/SegmentedControl";
import { usePersistedState } from "../../hooks/usePersistedState";
import { backStateFor } from "../../lib/backLabel";
import { buttonClasses } from "../../lib/buttonClasses";
import { formatNumber } from "../../lib/format";
import { ChartCard } from "./StatsUi";
import TimelineRange from "./TimelineRange";
import {
  axisTicks,
  binLabel,
  galleryDates,
  MIN_BINS,
  rangeIndices,
  rangeOf,
  timelineBins,
  TIMELINE_GROUP_COLOURS,
  TIMELINE_GROUP_LABEL_KEYS,
  TIMELINE_GROUPS,
  type Granularity,
  type MonthRange,
  type TimelineBin,
} from "./timeline";

const MUTED = "var(--color-muted)";
const STACK = "photos";
const Y_AXIS_WIDTH = 44;
// Long enough that a drag or a run of arrow presses reloads the page's stats once.
const COMMIT_DELAY_MS = 350;
const MAX_BAR_PX = 24;
const RADIUS_PX = 4;
const COMPACT: Intl.NumberFormatOptions = { notation: "compact" };
// Past this many bars a bar is a few pixels wide, and the gaps between its slices would read as stripes.
const MAX_GAPPED_BARS = 80;

function TimelineTooltip({
  active,
  payload,
  labels,
}: {
  active?: boolean;
  payload?: Array<{ payload?: TimelineBin }>;
  labels: Record<string, string>;
}) {
  const bin = payload?.[0]?.payload;
  if (!active || !bin) return null;
  return (
    <div className="rounded-panel border border-line bg-surface px-2.5 py-2 text-footnote shadow-md">
      <p className="mb-0.5 font-medium text-ink">{binLabel(bin.key, true)}</p>
      {TIMELINE_GROUPS.filter((g) => bin[g] > 0).map((g) => (
        <p key={g} className="flex items-center gap-1.5 text-muted">
          <span aria-hidden className="h-2 w-2 rounded-full" style={{ backgroundColor: TIMELINE_GROUP_COLOURS[g] }} />
          {labels[g]}: <span className="tabular-nums text-ink">{formatNumber(bin[g])}</span>
        </p>
      ))}
      <p className="text-muted">
        {labels.total}: <span className="tabular-nums text-ink">{formatNumber(bin.total)}</span>
      </p>
    </div>
  );
}

type SegmentProps = { x?: number; y?: number; width?: number; height?: number; payload?: TimelineBin };

/** One group's slice of a stacked bar: the top slice gets rounded corners, the others a 1px gap above,
 *  and an empty bin a hairline on the baseline. Bins outside the picked dates fade. */
function segment(group: (typeof TIMELINE_GROUPS)[number], picked: (key: string) => boolean, gapPx: number) {
  const top = (bin: TimelineBin) => [...TIMELINE_GROUPS].reverse().find((g) => bin[g] > 0);
  return function Segment({ x = 0, y = 0, width = 0, height = 0, payload }: SegmentProps) {
    if (!payload) return null;
    const opacity = picked(payload.key) ? 1 : 0.3;
    if (payload.total === 0)
      return group === TIMELINE_GROUPS[0] ? (
        <rect x={x} y={y - 1} width={width} height={1} fill="var(--color-line)" opacity={opacity} />
      ) : null;
    if (payload[group] === 0 || height <= 0) return null;
    const fill = TIMELINE_GROUP_COLOURS[group];
    if (top(payload) !== group) {
      const gap = height > 2 ? gapPx : 0;
      return <rect x={x} y={y + gap} width={width} height={height - gap} fill={fill} opacity={opacity} />;
    }
    const r = Math.min(RADIUS_PX, width / 3, height);
    const d = `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
    return <path d={d} fill={fill} opacity={opacity} />;
  };
}

/** Photos per month (or year), stacked by animal group, with a strip under it that picks the dates
 *  the rest of the page counts. */
export default function PhotoTimeline({
  months,
  undated,
  range,
  onRangeChange,
}: {
  months: ReadonlyArray<{ month: string; taxonClass: string | null; count: number }>;
  undated: number;
  range: MonthRange | null;
  onRangeChange: (range: MonthRange | null) => void;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const [granularity, setGranularity] = usePersistedState<Granularity>("stats.timelineGranularity", "month");
  const bins = useMemo(() => timelineBins(months, granularity), [months, granularity]);
  const committed = useMemo(() => rangeIndices(bins, range, granularity), [bins, range, granularity]);
  // The strip moves at once; the page's stats follow once it settles.
  const [draft, setDraft] = useState(committed);
  const [shown, setShown] = useState(committed);
  if (shown !== committed) {
    setShown(committed);
    setDraft(committed);
  }
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const [chartWidth, setChartWidth] = useState(800);

  const labels: Record<string, string> = {
    ...Object.fromEntries(TIMELINE_GROUPS.map((g) => [g, t(TIMELINE_GROUP_LABEL_KEYS[g])])),
    total: t("stats.timeline.total"),
  };
  const [start, end] = draft;
  // The chart shows the picked dates, centred in a year (or five) of context that stays faint.
  const minView = MIN_BINS[granularity];
  const pad = Math.max(0, minView - (end - start + 1));
  const viewStart = pad ? Math.min(Math.max(0, start - Math.ceil(pad / 2)), bins.length - minView) : start;
  const viewEnd = pad ? viewStart + minView - 1 : end;
  const view = bins.slice(viewStart, viewEnd + 1);
  const pickedKeys = new Set(bins.slice(start, end + 1).map((b) => b.key));
  const picked = (key: string) => pickedKeys.has(key);
  const visible = bins.slice(start, end + 1);
  const groupTotals = TIMELINE_GROUPS.map((g) => [g, visible.reduce((sum, b) => sum + b[g], 0)] as const).filter(
    ([, count]) => count > 0,
  );
  const withPhotos = bins.filter((b) => b.total > 0);
  const compactAxis = Math.max(...view.map((b) => b.total)) >= 10_000;
  // Until the strip moves, the picked months name themselves, even ones outside the photos.
  const shownRange = draft === committed ? range : rangeOf(bins, start, end, granularity);
  const [fromKey, toKey] = shownRange
    ? granularity === "year" && draft !== committed
      ? [shownRange.from.slice(0, 4), shownRange.to.slice(0, 4)]
      : [shownRange.from, shownRange.to]
    : ["", ""];
  const rangeText = shownRange
    ? fromKey === toKey
      ? binLabel(fromKey)
      : t("stats.timeline.range", { from: binLabel(fromKey), to: binLabel(toKey) })
    : withPhotos.length === 1
      ? t("stats.timeline.onlyPeriod", { period: binLabel(withPhotos[0].key) })
      : null;
  const ticks = axisTicks(
    view.map((b) => b.key),
    chartWidth - Y_AXIS_WIDTH,
  );
  const tickByKey = new Map(ticks.map((tick) => [tick.key, tick]));

  function moveRange(s: number, e: number) {
    setDraft([s, e]);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onRangeChange(rangeOf(bins, s, e, granularity)), COMMIT_DELAY_MS);
  }

  const mapDates = range && galleryDates(range);

  return (
    <ChartCard
      title={t("stats.timeline.title")}
      controls={
        bins.length > 0 && (
          <SegmentedControl
            label={t("stats.timeline.groupBy")}
            value={granularity}
            onChange={setGranularity}
            options={[
              { value: "month", label: t("stats.timeline.months") },
              { value: "year", label: t("stats.timeline.years") },
            ]}
          />
        )
      }
    >
      {bins.length > 0 && (
        <>
          <ul className="-mt-1 mb-4 flex flex-wrap gap-1.5 text-footnote text-muted">
            {groupTotals.map(([g, count]) => (
              <li key={g} className="flex items-center gap-1.5 rounded-full bg-surface-muted px-2 py-0.5">
                <span
                  aria-hidden
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: TIMELINE_GROUP_COLOURS[g] }}
                />
                {labels[g]} <span className="tabular-nums text-ink">{formatNumber(count)}</span>
              </li>
            ))}
          </ul>
          <ResponsiveContainer width="100%" height={240} onResize={(w) => setChartWidth(w)}>
            <BarChart
              data={view}
              barCategoryGap={view.length > MAX_GAPPED_BARS ? "10%" : "22%"}
              maxBarSize={MAX_BAR_PX}
              margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
            >
              <CartesianGrid vertical={false} stroke="var(--color-line)" strokeOpacity={0.7} />
              <XAxis
                dataKey="key"
                ticks={ticks.map((tick) => tick.key)}
                interval={0}
                tickLine={false}
                axisLine={false}
                height={view.length > 0 && ticks.some((tick) => tick.year) ? 34 : 22}
                tick={({
                  x,
                  y,
                  payload,
                }: {
                  x?: number | string;
                  y?: number | string;
                  payload?: { value?: unknown };
                }) => {
                  const tick = tickByKey.get(String(payload?.value));
                  x = Number(x);
                  y = Number(y);
                  return tick ? (
                    <text x={x} y={y + 4} textAnchor="middle" fontSize={11} fill={MUTED} className="tabular-nums">
                      <tspan x={x} dy="0.71em">
                        {tick.label}
                      </tspan>
                      {tick.year && (
                        <tspan x={x} dy="1.25em" fontWeight={500}>
                          {tick.year}
                        </tspan>
                      )}
                    </text>
                  ) : (
                    <g />
                  );
                }}
              />
              <YAxis
                tick={{ fontSize: 11, fill: MUTED, className: "tabular-nums" }}
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
                tickCount={5}
                width={Y_AXIS_WIDTH}
                // One style per axis: all in full, or all compact once the top reaches 10,000.
                tickFormatter={(v: number) => formatNumber(v, compactAxis ? COMPACT : undefined)}
              />
              <Tooltip
                content={<TimelineTooltip labels={labels} />}
                cursor={{ fill: "var(--color-surface-muted)", radius: RADIUS_PX }}
              />
              {TIMELINE_GROUPS.map((g) => (
                <Bar
                  key={g}
                  dataKey={g}
                  stackId={STACK}
                  isAnimationActive={false}
                  shape={segment(g, picked, view.length > MAX_GAPPED_BARS ? 0 : 1)}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
          <div className="mt-2">
            <TimelineRange bins={bins} start={start} end={end} onChange={moveRange} />
          </div>
          {/* A table ignores sr-only's 1px width, so a wrapper hides it. */}
          <div className="sr-only">
            <table>
              <caption>{t("stats.timeline.title")}</caption>
              <thead>
                <tr>
                  <th scope="col">{granularity === "year" ? t("stats.timeline.years") : t("stats.timeline.months")}</th>
                  {TIMELINE_GROUPS.map((g) => (
                    <th key={g} scope="col">
                      {labels[g]}
                    </th>
                  ))}
                  <th scope="col">{labels.total}</th>
                </tr>
              </thead>
              <tbody>
                {withPhotos.map((b) => (
                  <tr key={b.key}>
                    <th scope="row">{binLabel(b.key, true)}</th>
                    {TIMELINE_GROUPS.map((g) => (
                      <td key={g}>{formatNumber(b[g])}</td>
                    ))}
                    <td>{formatNumber(b.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-footnote text-muted">
        {rangeText && (
          <span aria-live="polite" className="font-medium text-ink">
            {rangeText}
          </span>
        )}
        {range && (
          <Button variant="secondary" size="sm" onClick={() => onRangeChange(null)}>
            {t("stats.timeline.allDates")}
          </Button>
        )}
        {mapDates && (
          <Link
            to={`/gallery?view=map&dateFrom=${mapDates.dateFrom}&dateTo=${mapDates.dateTo}`}
            state={backStateFor(location, t)}
            className={buttonClasses("secondary", "sm")}
          >
            {t("stats.timeline.showOnMap")}
          </Link>
        )}
        {undated > 0 && (
          <span>{t("stats.timeline.undated", { count: undated, formatted: formatNumber(undated) })}</span>
        )}
      </div>
    </ChartCard>
  );
}
