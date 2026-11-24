import { regionNear } from "../regions/regionAt.js";

export interface PlaceParts {
  /** The saved place name (captures.location_label). */
  label: string | null;
  /** The name of the region the photo is filed under. */
  region: string | null;
  lat: string | number | null;
  lon: string | number | null;
}

/** "Pigeon Lake, Alberta": the saved place name with the region the photo is filed under. With
 *  neither, the region its GPS point is in or within NEAR_KM of (a photo taken at sea off the
 *  coast), else null. */
export async function placeLabel(p: PlaceParts): Promise<string | null> {
  if (p.label || p.region) return p.label && p.region ? `${p.label}, ${p.region}` : (p.label ?? p.region);
  if (p.lat == null || p.lon == null) return null;
  const near = await regionNear(Number(p.lat), Number(p.lon)).catch(() => null);
  return near?.name ?? null;
}
