// One outing's photos: sorted by time, a new session starts after a gap over an hour, or wherever
// `splits` says (a new day, a new region). The rule behind sightings, iNaturalist observations,
// the map's Needs placing groups and the import screen's groups.
export const SESSION_GAP_MS = 60 * 60 * 1000;

export function splitSessions<T>(
  items: readonly T[],
  time: (item: T) => number,
  splits?: (session: readonly T[], next: T) => boolean,
): T[][] {
  const sessions: T[][] = [];
  for (const item of [...items].sort((a, b) => time(a) - time(b))) {
    const current = sessions.at(-1);
    if (current && time(item) - time(current.at(-1)!) <= SESSION_GAP_MS && !splits?.(current, item)) current.push(item);
    else sessions.push([item]);
  }
  return sessions;
}
