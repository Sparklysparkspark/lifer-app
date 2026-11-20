// An example city per region and the most populous province per country, from Natural Earth
// populated places (public domain). Placeholders in the web app name them ("Vancouver"), and a
// country's search example is its most populous province.
import { readFileSync } from "node:fs";
import type { Pool, PoolClient } from "pg";
import { fetchCached } from "@lifer/core/rawCache.js";
import { exteriorRingsFromGeometry, pointInAnyRing, type Point } from "@lifer/core/lib/geometry.js";

type Db = Pick<Pool | PoolClient, "query">;

const PLACES_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_populated_places_simple.geojson";

export interface Place {
  name: string;
  /** An Admin-0 or Admin-1 capital. */
  capital: boolean;
  population: number;
  iso3: string | null;
  iso2: string | null;
  adm1Name: string | null;
  point: Point;
}

export interface RegionRow {
  id: string;
  name: string;
  parentId: string | null;
  homeCountryId: string | null;
  /** external_codes[0]: an ISO code on a country, WKT or empty below it. */
  code: string | null;
  boundary: { geometry?: { type: string; coordinates: unknown } } | null;
}

export interface PlaceAssignment {
  exampleCity: string | null;
  populousChildId: string | null;
}

interface Pick1 {
  city: string;
  capital: boolean;
  population: number;
}

/** World > continent > country; a province shown under its continent is not one. */
export function isCountryRow(
  byId: Map<string, { parentId: string | null; homeCountryId: string | null }>,
  r: { parentId: string | null; homeCountryId: string | null },
) {
  const continent = r.parentId ? byId.get(r.parentId) : undefined;
  const world = continent?.parentId ? byId.get(continent.parentId) : undefined;
  return !r.homeCountryId && !!world && world.parentId === null;
}

