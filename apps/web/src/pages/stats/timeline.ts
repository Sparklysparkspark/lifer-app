import { formatMonthName } from "../../lib/format";
import { taxaColour, taxaGroup } from "../../lib/taxaColour";

// The timeline's five bands, coarser than the taxa colours: reptiles and amphibians share one, and
// fish join the rest of the sea. Also the stacking and legend order.
export const TIMELINE_GROUPS = ["birds", "mammals", "herps", "sea", "other"] as const;
export type TimelineGroup = (typeof TIMELINE_GROUPS)[number];

export const TIMELINE_GROUP_COLOURS: Record<TimelineGroup, string> = {
  birds: taxaColour("birds"),
  mammals: taxaColour("mammals"),
  herps: taxaColour("reptiles"),
  sea: taxaColour("fish"),
  other: taxaColour("other"),
};

export const TIMELINE_GROUP_LABEL_KEYS: Record<TimelineGroup, string> = {
  birds: "taxa.class.aves",
  mammals: "taxa.class.mammalia",
  herps: "stats.timeline.herps",
  sea: "stats.timeline.sea",
  other: "taxa.other",
};

const SEA_CLASSES = new Set([
  "corals",
  "jellies_and_anemones",
  "echinodermata",
  "nudibranchs",
  "marine_mollusks",
  "cephalopoda",
  "crustacea",
  "sponges_tunicates_other",
]);

export function timelineGroup(taxonClass: string | null): TimelineGroup {
  const group = taxaGroup(taxonClass);
  if (group === "reptiles" || group === "amphibians") return "herps";
  if (group === "fish" || SEA_CLASSES.has(taxonClass ?? "")) return "sea";
  return group === "birds" || group === "mammals" ? group : "other";
}

export type Granularity = "month" | "year";
export type TimelineBin = { key: string; total: number } & Record<TimelineGroup, number>;
/** Both ends included, as YYYY-MM. */
export type MonthRange = { from: string; to: string };

const emptyBin = (key: string): TimelineBin => ({ key, total: 0, birds: 0, mammals: 0, herps: 0, sea: 0, other: 0 });
const binKey = (month: string, granularity: Granularity) => (granularity === "year" ? month.slice(0, 4) : month);
const pad = (n: number, width: number) => String(n).padStart(width, "0");

// The fewest bins the axis shows, so a few months of photos draw narrow bars on a real time axis.
export const MIN_BINS: Record<Granularity, number> = { month: 12, year: 5 };

/** Every month (or year) from the first photo to the last, empty ones included, so the bars sit on an
 *  even time axis. Short spans reach back to MIN_BINS. */
export function timelineBins(
  rows: ReadonlyArray<{ month: string; taxonClass: string | null; count: number }>,
  granularity: Granularity,
): TimelineBin[] {
  if (rows.length === 0) return [];
  const byKey = new Map<string, TimelineBin>();
  for (const row of rows) {
    const key = binKey(row.month, granularity);
    const bin = byKey.get(key) ?? emptyBin(key);
    bin[timelineGroup(row.taxonClass)] += row.count;
    bin.total += row.count;
    byKey.set(key, bin);
  }
  const months = rows.map((r) => r.month).sort();
  const [lastYear, lastMonth] = months[months.length - 1].split("-").map(Number);
  let [year, month] = months[0].split("-").map(Number);
  if (granularity === "year") year = Math.min(year, lastYear - MIN_BINS.year + 1);
  else if ((lastYear - year) * 12 + lastMonth - month < MIN_BINS.month - 1) {
    const first = lastYear * 12 + lastMonth - MIN_BINS.month;
    [year, month] = [Math.floor(first / 12), (first % 12) + 1];
  }
  const keys: string[] = [];
  if (granularity === "year") {
    for (; year <= lastYear; year++) keys.push(pad(year, 4));
  } else {
    while (year < lastYear || (year === lastYear && month <= lastMonth)) {
      keys.push(`${pad(year, 4)}-${pad(month, 2)}`);
      month++;
      if (month > 12) {
        month = 1;
        year++;
      }
    }
  }
  return keys.map((key) => byKey.get(key) ?? emptyBin(key));
}

