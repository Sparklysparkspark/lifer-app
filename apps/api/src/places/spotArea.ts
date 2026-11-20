// Photos inside a saved place by their point (within its radius), whenever they were placed, as
// SQL over captures c. $1 must be the user's id. Pure, so the query text is unit-tested.

/** Metres from the photo c to a place row `s` (lat, lon as float8). */
export const metresTo = (s: string) => `6371000 * 2 * asin(least(1, sqrt(
    power(sin(radians(c.lat::float8 - ${s}.lat) / 2), 2) +
    cos(radians(${s}.lat)) * cos(radians(c.lat::float8)) *
    power(sin(radians(c.lon::float8 - ${s}.lon) / 2), 2))))`;

/** The user's places, as `sp`, for spotOfPhoto. */
export const SPOTS_CTE = `sp AS MATERIALIZED (
    SELECT id, name, lat::float8 AS lat, lon::float8 AS lon, radius_m, radius_m / 111320.0 AS dlat
    FROM saved_spots WHERE user_id = $1)`;

// shortcut: checks every place for every photo (the latitude band prunes most); fine for hundreds
// of places, index the places spatially if libraries reach thousands.
/** The nearest place whose radius holds the photo c, or NULL. Needs SPOTS_CTE. */
export const SPOT_OF_PHOTO = `(SELECT sp.id FROM sp
    WHERE c.lat IS NOT NULL AND c.lon IS NOT NULL AND c.lat::float8 BETWEEN sp.lat - sp.dlat AND sp.lat + sp.dlat
      AND ${metresTo("sp")} <= sp.radius_m
    ORDER BY ${metresTo("sp")} LIMIT 1)`;

/** Gallery filter: only photos whose point lies inside this place. */
export function insideSpotSql(spotId: string | null | undefined, param: (v: unknown) => string): string {
  if (!spotId) return "";
  return `AND c.lat IS NOT NULL AND c.lon IS NOT NULL AND EXISTS (
    SELECT 1 FROM (SELECT lat::float8 AS lat, lon::float8 AS lon, radius_m FROM saved_spots
                   WHERE id = ${param(spotId)}::uuid AND user_id = c.user_id) one
    WHERE ${metresTo("one")} <= one.radius_m)`;
}
