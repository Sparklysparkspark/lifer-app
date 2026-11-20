import { splitSessions } from "@lifer/shared";

/** A place chosen for some import photos. Staged only: it's applied after the import commits. */
export interface StagedPlace {
  /** spot: a saved place (a pin from the map is saved as one); region: just the region;
   *  session: another group's camera point, for photos taken there without GPS. */
  source: "spot" | "region" | "session";
  name: string;
  spotId: string | null;
  regionId: string | null;
  point: { lat: number; lon: number } | null;
}

export interface PlaceableRow {
  key: string;
  file: { lastModified: number };
  /** The camera's own clock (no zone), from inspect. */
  cameraTime?: string | null;
  gps?: { lat: number; lon: number; regionId: string | null; town?: string | null } | null;
  place?: StagedPlace | null;
}

/** A row's time as its wall clock read as UTC: the camera's clock, so GPS and non-GPS photos from one
 *  camera group together whatever the zone. Until inspect answers (and for videos), the file date
 *  on this computer's clock stands in. Format it with formatWallClock. */
export const rowTime = (r: PlaceableRow) =>
  (r.cameraTime ? Date.parse(`${r.cameraTime}Z`) : NaN) ||
  r.file.lastModified - new Date(r.file.lastModified).getTimezoneOffset() * 60_000;

const lastRegion = (session: readonly PlaceableRow[]) => {
  for (let i = session.length - 1; i >= 0; i--) if (session[i].gps?.regionId) return session[i].gps!.regionId;
  return null;
};

/** Sessions, oldest first: split after an hour's gap, at a new day, and where the camera GPS moves
 *  to another region. Photos without GPS never split a session. */
export function groupImportRows<R extends PlaceableRow>(rows: readonly R[]): R[][] {
  return splitSessions(rows, rowTime, (session, next) => {
    const day = (r: PlaceableRow) => new Date(rowTime(r)).toISOString().slice(0, 10);
    if (day(session.at(-1)!) !== day(next)) return true;
    const before = lastRegion(session);
    return !!before && !!next.gps?.regionId && next.gps.regionId !== before;
  });
}

export const samePlace = (a: StagedPlace | null | undefined, b: StagedPlace | null | undefined) =>
  (a?.source ?? null) === (b?.source ?? null) &&
  (a?.spotId ?? null) === (b?.spotId ?? null) &&
  (a?.regionId ?? null) === (b?.regionId ?? null) &&
  a?.point?.lat === b?.point?.lat &&
  a?.point?.lon === b?.point?.lon;

/** The place most of the group's photos have (null when most have none); the rest are overrides. */
export function groupPlace(rows: readonly PlaceableRow[]): StagedPlace | null {
  const counts: Array<{ place: StagedPlace | null; n: number }> = [];
  for (const r of rows) {
    const found = counts.find((c) => samePlace(c.place, r.place));
    if (found) found.n++;
    else counts.push({ place: r.place ?? null, n: 1 });
  }
  return counts.reduce((best, c) => (c.n > best.n ? c : best), { place: null as StagedPlace | null, n: 0 }).place;
}
