// The offline town list (gazetteer_places, migration 183, shipped in the catalog seed): town
// search for /places/locate and the nearest town for a locality. Local only. Until an install's
// catalog has the list, both find nothing and callers keep the region names.
import { pool } from "@lifer/core/db.js";
import { regionAt } from "../regions/regionAt.js";
import { regionPlaceName } from "./placePrivacy.js";

/** "Near Prince George" past this would mislead (named places plan, section 2). */
export const LOCALITY_RADIUS_M = 25_000;
const CANDIDATES = 100;
const NEAR_CANDIDATES = 20;
const NEAR_SEARCH_KM = 300;

export interface Town {
  geonameId: number;
  name: string;
  lat: number;
  lon: number;
  population: number;
  regionId: string | null;
  /** "British Columbia, Canada" */
  detail: string | null;
  /** "Prince George, British Columbia, Canada" */
  locality: string;
  distanceM: number | null;
  /** One of its names is exactly the search. */
  exact: boolean;
}

/** Joined with ", ", skipping blanks and a part that repeats the one before ("Singapore, Singapore"). */
export function joinPlaceParts(parts: Array<string | null | undefined>): string {
  const out: string[] = [];
  for (const p of parts) {
    const t = p?.trim();
    if (t && t.toLowerCase() !== out.at(-1)?.toLowerCase()) out.push(t);
  }
  return out.join(", ").slice(0, 300);
}

/** Bigger towns first, nearer ones before far bigger ones when there's a `near`: a town 10 times
 *  smaller wins at about 150 km closer. */
export const townScore = (t: Pick<Town, "population" | "distanceM">) =>
  Math.log10(t.population + 10) - (t.distanceM === null ? 0 : 2 * Math.log10(1 + t.distanceM / 50_000));

