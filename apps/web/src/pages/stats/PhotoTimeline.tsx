import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { Bar, BarChart, Brush, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import Button from "../../components/Button";
import SegmentedControl from "../../components/SegmentedControl";
import { usePersistedState } from "../../hooks/usePersistedState";
import { backStateFor } from "../../lib/backLabel";
import { buttonClasses } from "../../lib/buttonClasses";
import { formatNumber } from "../../lib/format";
import { ChartCard } from "./StatsUi";
import {
  binLabel,
  galleryDates,
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
const LINE = "var(--color-line)";
// Long enough that a drag or a run of arrow presses reloads the page's stats once.
const COMMIT_DELAY_MS = 350;
// Above this many bars a segment is a few pixels wide, so the gaps between them would hide the colour.
const MAX_OUTLINED_BARS = 80;

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
    <div className="rounded-panel border border-line bg-surface px-2 py-1.5 text-footnote shadow-md">
      <p className="font-medium text-ink">{binLabel(bin.key, true)}</p>
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

/** Photos per month (or year), stacked by animal group, with a brush that picks the dates the rest
 *  of the page counts. */
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
  // The brush moves at once; the page's stats follow once it settles.
  const [draft, setDraft] = useState(committed);
  const [shown, setShown] = useState(committed);
  if (shown !== committed) {
    setShown(committed);
    setDraft(committed);
  }
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const labels: Record<string, string> = {
    ...Object.fromEntries(TIMELINE_GROUPS.map((g) => [g, t(TIMELINE_GROUP_LABEL_KEYS[g])])),
    total: t("stats.timeline.total"),
  };
  const [start, end] = draft;
  const visible = bins.slice(start, end + 1);
  const groupTotals = TIMELINE_GROUPS.map((g) => [g, visible.reduce((sum, b) => sum + b[g], 0)] as const).filter(
    ([, count]) => count > 0,
  );
  // Until the brush moves, the picked months name themselves, even ones outside the photos.
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
    : null;
  // Year labels under months; once the brush narrows to two years or less, every month gets one.
  const yearTicks =
    granularity === "month" && visible.length > 24
      ? visible.filter((b, i) => i === 0 || b.key.endsWith("-01")).map((b) => b.key)
      : undefined;

  function moveBrush(next: { startIndex?: number; endIndex?: number }) {
    const s = next.startIndex ?? start;
    const e = next.endIndex ?? end;
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
          <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-footnote text-muted">
            {groupTotals.map(([g, count]) => (
              <li key={g} className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: TIMELINE_GROUP_COLOURS[g] }}
                />
                {labels[g]} <span className="tabular-nums text-ink">{formatNumber(count)}</span>
              </li>
            ))}
          </ul>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={bins} barCategoryGap={visible.length > MAX_OUTLINED_BARS ? 0 : "15%"}>
              <XAxis
                dataKey="key"
                ticks={yearTicks}
                tickFormatter={(key: string) => (yearTicks ? key.slice(0, 4) : binLabel(key))}
                tick={{ fontSize: 11, fill: MUTED }}
                tickLine={false}
                axisLine={{ stroke: LINE }}
                minTickGap={24}
              />
              <YAxis
                tick={{ fontSize: 11, fill: MUTED }}
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
                width={48}
                tickFormatter={(v: number) => formatNumber(v)}
              />
              <Tooltip content={<TimelineTooltip labels={labels} />} cursor={{ fill: "var(--color-surface-muted)" }} />
              {TIMELINE_GROUPS.map((g) => (
                <Bar
                  key={g}
                  dataKey={g}
                  stackId={STACK}
                  fill={TIMELINE_GROUP_COLOURS[g]}
                  stroke={visible.length <= MAX_OUTLINED_BARS ? "var(--color-surface)" : undefined}
                  strokeWidth={1}
                  isAnimationActive={false}
                />
              ))}
              <Brush
                // Remounts when the bin count changes: recharts keeps the old scale for a render, so a new end index plots at NaN.
                key={bins.length}
                dataKey="key"
                height={32}
                startIndex={start}
                endIndex={end}
                onChange={moveBrush}
                tickFormatter={(key: string) => binLabel(key)}
                stroke={MUTED}
                fill="var(--color-surface-muted)"
                travellerWidth={10}
                ariaLabel={t("stats.timeline.brushLabel", { range: rangeText ?? t("stats.timeline.allDates") })}
              >
                <BarChart data={bins}>
                  <Bar dataKey="total" fill={MUTED} isAnimationActive={false} />
                </BarChart>
              </Brush>
            </BarChart>
          </ResponsiveContainer>
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
                {bins
                  .filter((b) => b.total > 0)
                  .map((b) => (
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
