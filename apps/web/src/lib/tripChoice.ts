import { isTripActive, type TripSummary } from "@lifer/shared";

/** The import screen's "No trip" choice. */
export const NO_TRIP = "none";

/** The import screen's starting trip choice for a batch: the one active trip; with several, the
 *  user's last pick, or null when there's none to fall back on, so they must choose; else no trip. */
export function defaultTripChoice(
  trips: Array<Pick<TripSummary, "id" | "startDate" | "endDate" | "activeOverride">>,
  today: string,
  lastPick: string | null,
): string | null {
  const active = trips.filter((trip) => isTripActive(trip, today));
  if (active.length === 1) return active[0].id;
  if (active.length === 0) return NO_TRIP;
  return lastPick === NO_TRIP || trips.some((trip) => trip.id === lastPick) ? lastPick : null;
}
