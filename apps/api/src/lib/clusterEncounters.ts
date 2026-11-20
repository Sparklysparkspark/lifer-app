// Groups captures into encounters: 400 photos of one owl in 20 minutes is one sighting. A gap over
// an hour starts a new encounter (splitSessions, the rule shared with iNaturalist and import).
import { splitSessions } from "@lifer/shared";

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
  const withTime = captures.filter((c) => c.takenAt !== null);
  const withoutTime = captures.filter((c) => c.takenAt === null);
  return [
    ...splitSessions(withTime, (c) => new Date(c.takenAt!).getTime()).map(toEncounter),
    ...withoutTime.map((c) => toEncounter([c])),
  ];
}

function toEncounter(captures: ClusterableCapture[]): Encounter {
  const times = captures.map((c) => c.takenAt).filter((t): t is string => t !== null);
  return {
    captureIds: captures.map((c) => c.id),
    earliestTakenAt: times.length ? times.reduce((a, b) => (a < b ? a : b)) : null,
    latestTakenAt: times.length ? times.reduce((a, b) => (a > b ? a : b)) : null,
  };
}