/** The first and last bin a range covers; the whole timeline without one. */
export function rangeIndices(
  bins: TimelineBin[],
  range: MonthRange | null,
  granularity: Granularity,
): [number, number] {
  const last = Math.max(bins.length - 1, 0);
  if (!range) return [0, last];
  const from = binKey(range.from, granularity);
  const to = binKey(range.to, granularity);
  const start = bins.findIndex((b) => b.key >= from);
  let end = last;
  while (end > 0 && bins[end].key > to) end--;
  const s = start < 0 ? last : start;
  return [s, Math.max(s, end)];
}

/** The months a span of bins covers, or null when it is the whole timeline. */
export function rangeOf(bins: TimelineBin[], start: number, end: number, granularity: Granularity): MonthRange | null {
  if (bins.length === 0 || (start <= 0 && end >= bins.length - 1)) return null;
  const first = bins[Math.max(start, 0)].key;
  const last = bins[Math.min(end, bins.length - 1)].key;
  return granularity === "year" ? { from: `${first}-01`, to: `${last}-12` } : { from: first, to: last };
}

const RANGE_PARAM = /^(\d{4}-(?:0[1-9]|1[0-2]))\.\.(\d{4}-(?:0[1-9]|1[0-2]))$/;

/** The ?dates= value, "2019-03..2021-08". Anything else reads as no range. */
export function parseRangeParam(value: string): MonthRange | null {
  const match = RANGE_PARAM.exec(value);
  if (!match) return null;
  const [from, to] = [match[1], match[2]].sort();
  return { from, to };
}

export const rangeParam = (range: MonthRange | null) => (range ? `${range.from}..${range.to}` : "");

/** "Mar 2019" for a month key, the year for a year key. */
export function binLabel(key: string, long = false): string {
  const [year, month] = key.split("-").map(Number);
  return month ? `${formatMonthName(month - 1, long ? "long" : "short")} ${year}` : String(year);
}

// Roughly the width a label needs, so labels never overlap: "Sep" for a month, "2019" for a year.
const MONTH_LABEL_PX = 36;
const YEAR_LABEL_PX = 44;

export type AxisTick = { key: string; label: string; year?: string };

/** The labelled bins for an axis `width` pixels wide: every month, quarter, half year, year or more,
 *  whichever is the densest that fits. Month labels carry the year on their first tick and each January. */
export function axisTicks(keys: ReadonlyArray<string>, width: number): AxisTick[] {
  const months = keys[0]?.length === 7;
  const steps = months ? [1, 2, 3, 6, 12, 24, 60, 120, 240] : [1, 2, 5, 10, 20, 50];
  const fits = (step: number) => (keys.length / step) * (months && step < 12 ? MONTH_LABEL_PX : YEAR_LABEL_PX) <= width;
  const step = steps.find(fits) ?? steps[steps.length - 1];
  const ticks: AxisTick[] = [];
  for (const key of keys) {
    const [year, month] = key.split("-").map(Number);
    if (!months || step >= 12) {
      if ((month ?? 1) === 1 && year % (months ? step / 12 : step) === 0) ticks.push({ key, label: String(year) });
    } else if ((month - 1) % step === 0) {
      const label = formatMonthName(month - 1, "short");
      ticks.push(ticks.length === 0 || month === 1 ? { key, label, year: String(year) } : { key, label });
    }
  }
  return ticks;
}

/** The Gallery's date filter for a range: first to last day, both included. */
export function galleryDates(range: MonthRange): { dateFrom: string; dateTo: string } {
  const [year, month] = range.to.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { dateFrom: `${range.from}-01`, dateTo: `${range.to}-${pad(lastDay, 2)}` };
}
