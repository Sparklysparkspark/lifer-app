// One iNaturalist observation should represent one real sighting event of one species, not a
// flat "everything you've ever photographed of this bird" list — so candidates for the Import
// tab are clustered first by species, then by time-proximity within that species. Captures more
// than SESSION_GAP_MS apart from their neighbor start a new cluster; this mirrors how a person
// would naturally describe "I saw three of these together that morning" vs. two sightings of the
// same species weeks apart.
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

// Captures with no taken_at (rare — EXIF-less imports) each become their own single-photo
// cluster rather than being guessed into a group by unrelated data (e.g. upload order), since
// there's nothing timestamp-based to safely group them by.
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

  // Newest cluster first, per the Import tab's "most recent observations toward oldest" order —
  // sorted by each cluster's own latest capture, so a cluster's position reflects when the
  // sighting actually happened, not when this function happened to visit it.
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
