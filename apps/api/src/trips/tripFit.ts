// Which trip a day's photos on the Import page clearly belong to, so the page can ask. Only asks:
// the user decides. A trip's span is its own dates widened to its photos, plus a day either side
// (photos carry no time zone). With GPS, the photos must also be where the trip was.

export const MARGIN_MS = 24 * 3600 * 1000;
/** Photos this close to one of the trip's own photos count as the same place. */
export const NEAR_KM = 100;

export interface Point {
  lat: number;
  lon: number;
}

export interface ImportGroup {
  times: Date[];
  points: Point[];
  /** The regions the photos' GPS falls in, with every region containing them. */
  regionIds: string[];
}

export interface TripFacts {
  id: string;
  startDate: string | null;
  endDate: string | null;
  firstTaken: Date | null;
  lastTaken: Date | null;
  /** The trip's own region and its photos' regions. */
  regionIds: string[];
  points: Point[];
}

const day = (d: string) => new Date(`${d}T00:00:00Z`).getTime();

/** The trip's span without the margin, or null when it has neither dates nor photos. An open trip
 *  (no end date) runs until now. */
export function tripSpan(t: TripFacts, now: Date): { from: number; to: number } | null {
  const starts = [t.startDate ? day(t.startDate) : null, t.firstTaken?.getTime() ?? null].filter(
    (n): n is number => n != null,
  );
  const ends = [
    t.endDate ? day(t.endDate) + MARGIN_MS : null,
    t.lastTaken?.getTime() ?? null,
    t.startDate && !t.endDate ? now.getTime() : null,
  ].filter((n): n is number => n != null);
  if (starts.length === 0 || ends.length === 0) return null;
  return { from: Math.min(...starts), to: Math.max(...ends) };
}

export function distanceKm(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function fitsTrip(g: ImportGroup, t: TripFacts, now: Date): boolean {
  const span = tripSpan(t, now);
  if (!span || g.times.length === 0) return false;
  if (!g.times.every((d) => d.getTime() >= span.from - MARGIN_MS && d.getTime() <= span.to + MARGIN_MS)) return false;
  // A trip with no place known can only be judged by date.
  if (g.points.length === 0 || (t.regionIds.length === 0 && t.points.length === 0)) return true;
  if (g.regionIds.some((r) => t.regionIds.includes(r))) return true;
  return g.points.some((p) => t.points.some((q) => distanceKm(p, q) <= NEAR_KM));
}

/** The trips to offer: with GPS one or two that fit, by date alone only a single one. Anything
 *  less clear offers nothing. */
export function tripsToOffer(g: ImportGroup, trips: TripFacts[], now: Date): TripFacts[] {
  const fit = trips.filter((t) => fitsTrip(g, t, now));
  const most = g.points.length > 0 ? 2 : 1;
  return fit.length <= most ? fit : [];
}
