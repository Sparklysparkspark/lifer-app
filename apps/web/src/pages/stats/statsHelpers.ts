import type { PhotoFilter, PortfolioSpecies, ScatterPoint, SpeciesPortfolioResponse, StatsResponse } from "./types";

// Axes the scatter plot's X/Y dropdowns can pick between.
export const SCATTER_AXES = {
  focalLength: { label: "Focal length", format: (v: number) => `${v}mm` },
  aperture: { label: "Aperture", format: (v: number) => `f/${v}` },
  iso: { label: "ISO", format: (v: number) => `${v}` },
  shutterSeconds: { label: "Shutter speed", format: (v: number) => (v >= 1 ? `${v}s` : `1/${Math.round(1 / v)}`) },
} as const;
export type ScatterAxisKey = keyof typeof SCATTER_AXES;

export const GEAR_TYPES = [
  { value: "cameras", label: "Cameras" },
  { value: "lenses", label: "Lenses" },
  { value: "combos", label: "Camera + lens" },
] as const;
export type GearType = (typeof GEAR_TYPES)[number]["value"];

export const GEAR_METRICS = [
  { value: "photoCount", label: "Photos" },
  { value: "speciesCount", label: "Species" },
] as const;
export type GearMetric = (typeof GEAR_METRICS)[number]["value"];

export const EXIF_METRICS = [
  { value: "focalLength", label: "Photos by focal length" },
  { value: "iso", label: "ISO" },
  { value: "aperture", label: "Aperture" },
  { value: "shutter", label: "Shutter speed" },
  { value: "hitRate", label: "Species by focal length" },
] as const;
export type ExifMetric = (typeof EXIF_METRICS)[number]["value"];

export const MONTHLY_METRICS = [
  { value: "newLifers", label: "New lifers" },
  { value: "keepers", label: "Total keepers" },
] as const;
export type MonthlyMetric = (typeof MONTHLY_METRICS)[number]["value"];

// Camera-dial speeds out to 1/128000 so fast electronic shutters still get labeled ticks.
const NICE_SHUTTER_DENOMINATORS = [30, 60, 125, 250, 500, 1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000];

/** Shutter-speed axis ticks (in seconds) spanning only what the data covers. */
export function shutterTicks(values: number[]): number[] {
  if (values.length === 0) return NICE_SHUTTER_DENOMINATORS.slice(0, 9).map((d) => 1 / d);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const covering = NICE_SHUTTER_DENOMINATORS.filter((d) => 1 / d >= min && 1 / d <= max);
  return (covering.length >= 2 ? covering : NICE_SHUTTER_DENOMINATORS).map((d) => 1 / d);
}

/** The points that have a value on both chosen axes. */
export function scatterPointsFor(points: ScatterPoint[], x: ScatterAxisKey, y: ScatterAxisKey): ScatterPoint[] {
  return points.filter((p) => p[x] != null && p[y] != null);
}

/** The headline cards: the most used camera, and the busiest focal length, hour and month. */
export function headlineStats(stats: StatsResponse) {
  return {
    topCamera: stats.gearUsage.cameras[0],
    topFocalLength: [...stats.exifDistributions.focalLength].sort((a, b) => b.count - a.count)[0],
    busiestHour: [...stats.timeOfDay].sort((a, b) => b.count - a.count)[0],
    bestMonth: [...stats.perMonth].sort((a, b) => b.newLifers - a.newLifers)[0],
  };
}

export function percentOfKeepers(count: number, totalKeepers: number): number {
  return Math.round((count / totalKeepers) * 100);
}

/** One label per bar, whichever kind of gear is chosen. */
export function gearRows(
  stats: StatsResponse,
  gearType: GearType,
): Array<{ label: string; photoCount: number; speciesCount: number }> {
  if (gearType === "combos")
    return stats.gearUsage.combos.map((c) => ({
      label: `${c.camera} + ${c.lens}`,
      photoCount: c.photoCount,
      speciesCount: c.speciesCount,
    }));
  return stats.gearUsage[gearType].map((g) => ({
    label: g.model,
    photoCount: g.photoCount,
    speciesCount: g.speciesCount,
  }));
}

/** The EXIF chart's bars and which field holds their height. Only photo counts list photos. */
export function exifRows(
  stats: StatsResponse,
  metric: ExifMetric,
): {
  key: "count" | "species";
  rows: Array<{ label: string; count?: number; species?: number; photoIds?: string[] }>;
} {
  if (metric === "hitRate") return { key: "species", rows: stats.hitRateByFocalLength };
  return { key: "count", rows: stats.exifDistributions[metric] };
}

/** Every year with a photo in the portfolio, newest first. */
export function yearsPhotographed(portfolio: SpeciesPortfolioResponse | null): number[] {
  if (!portfolio) return [];
  const years = new Set<number>();
  for (const s of portfolio.species) {
    if (s.earliestTakenAt) years.add(new Date(s.earliestTakenAt).getFullYear());
    if (s.latestTakenAt) years.add(new Date(s.latestTakenAt).getFullYear());
  }
  return [...years].sort((a, b) => b - a);
}

/** The collection-intelligence lists drawn from the portfolio. */
export function portfolioHighlights(portfolio: SpeciesPortfolioResponse | null): {
  mostPhotographed: PortfolioSpecies[];
  oneAndDone: PortfolioSpecies[];
  needsBetterPhoto: PortfolioSpecies[];
} {
  if (!portfolio) return { mostPhotographed: [], oneAndDone: [], needsBetterPhoto: [] };
  return {
    mostPhotographed: [...portfolio.species].sort((a, b) => b.totalPhotos - a.totalPhotos).slice(0, 10),
    oneAndDone: portfolio.species.filter((s) => s.totalPhotos === 1),
    // Only species whose single photo you rated 1 star yourself.
    needsBetterPhoto: portfolio.species.filter((s) => s.totalPhotos === 1 && s.bestRating === 1),
  };
}

export function statsCsvFilename(filter: PhotoFilter, now: Date): string {
  return `lifer-stats-${filter}-${now.toISOString().slice(0, 10)}.csv`;
}
