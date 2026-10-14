// Fills regions.inat_place_id for every country and province that has none, so their checklists
// get checked against iNaturalist. Normally resolved on demand while a checklist builds; this
// catches up regions that failed before (abbreviated names, or a province whose country hadn't
// resolved) and is safe to rerun: already-resolved regions are skipped.
//
// Usage (from packages/data-pipeline): npx tsx src/scripts/resolve-inat-places.ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "@lifer/core/db.js";
import { resolveInatPlaceId } from "../regions/inatChecklist.js";
import { COUNTRIES_SQL, PROVINCES_WITH_COUNTRY_SQL } from "@lifer/core/regions/regionTree.js";

export async function resolveMissingInatPlaces(
  log: (m: string) => void = console.log,
): Promise<{ resolved: number; failed: string[] }> {
  // Countries, then their groups and provinces (country > group > province), each with its country.
  const rows = await pool.query<{
    id: string;
    name: string;
    is_country: boolean;
    country_id: string;
    country_place: number | null;
    country: string;
  }>(
    `WITH country AS (${COUNTRIES_SQL}),
     member AS (
       SELECT id, id AS country_id, true AS is_country FROM country
       UNION ALL SELECT p.id, p.country_id, false FROM (${PROVINCES_WITH_COUNTRY_SQL}) p
       UNION ALL SELECT g.id, g.parent_id, false FROM regions g JOIN country c ON c.id = g.parent_id
         WHERE EXISTS (SELECT 1 FROM regions k WHERE k.parent_id = g.id)
     )
     SELECT r.id, r.name, m.is_country, m.country_id, c.inat_place_id AS country_place, c.name AS country
     FROM member m JOIN regions r ON r.id = m.id JOIN regions c ON c.id = m.country_id
     WHERE r.inat_place_id IS NULL
       AND EXISTS (SELECT 1 FROM region_species rs WHERE rs.region_id = r.id)
     ORDER BY 3 DESC, c.name, r.name`,
  );
  let resolved = 0;
  const failed: string[] = [];
  // Countries come first, so a province can use its country's place resolved earlier in this run.
  const countryPlaces = new Map<string, number>();
  for (const r of rows.rows) {
    const isCountry = r.is_country === true;
    const countryPlace = isCountry ? null : (r.country_place ?? countryPlaces.get(r.country_id) ?? null);
    if (!isCountry && countryPlace == null) continue;
    const id = await resolveInatPlaceId(r.id, r.name, isCountry, countryPlace);
    if (id && isCountry) countryPlaces.set(r.id, id);
    if (id) resolved++;
    else failed.push(isCountry ? r.name : `${r.name} (${r.country})`);
    if ((resolved + failed.length) % 100 === 0)
      log(`[inat-places] ${resolved} resolved, ${failed.length} not found (latest: ${failed.slice(-3).join("; ")})`);
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
