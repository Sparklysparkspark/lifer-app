// One-off, scoped version of compute-all-regions.ts for exactly the two countries being
// prioritized for the first pack release (see ~/.claude/plans — Finland + Canada ready first,
// ahead of the full 298-region sweep). Finland has never been computed at all (country row
// AND all 18 provinces); Canada already has 3 of 13 provinces done from earlier work — this
// only computes what's still missing, safe to re-run.
import { pool } from "../db.js";
import { computeRegionOccurrences } from "../regions/routes.js";

interface RegionRow {
  id: string;
  name: string;
  boundary_geojson: { bbox?: [number, number, number, number]; geometry?: { type: string; coordinates: unknown } } | null;
  external_codes: string[] | null;
}

async function computeIfNeeded(region: RegionRow): Promise<void> {
  const already = await pool.query<{ occurrence_computed_at: Date | null }>(
    `SELECT occurrence_computed_at FROM regions WHERE id = $1`,
    [region.id],
  );
  if (already.rows[0]?.occurrence_computed_at) {
    console.log(`[compute-finland-canada] ${region.name}: already computed, skipping`);
    return;
  }
  try {
    await computeRegionOccurrences(region);
    console.log(`[compute-finland-canada] ${region.name}: computed`);
  } catch (err) {
    console.error(`[compute-finland-canada] FAILED ${region.name}:`, err);
  }
}

async function computeCountryAndProvinces(countryName: string): Promise<void> {
  const countryRes = await pool.query<RegionRow>(
    `SELECT id, name, boundary_geojson, external_codes FROM regions WHERE name = $1 AND parent_id IS NOT NULL`,
    [countryName],
  );
  const country = countryRes.rows[0];
  if (!country) {
    console.error(`[compute-finland-canada] No country row found for "${countryName}"`);
    return;
  }
  await computeIfNeeded(country);

  const provincesRes = await pool.query<RegionRow>(
    `SELECT id, name, boundary_geojson, external_codes FROM regions WHERE parent_id = $1 ORDER BY name`,
    [country.id],
  );
  console.log(`[compute-finland-canada] ${countryName}: ${provincesRes.rows.length} province(s) to check`);
  for (const province of provincesRes.rows) {
    await computeIfNeeded(province);
  }
}

async function main() {
  await computeCountryAndProvinces("Finland");
  await computeCountryAndProvinces("Canada");
  console.log("[compute-finland-canada] done.");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
