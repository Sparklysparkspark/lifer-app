// One observation per sighting: Import tab candidates are grouped by species, then split where
// neighbors are more than SESSION_GAP_MS apart.
const SESSION_GAP_MS = 60 * 60 * 1000;

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
    const withTime = speciesCaptures
      .filter((c) => c.takenAt !== null)
      .sort((a, b) => new Date(a.takenAt!).getTime() - new Date(b.takenAt!).getTime());
    const withoutTime = speciesCaptures.filter((c) => c.takenAt === null);

    let current: ClusterableCapture[] = [];
    for (const capture of withTime) {
      const prev = current[current.length - 1];
      if (prev && new Date(capture.takenAt!).getTime() - new Date(prev.takenAt!).getTime() > SESSION_GAP_MS) {
        clusters.push(toCluster(speciesId, current));
        current = [];
      }
      current.push(capture);
    }
    if (current.length > 0) clusters.push(toCluster(speciesId, current));

    for (const capture of withoutTime) clusters.push(toCluster(speciesId, [capture]));
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
