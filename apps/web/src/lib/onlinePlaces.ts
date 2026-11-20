// Online place search and place names through Photon (komoot's public geocoder, OpenStreetMap data).
// Built for search-as-you-type, unlike Nominatim, whose policy bans it. Requests go straight from the
// app's web view, like map tiles; see docs/plans/map-detail-and-satellite.md for the terms.
//
// Callers must check useOnlinePlaces().enabled first (the user's setting plus being online) and show
// its first-time notice; these functions only talk to Photon.

const PHOTON = "https://photon.komoot.io";
/** Shown wherever online results appear: Photon's data is OpenStreetMap (ODbL). */
export const PHOTON_ATTRIBUTION = "Photon (komoot), © OpenStreetMap contributors";
export const ONLINE_SEARCH_MIN_LENGTH = 3;
export const ONLINE_SEARCH_DEBOUNCE_MS = 350;
const RESULT_LIMIT = 6;
const CACHE_MAX = 200;
const BACKOFF_START_MS = 30_000;
const BACKOFF_MAX_MS = 10 * 60_000;
export const REQUEST_TIMEOUT_MS = 15_000;

export type OnlinePlaceKind = "town" | "park" | "water" | "address" | "region" | "other";

export interface OnlinePlace {
  kind: "online";
  /** Photon's OSM id, stable across searches. */
  id: string;
  name: string;
  placeKind: OnlinePlaceKind;
  /** "Leamington, Ontario, Canada": where it is, for telling same-named places apart. */
  region: string | null;
  lat: number;
  lon: number;
  /** west,south,east,north, when the place has an extent. */
  bbox: [number, number, number, number] | null;
  regionId: null;
  detail: string | null;
}

/** Photon is overloaded or throttling us, or the request failed: offline results still show. */
export class OnlinePlacesUnavailable extends Error {}

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

// One cache and one back-off per page: a query is never sent twice, and a 429 or 5xx pauses every
// caller for a while (doubling) instead of retrying at typing speed.
const cache = new Map<string, unknown>();
let pausedUntil = 0;
let backoff = BACKOFF_START_MS;

function remember(key: string, value: unknown) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
}

async function photon(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<PhotonResponse> {
  const url = `${PHOTON}${path}?${new URLSearchParams(params)}`;
  if (cache.has(url)) return cache.get(url) as PhotonResponse;
  if (Date.now() < pausedUntil) throw new OnlinePlacesUnavailable("paused");
  // Patient: a weak connection answers slowly, and that is not "unavailable".
  const own = new AbortController();
  const stop = () => own.abort();
  signal?.addEventListener("abort", stop);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    own.abort();
  }, REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: own.signal, credentials: "omit" });
  } catch (err) {
    if (timedOut) throw new OnlinePlacesUnavailable("timeout");
    if ((err as Error).name === "AbortError") throw err;
    throw new OnlinePlacesUnavailable((err as Error).message);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
  if (res.status === 429 || res.status >= 500) {
    pausedUntil = Date.now() + backoff;
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    throw new OnlinePlacesUnavailable(`Photon ${res.status}`);
  }
  if (!res.ok) throw new OnlinePlacesUnavailable(`Photon ${res.status}`);
  backoff = BACKOFF_START_MS;
  const body = (await res.json()) as PhotonResponse;
  remember(url, body);
  return body;
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: {
    osm_type?: string;
    osm_id?: number;
    osm_key?: string;
    osm_value?: string;
    type?: string;
    name?: string;
    street?: string;
    housenumber?: string;
    city?: string;
    county?: string;
    state?: string;
    country?: string;
    /** west, north, east, south */
    extent?: [number, number, number, number];
  };
}
interface PhotonResponse {
  features?: PhotonFeature[];
}

const TOWNS = new Set(["city", "town", "village", "hamlet", "suburb", "neighbourhood", "locality"]);
const PARKS = new Set(["park", "national_park", "nature_reserve", "protected_area", "wood", "forest"]);
const WATER = new Set(["water", "lake", "reservoir", "pond", "bay", "river", "wetland", "lagoon"]);

