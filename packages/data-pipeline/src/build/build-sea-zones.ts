// Replaces the sea_zones table's contents with a new set of zones (IHO Sea Areas, see
// fetch-iho-sea-areas.ts) and relinks every region to them. Run through
// scripts/replace-sea-zones.ts. Species per zone are computed afterwards, by apps/api's
// compute-sea-zones.ts.
import type { PoolClient } from "pg";
import type { SeaZone } from "../fetch/fetch-iho-sea-areas.js";
import { exteriorRingsFromGeometry } from "@lifer/core/lib/geometry.js";
import { ZoneSegmentIndex } from "./nearby-sea-zones.js";

export interface ReplaceSeaZonesResult {
  kept: number;
  removed: string[];
  inserted: string[];
  // sea_zone_species rows that went with the removed zones (ON DELETE CASCADE).
  speciesRowsRemoved: number;
  // This database's own downloaded_packs bookkeeping for packs of removed zones.
  downloadedPacksRemoved: string[];
  regionsLinked: number;
  regionsWithZones: number;
}

export async function replaceSeaZones(client: PoolClient, zones: SeaZone[], log: (m: string) => void = () => {}): Promise<ReplaceSeaZonesResult> {
  const byName = new Map<string, SeaZone>();
  for (const z of zones) {
    if (byName.has(z.name)) throw new Error(`Two sea zones are named "${z.name}"; names must be unique (packs are keyed by them)`);
    byName.set(z.name, z);
  }

  // A zone whose name and shape are both unchanged keeps its id and its computed species. Any
  // other zone goes, even one whose new namesake is about to be inserted: its species were
  // computed for the old shape, and a new id makes installs drop the old row on their next
  // catalog update instead of keeping the old shape's checklist under the new name.
  const existing = await client.query<{ id: string; name: string; wkt: string }>(`SELECT id, name, wkt FROM sea_zones`);
  const keep = existing.rows.filter((r) => byName.get(r.name)?.wkt === r.wkt);
  const keepNames = new Set(keep.map((r) => r.name));
  const removed = existing.rows.filter((r) => !keepNames.has(r.name));

  const removedIds = removed.map((r) => r.id);
  const speciesRes = await client.query<{ n: string }>(`SELECT count(*) AS n FROM sea_zone_species WHERE sea_zone_id = ANY($1)`, [removedIds]);
  await client.query(`DELETE FROM sea_zones WHERE id = ANY($1)`, [removedIds]);
  // A sea zone pack's downloaded_packs row names its zone in `region` (offlinePacks/download.ts).
  // Its pack_species rows cascade. Only matters on a database that downloaded packs itself.
  const packsRes = await client.query<{ pack_id: string }>(
    `DELETE FROM downloaded_packs WHERE pack_id LIKE 'seazone-%' AND region = ANY($1) RETURNING pack_id`,
    [removed.map((r) => r.name)],
  );

  const inserted: string[] = [];
  for (const zone of zones) {
    if (keepNames.has(zone.name)) continue;
    await client.query(
      `INSERT INTO sea_zones (name, wkt, bbox_min_lon, bbox_min_lat, bbox_max_lon, bbox_max_lat)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [zone.name, zone.wkt, zone.bbox.minLon, zone.bbox.minLat, zone.bbox.maxLon, zone.bbox.maxLat],
    );
    inserted.push(zone.name);
  }
  log(`${keep.length} zone(s) unchanged, ${removed.length} removed, ${inserted.length} inserted`);

  const { regionsLinked, regionsWithZones } = await relinkRegions(client, zones, log);
  return {
    kept: keep.length,
    removed: removed.map((r) => r.name),
    inserted,
    speciesRowsRemoved: Number(speciesRes.rows[0].n),
    downloadedPacksRemoved: packsRes.rows.map((r) => r.pack_id),
    regionsLinked,
    regionsWithZones,
  };
}

// Every region's nearby_sea_zone_ids, from the zones' full-resolution outlines. Stale ids would
// point at deleted zones, so a region without a boundary is reset to NULL (the API then offers it
// no zones, as before).
async function relinkRegions(client: PoolClient, zones: SeaZone[], log: (m: string) => void): Promise<{ regionsLinked: number; regionsWithZones: number }> {
  const idsRes = await client.query<{ id: string; name: string }>(`SELECT id, name FROM sea_zones`);
  const idByName = new Map(idsRes.rows.map((r) => [r.name, r.id]));
  const index = new ZoneSegmentIndex(
    zones.filter((z) => idByName.has(z.name)).map((z) => ({ id: idByName.get(z.name)!, ring: z.outline })),
  );
  const regions = await client.query<{ id: string; geometry: { type: string; coordinates: unknown } | null }>(
    `SELECT id, boundary_geojson->'geometry' AS geometry FROM regions`,
  );
  let regionsLinked = 0;
  let regionsWithZones = 0;
  for (const region of regions.rows) {
    const ids = region.geometry ? index.nearbyZoneIds(exteriorRingsFromGeometry(region.geometry)) : null;
    await client.query(`UPDATE regions SET nearby_sea_zone_ids = $1 WHERE id = $2`, [ids, region.id]);
    if (ids) regionsLinked++;
    if (ids && ids.length > 0) regionsWithZones++;
    if (regionsLinked > 0 && regionsLinked % 500 === 0) log(`linked ${regionsLinked}/${regions.rows.length} regions`);
  }
  log(`linked ${regionsLinked} region(s) with a boundary, ${regionsWithZones} of them to at least one sea zone`);
  return { regionsLinked, regionsWithZones };
}
