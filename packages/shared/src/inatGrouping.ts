// One observation per sighting: Import tab candidates are grouped by species, then split where
// neighbors are more than an hour apart (splitSessions).
import { splitSessions } from "./sessions.js";

export interface ClusterableCapture {
  id: string;
  speciesId: string;
  takenAt: string | null;
}

export interface ObservationCluster {
  speciesId: string;
  captureIds: string[];
  earliestTakenAt: string | null;
  latestTakenAt: string | null;
}

// Captures with no taken_at each become their own single-photo cluster.
export function clusterForImport(captures: ClusterableCapture[]): ObservationCluster[] {
  const bySpecies = new Map<string, ClusterableCapture[]>();
  for (const capture of captures) {
    const list = bySpecies.get(capture.speciesId);
    if (list) list.push(capture);
    else bySpecies.set(capture.speciesId, [capture]);
  }

  const clusters: ObservationCluster[] = [];
  for (const [speciesId, speciesCaptures] of bySpecies) {
    const withTime = speciesCaptures.filter((c) => c.takenAt !== null);
    for (const session of splitSessions(withTime, (c) => new Date(c.takenAt!).getTime()))
      clusters.push(toCluster(speciesId, session));
    for (const capture of speciesCaptures.filter((c) => c.takenAt === null))
      clusters.push(toCluster(speciesId, [capture]));
  }

  // Newest cluster first, by each cluster's latest capture.
  return clusters.sort((a, b) => {
    const at = a.latestTakenAt ? new Date(a.latestTakenAt).getTime() : 0;
    const bt = b.latestTakenAt ? new Date(b.latestTakenAt).getTime() : 0;
    return bt - at;
  });
}

function toCluster(speciesId: string, captures: ClusterableCapture[]): ObservationCluster {
  const times = captures.map((c) => c.takenAt).filter((t): t is string => t !== null);
  return {
    speciesId,
    captureIds: captures.map((c) => c.id),
    earliestTakenAt: times.length ? times.reduce((a, b) => (a < b ? a : b)) : null,
    latestTakenAt: times.length ? times.reduce((a, b) => (a > b ? a : b)) : null,
  };
}