function kindOf(p: PhotonFeature["properties"]): OnlinePlaceKind {
  const v = p.osm_value ?? "";
  if (TOWNS.has(v) || p.type === "city" || p.type === "district") return "town";
  if (PARKS.has(v)) return "park";
  if (WATER.has(v) || p.osm_key === "water" || p.osm_key === "waterway") return "water";
  // Only real street addresses: roads, paths and airports also come back as "street" or "house".
  if (p.housenumber) return "address";
  if (p.type === "county" || p.type === "state" || p.type === "country") return "region";
  return "other";
}

function toPlace(f: PhotonFeature): OnlinePlace | null {
  const p = f.properties;
  const name = p.name ?? (p.street ? [p.street, p.housenumber].filter(Boolean).join(" ") : null);
  if (!name) return null;
  const [lon, lat] = f.geometry.coordinates;
  const region = [p.city, p.state, p.country].filter((s, i, all) => s && s !== name && all.indexOf(s) === i);
  const e = p.extent;
  return {
    kind: "online",
    id: `${p.osm_type ?? ""}${p.osm_id ?? `${lat},${lon}`}`,
    name,
    placeKind: kindOf(p),
    region: region.length ? region.join(", ") : null,
    lat,
    lon,
    bbox: e ? [e[0], e[3], e[2], e[1]] : null,
    regionId: null,
    detail: null,
  };
}

/** Kilometres between two points, near enough for telling duplicates apart. */
export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.sqrt(x * x + y * y) * 6371;
}

/** Drops places that repeat one already listed: the same name within a few kilometres. */
export function dedupePlaces<T extends { name: string; lat: number; lon: number }>(
  places: T[],
  already: Array<{ name: string; lat: number; lon: number }> = [],
): T[] {
  const kept: Array<{ name: string; lat: number; lon: number }> = [...already];
  const same = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" }) === 0;
  return places.filter((p) => {
    if (kept.some((k) => same(k.name, p.name) && distanceKm(k, p) < 5)) return false;
    kept.push(p);
    return true;
  });
}

/** Forward search: sends only the typed text and, optionally, the map's centre rounded to about
 *  10 km (one decimal), never a photo's location. */
export async function searchPlaces(
  query: string,
  { bias, signal }: { bias?: { lat: number; lon: number } | null; signal?: AbortSignal } = {},
): Promise<OnlinePlace[]> {
  const q = query.trim();
  if (q.length < ONLINE_SEARCH_MIN_LENGTH) return [];
  const params: Record<string, string> = { q, limit: String(RESULT_LIMIT), lang: "en" };
  if (bias) Object.assign(params, { lat: String(round(bias.lat, 1)), lon: String(round(bias.lon, 1)) });
  const body = await photon("/api/", params, signal);
  return dedupePlaces((body.features ?? []).map(toPlace).filter((p): p is OnlinePlace => p !== null));
}

/** The name of the place at a point, "Prince George, British Columbia, Canada", or null. Sends only
 *  the point rounded to about 100 m (three decimals). */
export async function reversePlaceName(
  lat: number,
  lon: number,
  { signal }: { signal?: AbortSignal } = {},
): Promise<string | null> {
  const body = await photon(
    "/reverse",
    { lat: String(round(lat, 3)), lon: String(round(lon, 3)), lang: "en", limit: "1" },
    signal,
  );
  const p = body.features?.[0]?.properties;
  if (!p) return null;
  const locality = p.city ?? (TOWNS.has(p.osm_value ?? "") ? p.name : undefined) ?? p.county;
  const parts = [locality, p.state, p.country].filter((s, i, all): s is string => !!s && all.indexOf(s) === i);
  return parts.length ? parts.join(", ") : null;
}

/** Test hook: forget the cache and any back-off. */
export function resetOnlinePlaces(): void {
  cache.clear();
  pausedUntil = 0;
  backoff = BACKOFF_START_MS;
}
