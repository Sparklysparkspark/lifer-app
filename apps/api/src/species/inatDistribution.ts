// Weekly observation counts for a hand-added (Other Taxa) species, which no catalog pack covers,
// from iNaturalist. Fetched when the species is added to a region, for that country and its
// provinces or states, and stored (inat_region_taxon_data, migration 142) so they're there offline
// from then on. Live lookups, so only for users with the any-taxa search opt-in.
import { pool } from "@lifer/core/db.js";
import { httpFetch } from "@lifer/core/lib/http.js";
import { log } from "@lifer/core/lib/log.js";

const INAT_API = "https://api.inaturalist.org/v1";
const LOOKUP = { timeoutMs: 15_000, maxRetries: 1 };
// Seasonality barely moves, so a yearly refresh is plenty.
const REFRESH_AFTER_DAYS = 365;
// Countries split into hundreds of districts (the UK) get their larger groupings instead, since
// iNaturalist allows about one request a second.
const MAX_SUBDIVISIONS = 60;

interface RegionRow {
  id: string;
  name: string;
  inat_place_id: number | null;
  boundary_geojson: unknown;
}

type Box = { minLon: number; minLat: number; maxLon: number; maxLat: number };

function boundsOf(geojson: unknown): Box | null {
  const box: Box = { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity };
  const walk = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === "number" && typeof node[1] === "number") {
      box.minLon = Math.min(box.minLon, node[0]);
      box.maxLon = Math.max(box.maxLon, node[0]);
      box.minLat = Math.min(box.minLat, node[1]);
      box.maxLat = Math.max(box.maxLat, node[1]);
    } else node.forEach(walk);
  };
  const g = geojson as { coordinates?: unknown; geometry?: { coordinates?: unknown }; features?: unknown[] } | null;
  walk(g?.coordinates ?? g?.geometry?.coordinates);
  for (const f of g?.features ?? []) walk((f as { geometry?: { coordinates?: unknown } }).geometry?.coordinates);
  return Number.isFinite(box.minLon) ? box : null;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await httpFetch(url, LOOKUP);
  if (!res.ok) throw new Error(`iNaturalist answered ${res.status}`);
  return (await res.json()) as T;
}

/** The region as an iNaturalist query: its place (which follows the real border), else its
 *  bounding box. */
function whereFor(region: RegionRow): string | null {
  if (region.inat_place_id) return `place_id=${region.inat_place_id}`;
  const b = boundsOf(region.boundary_geojson);
  return b ? `swlat=${b.minLat}&swlng=${b.minLon}&nelat=${b.maxLat}&nelng=${b.maxLon}` : null;
}

/** 52 weekly counts of verifiable observations, or null when there are none. */
export async function fetchWeekly(inatTaxonId: number, region: RegionRow): Promise<number[] | null> {
  const where = whereFor(region);
  if (!where) return null;
  const { results } = await getJson<{ results: { week_of_year: Record<string, number> } }>(
    `${INAT_API}/observations/histogram?taxon_id=${inatTaxonId}&${where}&interval=week_of_year&date_field=observed&verifiable=true`,
  );
  const weeks = new Array<number>(52).fill(0);
  // ISO week 53 folds into the last week.
  for (const [week, count] of Object.entries(results.week_of_year)) weeks[Math.min(Number(week), 52) - 1] += count;
  return weeks.some((n) => n > 0) ? weeks : null;
}

/** The country a region is in (itself, for a country), or null outside any country. */
async function countryOf(regionId: string): Promise<string | null> {
  const res = await pool.query<{ id: string }>(
    `WITH RECURSIVE up AS (
       SELECT id, parent_id, sovereignty_group, 0 AS depth FROM regions WHERE id = $1
       UNION ALL
       SELECT r.id, r.parent_id, r.sovereignty_group, up.depth + 1 FROM regions r JOIN up ON r.id = up.parent_id
     )
     SELECT id FROM up WHERE sovereignty_group IS NOT NULL ORDER BY depth LIMIT 1`,
    [regionId],
  );
  return res.rows[0]?.id ?? null;
}

/** The regions to fetch for a species added to `regionId`, that region and its parents first: the
 *  country and its provinces or states (its larger groupings when there are too many). */
