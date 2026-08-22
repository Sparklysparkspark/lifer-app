// Seeds the sea_zones table from Marine Ecoregions of the World (see
// fetch-marine-ecoregions.ts) — replaces the earlier Natural Earth ocean-basin zones, which
// were far too coarse (e.g. "North Pacific Ocean" spanning the entire
// basin from Japan to Mexico). Run once (or after MEOW data changes); species per zone are
// computed lazily by the API, same pattern as region_species, not eagerly here.
import { pool } from "../db.js";
import { fetchMarineEcoregions } from "../fetch/fetch-marine-ecoregions.js";

async function main() {
  const zones = await fetchMarineEcoregions();
  // Old Natural-Earth-sourced zones (and their now-stale per-zone fish checklists) are
  // replaced wholesale, not merged — MEOW's ecoregions are a full replacement, not an
  // addition, and keeping both would mean a region's "nearby water" toggle could pull in
  // both a giant ocean basin AND its finer-grained replacement.
  const deleted = await pool.query(`DELETE FROM sea_zones WHERE name NOT IN (SELECT unnest($1::text[]))`, [
    zones.map((z) => z.name),
  ]);
  console.log(`[build-sea-zones] removed ${deleted.rowCount} stale (pre-MEOW) zones`);

  let inserted = 0;
  for (const zone of zones) {
    await pool.query(
      `INSERT INTO sea_zones (name, wkt, bbox_min_lon, bbox_min_lat, bbox_max_lon, bbox_max_lat)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (name) DO UPDATE SET
         wkt = EXCLUDED.wkt, bbox_min_lon = EXCLUDED.bbox_min_lon, bbox_min_lat = EXCLUDED.bbox_min_lat,
         bbox_max_lon = EXCLUDED.bbox_max_lon, bbox_max_lat = EXCLUDED.bbox_max_lat`,
      [zone.name, zone.wkt, zone.bbox.minLon, zone.bbox.minLat, zone.bbox.maxLon, zone.bbox.maxLat],
    );
    inserted++;
  }
  console.log(`[build-sea-zones] upserted ${inserted} sea zones`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
