// What a send to iNaturalist says about where the photos were taken. A photo's place is found by
// its label and by its point falling inside a place's radius, and the strictest privacy wins, so
// renaming a place (which leaves old labels behind) can never open its photos up.
import { pool } from "@lifer/core/db.js";

export type Geoprivacy = "open" | "obscured" | "private";
const RANK: Record<Geoprivacy, number> = { open: 0, obscured: 1, private: 2 };

export interface PlaceForPrivacy {
  name: string;
  lat: number;
  lon: number;
  radius_m: number;
  geoprivacy: Geoprivacy;
  locality: string | null;
}
export interface PhotoForPrivacy {
  id: string;
  lat: number | null;
  lon: number | null;
  location_label: string | null;
  location_source: string | null;
  location_accuracy_m: number | null;
}

/** Metres between two points (haversine). */
export function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const insidePlace = (place: PlaceForPrivacy, point: { lat: number; lon: number }) =>
  distanceM(place, point) <= place.radius_m;

/** The places these photos are filed under by label or sit inside by point. */
export function placesOfPhotos(places: PlaceForPrivacy[], photos: PhotoForPrivacy[]): PlaceForPrivacy[] {
  const labels = new Set(photos.flatMap((p) => (p.location_label ? [p.location_label.toLowerCase()] : [])));
  const points = photos.flatMap((p) => (p.lat !== null && p.lon !== null ? [{ lat: p.lat, lon: p.lon }] : []));
  return places.filter((s) => labels.has(s.name.toLowerCase()) || points.some((pt) => insidePlace(s, pt)));
}

export const strictest = (values: Geoprivacy[]): Geoprivacy =>
  values.reduce<Geoprivacy>((a, b) => (RANK[b] > RANK[a] ? b : a), "open");

/** The send's location fields, from the matched places and the photo whose point is sent. */
export function sendPlaceFields(input: {
  places: PlaceForPrivacy[];
  photos: PhotoForPrivacy[];
  sent: PhotoForPrivacy | null;
  /** The label-plus-region text a send without a private place uses. */
  placeGuess: string | null;
  regionName: string | null;
}): { geoprivacy: Geoprivacy | null; positionalAccuracy: number | null; placeGuess: string | null } {
  const matched = placesOfPhotos(input.places, input.photos);
  const geoprivacy = strictest(matched.map((s) => s.geoprivacy));
  const sent = input.sent;
  // A point a place put there (or an older placing at exactly its centre) is as precise as its
  // radius; camera GPS sends no accuracy.
  const centreOf =
    sent?.lat != null && sent.lon != null
      ? matched.find((s) => distanceM(s, { lat: sent.lat!, lon: sent.lon! }) < 1)
      : undefined;
  const positionalAccuracy =
    sent?.lat == null ? null : (sent.location_accuracy_m ?? (centreOf ? centreOf.radius_m : null));
  // iNaturalist shows place_guess publicly, so a hidden place never sends the user's own name for it.
  const hidden = geoprivacy !== "open";
  const locality = matched.find((s) => s.locality)?.locality ?? null;
  const placeGuess = hidden ? (locality ?? input.regionName) : input.placeGuess;
  // No place matched: left out. iNaturalist hides threatened species' locations itself, whatever is sent.
  return { geoprivacy: matched.length > 0 || hidden ? geoprivacy : null, positionalAccuracy, placeGuess };
}

/** A region's name with its parent's ("British Columbia, Canada"), for iNaturalist's place text.
 *  A province in a regional group, or shown under its continent, names its country instead. */
export async function regionPlaceName(regionId: string): Promise<string | null> {
  const res = await pool.query<{ name: string; parent_name: string | null }>(
    `SELECT r.name, CASE WHEN COALESCE(array_length(gp.external_codes, 1), 0) > 0 THEN gp.name ELSE p.name END AS parent_name
     FROM regions r
     LEFT JOIN regions p ON p.id = COALESCE(r.home_country_id, r.parent_id)
     LEFT JOIN regions gp ON gp.id = p.parent_id
     WHERE r.id = $1`,
    [regionId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return row.parent_name ? `${row.name}, ${row.parent_name}` : row.name;
}

/** Privacy, accuracy and place text for sending these photos (all one user's, one species).
 *  `sentId` is the photo whose point goes out. */
export async function placeForSend(
  userId: string,
  captureIds: string[],
  sentId: string | null,
  placeGuess: string | null,
  regionName: string | null,
) {
  const [places, photos] = await Promise.all([
    pool.query<PlaceForPrivacy>(
      `SELECT name, lat::float8 AS lat, lon::float8 AS lon, radius_m, geoprivacy, locality
       FROM saved_spots WHERE user_id = $1`,
      [userId],
    ),
    pool.query<PhotoForPrivacy>(
      `SELECT id, lat::float8 AS lat, lon::float8 AS lon, location_label, location_source,
              location_accuracy_m::float8 AS location_accuracy_m
       FROM captures WHERE user_id = $1 AND id = ANY($2::uuid[])`,
      [userId, captureIds],
    ),
  ]);
  return sendPlaceFields({
    places: places.rows,
    photos: photos.rows,
    sent: photos.rows.find((p) => p.id === sentId) ?? null,
    placeGuess,
    regionName,
  });
}
