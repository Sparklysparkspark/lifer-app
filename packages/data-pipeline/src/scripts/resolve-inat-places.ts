// Fills regions.inat_place_id for every country and province that has none, so their checklists
// get checked against iNaturalist. Normally resolved on demand while a checklist builds; this
// catches up regions that failed before (abbreviated names, or a province whose country hadn't
// resolved) and is safe to rerun: already-resolved regions are skipped.
//
// Usage (from packages/data-pipeline): npx tsx src/scripts/resolve-inat-places.ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "@lifer/core/db.js";
import { resolveInatPlaceId } from "@lifer/core/regions/inatChecklist.js";

export async function resolveMissingInatPlaces(log: (m: string) => void = console.log): Promise<{ resolved: number; failed: string[] }> {
  // Countries sit two levels under World; provinces directly under a country.
  const rows = await pool.query<{ id: string; name: string; is_country: boolean; parent_id: string; country_place: number | null; country: string }>(
    `WITH country AS (
       SELECT c.id FROM regions c JOIN regions cont ON cont.id = c.parent_id JOIN regions w ON w.id = cont.parent_id AND w.parent_id IS NULL
     )
     SELECT r.id, r.name, (r.id IN (SELECT id FROM country)) AS is_country, r.parent_id, p.inat_place_id AS country_place, p.name AS country
     FROM regions r JOIN regions p ON p.id = r.parent_id
     WHERE r.inat_place_id IS NULL
       AND (r.id IN (SELECT id FROM country) OR r.parent_id IN (SELECT id FROM country))
       AND EXISTS (SELECT 1 FROM region_species rs WHERE rs.region_id = r.id)
     ORDER BY 3 DESC, p.name, r.name`,
  );
  let resolved = 0;
  const failed: string[] = [];
  // Countries come first, so a province can use its country's place resolved earlier in this run.
  const countryPlaces = new Map<string, number>();
  for (const r of rows.rows) {
    const isCountry = r.is_country === true;
    const countryPlace = isCountry ? null : (r.country_place ?? countryPlaces.get(r.parent_id) ?? null);
    if (!isCountry && countryPlace == null) continue;
    const id = await resolveInatPlaceId(r.id, r.name, isCountry, countryPlace);
    if (id && isCountry) countryPlaces.set(r.id, id);
    if (id) resolved++;
    else failed.push(isCountry ? r.name : `${r.name} (${r.country})`);
    if ((resolved + failed.length) % 100 === 0) log(`[inat-places] ${resolved} resolved, ${failed.length} not found (latest: ${failed.slice(-3).join("; ")})`);
  }
  return { resolved, failed };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  resolveMissingInatPlaces()
    .then(async (r) => {
      console.log(`[inat-places] ${r.resolved} resolved, ${r.failed.length} not found`);
      if (r.failed.length) console.log(`[inat-places] not found: ${r.failed.join("; ")}`);
      await pool.end();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
