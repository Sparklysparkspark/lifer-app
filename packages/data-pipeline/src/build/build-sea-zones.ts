// Seeds the sea_zones table from Marine Ecoregions of the World (see fetch-marine-ecoregions.ts).
// Run once, or after MEOW data changes; species per zone are computed lazily by the API, like
// region_species.
import { pool } from "../db.js";
import { fetchMarineEcoregions } from "../fetch/fetch-marine-ecoregions.js";

async function main() {
  const zones = await fetchMarineEcoregions();
  // Existing zones and their per-zone checklists are replaced wholesale, not merged, so a region's
  // "nearby water" toggle never mixes ocean basins with ecoregions.
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
