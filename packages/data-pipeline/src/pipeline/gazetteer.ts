// The offline town list (gazetteer_places, migration 183): GeoNames populated places (CC BY 4.0),
// each tied to its Lifer country and province by point in outline. Installs get it in the
// catalog seed and search it with /places/locate and the spot locality.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import type { Pool, PoolClient } from "pg";
import { fetchCached } from "@lifer/core/rawCache.js";
import {
  exteriorRingsFromGeometry,
  pointInRing,
  ringBoundingBox,
  type BoundingBox,
  type Point,
} from "@lifer/core/lib/geometry.js";
import { isCountryRow, type RegionRow } from "./places.js";

type Db = Pick<Pool | PoolClient, "query">;

// cities1000: about 172,000 towns over 1,000 people or a seat, so Tofino and Haines are found.
const SET = "cities1000";
const DUMP = "https://download.geonames.org/export/dump";
// The base set ships in every install, so it stays small (map plan, MAP-07).
// About 6 MB today; the headroom is for GeoNames growth, not for a bigger set.
export const MAX_GZIP_BYTES = 8 * 1024 * 1024;
const MAX_ALTERNATES = 5;
const MAIN_SHARE = 0.9;

export interface GazetteerPlace {
  geonameId: number;
  name: string;
  asciiName: string;
  alternateNames: string;
  lat: number;
  lon: number;
  population: number;
  featureClass: string;
  featureCode: string;
  countryCode: string;
  admin1Code: string | null;
  countryRegionId: string | null;
  provinceRegionId: string | null;
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[\s_/-]+/g, " ")
    .trim();