export async function loadPopulatedPlaces(): Promise<Place[]> {
  const file = await fetchCached("natural-earth", "ne_10m_populated_places_simple.geojson", PLACES_URL);
  const data = JSON.parse(readFileSync(file, "utf-8")) as {
    features: { properties: Record<string, unknown>; geometry: { coordinates: Point } }[];
  };
  const text = (v: unknown) => (typeof v === "string" && v && v !== "-99" ? v : null);
  return data.features.flatMap((f) => {
    const p = f.properties;
    const name = text(p.name);
    if (!name) return [];
    return [
      {
        name,
        capital: /capital/i.test(String(p.featurecla ?? "")),
        population: Number(p.pop_max) || 0,
        iso3: text(p.adm0_a3),
        iso2: text(p.iso_a2),
        adm1Name: text(p.adm1name),
        point: f.geometry.coordinates,
      },
    ];
  });
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** A capital first, then the biggest place. */
const better = (a: Pick1 | null, b: Place): Pick1 =>
  !a || (b.capital && !a.capital) || (b.capital === a.capital && b.population > a.population)
    ? { city: b.name, capital: b.capital, population: b.population }
    : a;

/** Each region's example city and each region's most populous direct child. A region with a
 *  boundary takes the places inside it, else the places whose province name matches; a group of
 *  provinces takes its members' best city. */
export function assignPlaces(regions: RegionRow[], places: Place[]): Map<string, PlaceAssignment> {
  const byId = new Map(regions.map((r) => [r.id, r]));
  const kids = new Map<string, RegionRow[]>();
  for (const r of regions) if (r.parentId) kids.set(r.parentId, [...(kids.get(r.parentId) ?? []), r]);
  const isCountry = (r: RegionRow) => isCountryRow(byId, r);
  const placesOf = (country: RegionRow) => {
    const code = country.code?.toUpperCase();
    return code ? places.filter((p) => p.iso3 === code || p.iso2 === code) : [];
  };

  const best = new Map<string, Pick1 | null>();
  const pop = new Map<string, number>();
  const visit = (r: RegionRow, pool: Place[]): void => {
    const own = kids.get(r.id) ?? [];
    let pick: Pick1 | null = null;
    let total = 0;
    if (own.length === 0) {
      const rings = r.boundary?.geometry ? exteriorRingsFromGeometry(r.boundary.geometry) : [];
      const name = fold(r.name);
      const inside = rings.length
        ? pool.filter((p) => pointInAnyRing(p.point, rings))
        : pool.filter((p) => p.adm1Name && fold(p.adm1Name) === name);
      for (const p of inside) {
        pick = better(pick, p);
        total += p.population;
      }
    } else {
      for (const k of own) {
        visit(k, pool);
        total += pop.get(k.id) ?? 0;
        const kb = best.get(k.id);
        if (
          kb &&
          (!pick || (kb.capital && !pick.capital) || (kb.capital === pick.capital && kb.population > pick.population))
        )
          pick = kb;
      }
    }
    best.set(r.id, pick);
    pop.set(r.id, total);
  };

  const out = new Map<string, PlaceAssignment>();
  for (const country of regions.filter(isCountry)) {
    const pool = placesOf(country);
    // Provinces moved under a continent still belong to their country.
    const members = regions.filter((r) => r.homeCountryId === country.id);
    const own = kids.get(country.id) ?? [];
    for (const k of [...own, ...members]) visit(k, pool);
    const countryCapital = pool.filter((p) => p.capital && p.iso3 === country.code?.toUpperCase());
    let city: Pick1 | null = null;
    for (const p of countryCapital.length ? countryCapital : pool) city = better(city, p);
    out.set(country.id, { exampleCity: city?.city ?? null, populousChildId: populousOf(own, pop) });
    for (const r of [...own, ...members]) collect(r);
  }
  function collect(r: RegionRow): void {
    const own = kids.get(r.id) ?? [];
    out.set(r.id, { exampleCity: best.get(r.id)?.city ?? null, populousChildId: populousOf(own, pop) });
    own.forEach(collect);
  }
  return out;
}

function populousOf(children: RegionRow[], pop: Map<string, number>): string | null {
  let top: RegionRow | null = null;
  for (const c of children) if ((pop.get(c.id) ?? 0) > (top ? (pop.get(top.id) ?? 0) : 0)) top = c;
  return top?.id ?? null;
}

export interface PlacesResult {
  regions: number;
  withCity: number;
  changed: number;
  /** Countries with no city in Natural Earth: stored as an explicit none. */
  countriesWithoutCity: string[];
}

/** Computes and stores both columns, touching only regions whose values changed. */
export async function applyPlaces(db: Db, places: Place[]): Promise<PlacesResult> {
  const rows = (
    await db.query<{
      id: string;
      name: string;
      parent_id: string | null;
      home_country_id: string | null;
      code: string | null;
      boundary_geojson: RegionRow["boundary"];
      example_city: string | null;
      populous_child_id: string | null;
    }>(
      `SELECT id, name, parent_id, home_country_id, external_codes[1] AS code, boundary_geojson, example_city, populous_child_id
       FROM regions WHERE external_codes[1] IS DISTINCT FROM 'USG'`,
    )
  ).rows;
  const assigned = assignPlaces(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      parentId: r.parent_id,
      homeCountryId: r.home_country_id,
      code: r.code,
      boundary: r.boundary_geojson,
    })),
    places,
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const lookup = new Map(rows.map((r) => [r.id, { parentId: r.parent_id, homeCountryId: r.home_country_id }]));
  const result: PlacesResult = { regions: assigned.size, withCity: 0, changed: 0, countriesWithoutCity: [] };
  for (const [id, a] of assigned) {
    const row = byId.get(id)!;
    if (a.exampleCity) result.withCity++;
    else if (isCountryRow(lookup, lookup.get(id)!)) result.countriesWithoutCity.push(row.name);
    if (row.example_city === a.exampleCity && row.populous_child_id === a.populousChildId) continue;
    await db.query(`UPDATE regions SET example_city = $2, populous_child_id = $3 WHERE id = $1`, [
      id,
      a.exampleCity,
      a.populousChildId,
    ]);
    result.changed++;
  }
  return result;
}