/** Exact name matches, then by score, then the shorter name. */
export function rankTowns<T extends Pick<Town, "geonameId" | "name" | "population" | "distanceM" | "exact">>(
  towns: T[],
): T[] {
  const seen = new Set<number>();
  return towns
    .filter((t) => !seen.has(t.geonameId) && !!seen.add(t.geonameId))
    .sort(
      (a, b) =>
        Number(b.exact) - Number(a.exact) ||
        townScore(b) - townScore(a) ||
        a.name.length - b.name.length ||
        a.name.localeCompare(b.name),
    );
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
// Metres from ($1, $2) to g.
const DIST = `6371000 * 2 * asin(least(1, sqrt(
    power(sin(radians(g.lat - $1::float8) / 2), 2) +
    cos(radians($1::float8)) * cos(radians(g.lat)) * power(sin(radians(g.lon - $2::float8) / 2), 2))))`;
const TOWN_FROM = `FROM gazetteer_places g
  LEFT JOIN regions p ON p.id = g.province_region_id
  LEFT JOIN regions c ON c.id = g.country_region_id`;

interface TownRow {
  geoname_id: number;
  name: string;
  lat: number;
  lon: number;
  population: string;
  province_region_id: string | null;
  country_region_id: string | null;
  province: string | null;
  country: string | null;
  distance_m: number | null;
  exact: boolean;
}
const toTown = (r: TownRow): Town => ({
  geonameId: r.geoname_id,
  name: r.name,
  lat: r.lat,
  lon: r.lon,
  population: Number(r.population),
  regionId: r.province_region_id ?? r.country_region_id,
  detail: joinPlaceParts([r.province, r.country]) || null,
  locality: joinPlaceParts([r.name, r.province, r.country]),
  distanceM: r.distance_m,
  exact: r.exact,
});

// An install whose schema predates the table finds nothing rather than failing the search.
const orEmpty = (err: { code?: string }) => {
  if (err.code === "42P01") return { rows: [] as TownRow[] };
  throw err;
};

/** Towns any of whose names (accents, case and apostrophes ignored) start with `q`. */
export async function searchTowns(q: string, near: { lat: number; lon: number } | null, limit: number) {
  const norm = (await pool.query<{ n: string | null }>(`SELECT lifer_search_norm($1) AS n`, [q])).rows[0].n;
  if (!norm) return [];
  const prefix = `%|${escapeLike(norm)}%`;
  const exact = `%|${escapeLike(norm)}|%`;
  const columns = `g.geoname_id, g.name, g.lat, g.lon, g.population, g.province_region_id, g.country_region_id,
    p.name AS province, c.name AS country, g.search_text LIKE $4 AS exact,
    CASE WHEN $1::float8 IS NULL THEN NULL ELSE ${DIST} END AS distance_m`;
  const args = [near?.lat ?? null, near?.lon ?? null, prefix, exact];
  const [top, nearby] = await Promise.all([
    pool
      .query<TownRow>(
        `SELECT ${columns} ${TOWN_FROM} WHERE g.search_text LIKE $3
         ORDER BY exact DESC, g.population DESC LIMIT ${CANDIDATES}`,
        args,
      )
      .catch(orEmpty),
    // Small towns near the photos, which a short search's biggest matches would crowd out.
    near
      ? pool
          .query<TownRow>(
            `SELECT ${columns} ${TOWN_FROM} WHERE g.search_text LIKE $3
               AND g.lat BETWEEN $1::float8 - $5::float8 AND $1::float8 + $5::float8
             ORDER BY distance_m LIMIT ${NEAR_CANDIDATES}`,
            [...args, NEAR_SEARCH_KM / 111.32],
          )
          .catch(orEmpty)
      : { rows: [] as TownRow[] },
  ]);
  return rankTowns([...top.rows, ...nearby.rows].map(toTown)).slice(0, limit);
}

/** The nearest town within `withinM` of the point, or null. */
export async function nearestTown(lat: number, lon: number, withinM = LOCALITY_RADIUS_M): Promise<Town | null> {
  const dLat = withinM / 111_320;
  // shortcut: the longitude window doesn't wrap at the antimeridian or reach past 89 degrees;
  // towns there fall back to the region name. Wrap it if Fiji or Chukotka users notice.
  const dLon = Math.min(180, dLat / Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  const res = await pool
    .query<TownRow>(
      `SELECT g.geoname_id, g.name, g.lat, g.lon, g.population, g.province_region_id, g.country_region_id,
              p.name AS province, c.name AS country, false AS exact, ${DIST} AS distance_m
       ${TOWN_FROM}
       WHERE g.feature_class = 'P' AND g.lat BETWEEN $1::float8 - $3::float8 AND $1::float8 + $3::float8
         AND g.lon BETWEEN $2::float8 - $4::float8 AND $2::float8 + $4::float8 AND ${DIST} <= $5::float8
       ORDER BY distance_m LIMIT 1`,
      [lat, lon, dLat, dLon, withinM],
    )
    .catch(orEmpty);
  return res.rows[0] ? toTown(res.rows[0]) : null;
}

/** A point's locality: the nearest town within 25 km ("Prince George, British Columbia, Canada"),
 *  else its region's name ("British Columbia, Canada"), else null. `regionId` saves the lookup
 *  when the caller has it (null: the point is in no region). */
export async function localityAt(
  lat: number,
  lon: number,
  regionId?: string | null,
): Promise<{ locality: string; source: "gazetteer" | "region" } | null> {
  const town = await nearestTown(lat, lon);
  if (town) return { locality: town.locality, source: "gazetteer" };
  const region = regionId === undefined ? ((await regionAt(lat, lon))?.id ?? null) : regionId;
  const name = region ? await regionPlaceName(region) : null;
  return name ? { locality: name, source: "region" } : null;
}

/** After a catalog update brings the town list: places whose locality came from their region get
 *  the nearest town instead. Typed ones are never touched. */
export async function upgradeRegionLocalities(): Promise<number> {
  const spots = await pool.query<{ id: string; lat: number; lon: number }>(
    `SELECT id, lat::float8 AS lat, lon::float8 AS lon FROM saved_spots WHERE locality_source = 'region'`,
  );
  let upgraded = 0;
  for (const s of spots.rows) {
    const town = await nearestTown(s.lat, s.lon);
    if (!town) continue;
    const res = await pool.query(
      `UPDATE saved_spots SET locality = $2, locality_source = 'gazetteer' WHERE id = $1 AND locality_source = 'region'`,
      [s.id, town.locality],
    );
    upgraded += res.rowCount ?? 0;
  }
  return upgraded;
}
