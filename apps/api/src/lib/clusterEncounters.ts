// Groups captures into encounters: 400 photos of one owl in 20 minutes is one sighting. A gap over
// SESSION_GAP_MS starts a new encounter (the same rule as inaturalist/grouping.ts).
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

// Captures with no taken_at (rare, EXIF-less imports) each become their own single-photo
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
