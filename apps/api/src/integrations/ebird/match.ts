// Which photos belong to which checklist: taken during it (or near its edges), and close to where
// it was made when both have a place. Both clocks are local wall time with no zone; a camera left
// on another zone is corrected with `offsetMinutes` (photo time plus offset is the local time).
export interface MatchPhoto {
  id: string;
  /** Epoch ms of the camera's wall clock read as UTC (captures.taken_at). */
  takenAtMs: number;
  lat: number | null;
  lon: number | null;
  /** Scientific name of the photo's species. */
  species: string;
}

export interface MatchChecklist {
  subId: string;
  startedAtMs: number;
  hasTime: boolean;
  durationMin: number | null;
  lat: number | null;
  lon: number | null;
  species: string[];
}

export interface Match {
  captureId: string;
  subId: string;
  /** The photo's species is on the checklist: a stronger match. */
  onList: boolean;
}

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
// Photos taken a little before or after the count still belong to it.
const EDGE_MIN = 15;
// A checklist with no duration is a stationary or incidental count: an hour.
const DEFAULT_DURATION_MIN = 60;
const MAX_KM = 3;

function km(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

/** Every photo with the one checklist it fits best: on-list species first, then the nearest start. */
export function matchPhotos(photos: MatchPhoto[], checklists: MatchChecklist[], offsetMinutes = 0): Match[] {
  const sorted = [...checklists].sort((a, b) => a.startedAtMs - b.startedAtMs);
  const matches: Match[] = [];
  for (const photo of photos) {
    const t = photo.takenAtMs + offsetMinutes * MIN;
    let best: { c: MatchChecklist; onList: boolean; gap: number } | null = null;
    for (const c of sorted) {
      const start = c.hasTime ? c.startedAtMs - EDGE_MIN * MIN : c.startedAtMs;
      const end = c.hasTime
        ? c.startedAtMs + ((c.durationMin ?? DEFAULT_DURATION_MIN) + EDGE_MIN) * MIN
        : c.startedAtMs + DAY;
      if (t < start) break;
      if (t >= end) continue;
      if (
        photo.lat !== null &&
        photo.lon !== null &&
        c.lat !== null &&
        c.lon !== null &&
        km(photo.lat, photo.lon, c.lat, c.lon) > MAX_KM
      )
        continue;
      const onList = c.species.includes(photo.species);
      const gap = Math.abs(t - c.startedAtMs);
      if (!best || (onList && !best.onList) || (onList === best.onList && gap < best.gap)) best = { c, onList, gap };
    }
    if (best) matches.push({ captureId: photo.id, subId: best.c.subId, onList: best.onList });
  }
  return matches;
}
