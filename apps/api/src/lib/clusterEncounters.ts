// A photographer with 400 photos from one 20-minute encounter with an owl hasn't had 400
// wildlife experiences — they've had one. This turns a flat capture list into real sighting
// "encounters": captures more than SESSION_GAP_MS apart start a new encounter, mirroring how a
// person would naturally describe "I saw it three times that morning" vs. two separate outings
// weeks apart. Same shape/threshold as the clustering already written for the (currently dark)
// iNaturalist-sync feature branch's own `clusterForImport` — ported here as a plain, DB-free
// function since that branch isn't merged and this needs to run for every species detail page,
// not just an iNat submission draft.
const SESSION_GAP_MS = 60 * 60 * 1000;

export interface ClusterableCapture {
  id: string;
  takenAt: string | null;
}

export interface Encounter {
  captureIds: string[];
  earliestTakenAt: string | null;
  latestTakenAt: string | null;
}

// Captures with no taken_at (rare — EXIF-less imports) each become their own single-photo
// encounter rather than being guessed into a group by unrelated data (e.g. upload order).
export function clusterIntoEncounters(captures: ClusterableCapture[]): Encounter[] {
  const withTime = captures
    .filter((c) => c.takenAt !== null)
    .sort((a, b) => new Date(a.takenAt!).getTime() - new Date(b.takenAt!).getTime());
  const withoutTime = captures.filter((c) => c.takenAt === null);

  const encounters: Encounter[] = [];
  let current: ClusterableCapture[] = [];
  for (const capture of withTime) {
    const prev = current[current.length - 1];
    if (prev && new Date(capture.takenAt!).getTime() - new Date(prev.takenAt!).getTime() > SESSION_GAP_MS) {
      encounters.push(toEncounter(current));
      current = [];
    }
    current.push(capture);
  }
  if (current.length > 0) encounters.push(toEncounter(current));
  for (const capture of withoutTime) encounters.push(toEncounter([capture]));

  return encounters;
}

function toEncounter(captures: ClusterableCapture[]): Encounter {
  const times = captures.map((c) => c.takenAt).filter((t): t is string => t !== null);
  return {
    captureIds: captures.map((c) => c.id),
    earliestTakenAt: times.length ? times.reduce((a, b) => (a < b ? a : b)) : null,
    latestTakenAt: times.length ? times.reduce((a, b) => (a > b ? a : b)) : null,
  };
}