const LATIN = /^[\p{Script=Latin}\p{M}\s'’.()-]+$/u;

/** Up to five Latin-script other names, without codes (IATA "YXS") or repeats of the name. */
export function pickAlternates(name: string, asciiName: string, raw: string): string {
  const seen = new Set([fold(name), fold(asciiName)]);
  const out: string[] = [];
  for (const alt of raw.split(",")) {
    const a = alt.trim();
    if (a.length < 3 || a.includes("|") || !LATIN.test(a) || (a.length <= 4 && a === a.toUpperCase())) continue;
    const key = fold(a);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
    if (out.length === MAX_ALTERNATES) break;
  }
  return out.join("|");
}

/** The rows of a GeoNames `geoname` table extract (tab separated, readme.txt). */
export function parseCities(text: string): Omit<GazetteerPlace, "countryRegionId" | "provinceRegionId">[] {
  return text.split("\n").flatMap((line) => {
    const f = line.split("\t");
    if (f.length < 15 || !f[1]) return [];
    return [
      {
        geonameId: Number(f[0]),
        name: f[1],
        asciiName: f[2] || f[1],
        alternateNames: pickAlternates(f[1], f[2] || f[1], f[3]),
        lat: Number(f[4]),
        lon: Number(f[5]),
        population: Number(f[14]) || 0,
        featureClass: f[6],
        featureCode: f[7],
        countryCode: f[8],
        admin1Code: f[10] || null,
      },
    ];
  });
}

/** ISO2 to ISO3 from GeoNames countryInfo.txt (regions carry ISO3). */
export function parseCountryInfo(text: string): Map<string, string> {
  return new Map(
    text.split("\n").flatMap((line) => {
      const f = line.split("\t");
      return line.startsWith("#") || f.length < 2 ? [] : [[f[0], f[1]] as [string, string]];
    }),
  );
}

// GeoNames' country, in Lifer's own codes where they differ: Natural Earth's codes, and territories
// Lifer keeps as provinces of their country. GeoNames' country wins over any outline, so a town
// near a border or in a disputed area is never filed under a neighbour.
const LIFER_COUNTRY: Record<string, string> = {
  XK: "KOS",
  PS: "PSX",
  SS: "SDS",
  EH: "SAH",
  AX: "ALD",
  YT: "FRA",
  RE: "FRA",
  GP: "FRA",
  MQ: "FRA",
  GF: "FRA",
  BQ: "NLD",
  SJ: "NOR",
  TK: "NZL",
  CX: "IOA",
  CC: "IOA",
};

interface Leaf {
  id: string;
  rings: { box: BoundingBox; ring: Point[] }[];
}

/** Each place's country (by code) and province (the most specific region under that country whose
 *  outline holds it). A coastal town just outside a simplified outline takes the province most of
 *  its GeoNames admin1 neighbours fell in. A country code Lifer has no country for is placed by
 *  outline. */
export function assignRegions(
  regions: RegionRow[],
  places: Omit<GazetteerPlace, "countryRegionId" | "provinceRegionId">[],
  iso3Of: Map<string, string>,
): GazetteerPlace[] {
  const byId = new Map(regions.map((r) => [r.id, r]));
  const kids = new Map<string, RegionRow[]>();
  for (const r of regions) if (r.parentId) kids.set(r.parentId, [...(kids.get(r.parentId) ?? []), r]);
  const countryByCode = new Map<string, RegionRow>();
  for (const r of regions) if (r.code && isCountryRow(byId, r)) countryByCode.set(r.code.toUpperCase(), r);

  const leavesCache = new Map<string, Leaf[]>();
  const leavesOf = (country: RegionRow): Leaf[] => {
    const cached = leavesCache.get(country.id);
    if (cached) return cached;
    const out: Leaf[] = [];
    const walk = (r: RegionRow) => {
      const own = kids.get(r.id) ?? [];
      if (own.length > 0) return own.forEach(walk);
      const leaf = outlineOf(r);
      if (leaf) out.push(leaf);
    };
    // Provinces moved under a continent still belong to their country.
    for (const r of [...(kids.get(country.id) ?? []), ...regions.filter((m) => m.homeCountryId === country.id)])
      walk(r);
    leavesCache.set(country.id, out);
    return out;
  };
  const holds = (leaf: Leaf, p: Point) =>
    leaf.rings.some(
      ({ box, ring }) =>
        p[0] >= box.minLon && p[0] <= box.maxLon && p[1] >= box.minLat && p[1] <= box.maxLat && pointInRing(p, ring),
    );

  const outlineOf = (r: RegionRow): Leaf | null => {
    const rings = r.boundary?.geometry ? exteriorRingsFromGeometry(r.boundary.geometry) : [];
    return rings.length ? { id: r.id, rings: rings.map((ring) => ({ box: ringBoundingBox(ring), ring })) } : null;
  };
  // Every province of every country, and a country without provinces as itself.
  type Placed = { leaf: Leaf; countryId: string; isProvince: boolean };
  let everywhere: Placed[] | null = null;
  const byOutline = (point: Point) => {
    everywhere ??= [...new Set(countryByCode.values())].flatMap((c): Placed[] => {
      const leaves = leavesOf(c);
      if (leaves.length) return leaves.map((leaf) => ({ leaf, countryId: c.id, isProvince: true }));
      const own = outlineOf(c);
      return own ? [{ leaf: own, countryId: c.id, isProvince: false }] : [];
    });
    return everywhere.find((e) => holds(e.leaf, point)) ?? null;
  };

  const out = places.map((p) => {
    const code = LIFER_COUNTRY[p.countryCode] ?? iso3Of.get(p.countryCode) ?? p.countryCode;
    const country = countryByCode.get(code) ?? null;
    const point: Point = [p.lon, p.lat];
    if (!country) {
      const found = byOutline(point);
      return {
        ...p,
        countryRegionId: found?.countryId ?? null,
        provinceRegionId: found?.isProvince ? found.leaf.id : null,
      };
    }
    // Only this country's provinces: a town in a province Lifer has no outline for (Crimea) keeps
    // its country and no province, never a neighbour's.
    const province = leavesOf(country).find((l) => holds(l, point))?.id ?? null;
    return { ...p, countryRegionId: country.id, provinceRegionId: province };
  });

  const votes = new Map<string, Map<string, number>>();
  const key = (p: GazetteerPlace) => `${p.countryCode}.${p.admin1Code}`;
  for (const p of out) {
    if (!p.provinceRegionId || !p.admin1Code) continue;
    const v = votes.get(key(p)) ?? new Map<string, number>();
    v.set(p.provinceRegionId, (v.get(p.provinceRegionId) ?? 0) + 1);
    votes.set(key(p), v);
  }
  // A group's main province, when nearly all its towns fell in one (provinces match admin1 there).
  const main = new Map<string, string>();
  const mainOf = new Map<string, string>();
  for (const [group, v] of votes) {
    const total = [...v.values()].reduce((a, b) => a + b, 0);
    const [top, n] = [...v].sort((a, b) => b[1] - a[1])[0];
    if (n / total >= MAIN_SHARE) {
      main.set(group, top);
      mainOf.set(top, group);
    }
  }
  for (const p of out) {
    if (!p.countryRegionId || !p.admin1Code) continue;
    const own = main.get(key(p));
    if (!p.provinceRegionId) {
      const v = votes.get(key(p));
      if (v) p.provinceRegionId = [...v].sort((a, b) => b[1] - a[1])[0][0];
    } else if (own && own !== p.provinceRegionId && mainOf.has(p.provinceRegionId)) {
      // A border town a simplified outline put in the neighbouring province (Hull, Québec in Ontario).
      p.provinceRegionId = own;
    }
  }
  return out;
}

const COLUMNS = [
  "geoname_id",
  "name",
  "ascii_name",
  "alternate_names",
  "lat",
  "lon",
  "population",
  "feature_class",
  "feature_code",
  "country_code",
  "admin1_code",
  "country_region_id",
  "province_region_id",
] as const;
const TYPES = [
  "int",
  "text",
  "text",
  "text",
  "float8",
  "float8",
  "int8",
  "text",
  "text",
  "text",
  "text",
  "uuid",
  "uuid",
];
const values = (p: GazetteerPlace) => [
  p.geonameId,
  p.name,
  p.asciiName,
  p.alternateNames,
  p.lat,
  p.lon,
  p.population,
  p.featureClass,
  p.featureCode,
  p.countryCode,
  p.admin1Code,
  p.countryRegionId,
  p.provinceRegionId,
];

/** The shipped rows as gzipped tab-separated text: close to their share of the catalog seed. */
export const gzipBytes = (places: GazetteerPlace[]) =>
  gzipSync(places.map((p) => values(p).join("\t")).join("\n")).length;

/** Writes only rows that changed and removes populated places the source no longer lists, so a
 *  rerun on the same download writes nothing. */
export async function applyGazetteer(
  db: Db,
  places: GazetteerPlace[],
): Promise<{ written: number; removed: number; total: number }> {
  let written = 0;
  const updatable = COLUMNS.slice(1);
  for (let i = 0; i < places.length; i += 5000) {
    const batch = places.slice(i, i + 5000);
    const res = await db.query(
      `INSERT INTO gazetteer_places (${COLUMNS.join(", ")})
       SELECT * FROM unnest(${TYPES.map((t, n) => `$${n + 1}::${t}[]`).join(", ")})
       ON CONFLICT (geoname_id) DO UPDATE SET ${updatable.map((c) => `${c} = EXCLUDED.${c}`).join(", ")}
       WHERE (${updatable.map((c) => `gazetteer_places.${c}`).join(", ")})
         IS DISTINCT FROM (${updatable.map((c) => `EXCLUDED.${c}`).join(", ")})`,
      COLUMNS.map((_, n) => batch.map((p) => values(p)[n])),
    );
    written += res.rowCount ?? 0;
  }
  // shortcut: removes every populated place not in this set; when packs add their own (MAP-07
  // per-region lists), mark pack rows so the base refresh leaves them alone.
  const removed = await db.query(
    `DELETE FROM gazetteer_places WHERE feature_class = 'P' AND NOT (geoname_id = ANY($1::int[]))`,
    [places.map((p) => p.geonameId)],
  );
  return { written, removed: removed.rowCount ?? 0, total: places.length };
}

// Spot checks: big, middling and small towns, an accented name, a name shared across places.
export const SPOT_CHECKS = ["Prince George", "Vancouver", "Tofino", "Cottonwood", "Montréal", "Springfield"];
// Towns a good download always has (country code and name), the small ones included.
export const REQUIRED_TOWNS: Array<[string, string]> = [
  ["CA", "Prince George"],
  ["CA", "Vancouver"],
  ["CA", "Tofino"],
  ["CA", "Fort Nelson"],
  ["CA", "Jasper"],
  ["US", "Cottonwood"],
  ["US", "Haines"],
];

/** The required towns a set lacks: a truncated download or a changed format. */
export const missingTowns = (places: Pick<GazetteerPlace, "countryCode" | "name">[]) =>
  REQUIRED_TOWNS.filter(([cc, name]) => !places.some((p) => p.countryCode === cc && p.name === name)).map(
    ([cc, name]) => `${name} (${cc})`,
  );

/** Counts and a locality line for each spot check, for the log. */
export async function verifyGazetteer(db: Db): Promise<string[]> {
  const totals = (
    await db.query<{ n: number; countries: number; with_province: number; without_country: number }>(
      `SELECT count(*)::int AS n, count(DISTINCT country_code)::int AS countries,
              count(province_region_id)::int AS with_province, count(*) FILTER (WHERE country_region_id IS NULL)::int AS without_country
       FROM gazetteer_places`,
    )
  ).rows[0];
  const lines = [
    `${totals.n} places in ${totals.countries} countries; ${totals.with_province} with a province, ${totals.without_country} with no Lifer country`,
  ];
  for (const name of SPOT_CHECKS) {
    const res = await db.query<{ line: string }>(
      `SELECT concat_ws(', ', g.name, p.name, c.name) || ' (' || g.population || ')' AS line
       FROM gazetteer_places g LEFT JOIN regions p ON p.id = g.province_region_id LEFT JOIN regions c ON c.id = g.country_region_id
       WHERE g.name = $1 ORDER BY g.population DESC LIMIT 3`,
      [name],
    );
    lines.push(`${name}: ${res.rows.length ? res.rows.map((r) => r.line).join("; ") : "not in this set"}`);
  }
  return lines;
}

/** Downloads (once; cached under data/raw/geonames) and reads the towns and the country codes. */
export async function loadGazetteerSource() {
  const zip = await fetchCached("geonames", `${SET}.zip`, `${DUMP}/${SET}.zip`);
  const countryInfo = await fetchCached("geonames", "countryInfo.txt", `${DUMP}/countryInfo.txt`);
  const text = execFileSync("unzip", ["-p", zip, `${SET}.txt`], { maxBuffer: 512 * 1024 * 1024 }).toString("utf8");
  return { places: parseCities(text), iso3Of: parseCountryInfo(readFileSync(countryInfo, "utf8")) };
}

export async function loadRegionRows(db: Db): Promise<RegionRow[]> {
  const res = await db.query<{
    id: string;
    name: string;
    parent_id: string | null;
    home_country_id: string | null;
    code: string | null;
    boundary_geojson: RegionRow["boundary"];
  }>(
    `SELECT id, name, parent_id, home_country_id, external_codes[1] AS code, boundary_geojson
     FROM regions WHERE external_codes[1] IS DISTINCT FROM 'USG'`,
  );
  return res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    parentId: r.parent_id,
    homeCountryId: r.home_country_id,
    code: r.code,
    boundary: r.boundary_geojson,
  }));
}