async function regionsToFetch(regionId: string, countryId: string | null): Promise<RegionRow[]> {
  const res = await pool.query<RegionRow & { kind: number }>(
    `WITH RECURSIVE up AS (
       SELECT id, parent_id, sovereignty_group FROM regions WHERE id = $1
       UNION ALL
       -- Up to the country, not past it to the continent and World.
       SELECT r.id, r.parent_id, r.sovereignty_group FROM regions r JOIN up ON r.id = up.parent_id
        WHERE up.sovereignty_group IS NULL
     ),
     children AS (SELECT * FROM regions WHERE $2::uuid IS NOT NULL AND parent_id = $2::uuid),
     subdivisions AS (
       SELECT id FROM children
        WHERE (SELECT count(*) FROM children) <= ${MAX_SUBDIVISIONS} OR has_children
     )
     SELECT r.id, r.name, r.inat_place_id, r.boundary_geojson,
            CASE WHEN r.id IN (SELECT id FROM up) THEN 0 ELSE 1 END AS kind
       FROM regions r
      WHERE r.id IN (SELECT id FROM up) OR r.id IN (SELECT id FROM subdivisions)
      ORDER BY kind, r.name`,
    [regionId, countryId],
  );
  return res.rows;
}

const inFlight = new Map<string, Promise<void>>();
// One sync at a time, one request after another, so a bulk import's syncs never crowd out the
// live lookups a person is waiting on (the shared client paces iNaturalist to one a second).
let queue: Promise<void> = Promise.resolve();

/** Fetches and stores everything for one species added to one region, skipping regions fetched
 *  within the year. One run per species and country at a time. Never throws. */
export function syncInatDistribution(speciesId: string, regionId: string): Promise<void> {
  const run = async () => {
    const species = (
      await pool.query<{ inat_taxon_id: number | null }>(
        `SELECT inat_taxon_id FROM species WHERE id = $1 AND is_other_taxa`,
        [speciesId],
      )
    ).rows[0];
    if (!species?.inat_taxon_id) return;
    const taxon = species.inat_taxon_id;
    const countryId = await countryOf(regionId);
    const fresh = new Set(
      (
        await pool.query<{ region_id: string }>(
          `SELECT region_id FROM inat_region_taxon_data
            WHERE species_id = $1 AND checked_at > now() - interval '${REFRESH_AFTER_DAYS} days'`,
          [speciesId],
        )
      ).rows.map((r) => r.region_id),
    );
    for (const region of await regionsToFetch(regionId, countryId)) {
      if (fresh.has(region.id)) continue;
      try {
        const weekly = await fetchWeekly(taxon, region);
        await pool.query(
          `INSERT INTO inat_region_taxon_data (species_id, region_id, weekly_frequency) VALUES ($1, $2, $3)
           ON CONFLICT (species_id, region_id) DO UPDATE SET weekly_frequency = EXCLUDED.weekly_frequency, checked_at = now()`,
          [speciesId, region.id, weekly],
        );
      } catch (err) {
        // The rest still runs; this region is tried again next time.
        log.warn({ err, speciesId, regionId: region.id }, "Couldn't fetch iNaturalist data for a region");
      }
    }
  };
  const key = `${speciesId}:${regionId}`;
  let job = inFlight.get(key);
  if (!job) {
    job = queue = queue
      .then(run)
      .catch((err) => log.warn({ err, speciesId }, "Couldn't fetch iNaturalist distribution"))
      .finally(() => inFlight.delete(key));
    inFlight.set(key, job);
  }
  return job;
}

/** Starts a sync for a hand-added species when the user has the any-taxa search opt-in. */
export async function scheduleInatDistributionSync(userId: string, speciesId: string, regionId: string) {
  const allowed = await pool.query(
    `SELECT 1 FROM users u, species s
      WHERE u.id = $1 AND u.any_taxa_search_enabled AND s.id = $2 AND s.is_other_taxa`,
    [userId, speciesId],
  );
  if (allowed.rowCount) void syncInatDistribution(speciesId, regionId);
}

/** The stored counts for `regionId`, from the nearest region up the tree that has some (a
 *  district gets its province's), with that region's name. */
export async function storedInatWeekly(
  speciesId: string,
  regionId: string,
): Promise<{ weeklyFrequency: number[]; regionName: string } | null> {
  const res = await pool.query<{ name: string; weekly_frequency: number[] }>(
    `WITH RECURSIVE up AS (
       SELECT id, parent_id, 0 AS depth FROM regions WHERE id = $2
       UNION ALL
       SELECT r.id, r.parent_id, up.depth + 1 FROM regions r JOIN up ON r.id = up.parent_id
     )
     SELECT r.name, d.weekly_frequency
       FROM up JOIN inat_region_taxon_data d ON d.region_id = up.id AND d.species_id = $1
       JOIN regions r ON r.id = up.id
      WHERE d.weekly_frequency IS NOT NULL
      ORDER BY up.depth LIMIT 1`,
    [speciesId, regionId],
  );
  const row = res.rows[0];
  return row ? { weeklyFrequency: row.weekly_frequency, regionName: row.name } : null;
}
