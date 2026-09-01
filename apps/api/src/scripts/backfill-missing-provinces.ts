// The /regions/:id/drill-down route (regions/routes.ts) creates a country's provinces on
// first view, then sets has_children = true unconditionally so it never re-fetches — a
// deliberate one-time-only design (see that route's own comment). Confirmed live: several
// countries' very first drill-down call happened against an incomplete admin1 result (a
// transient fetch gap, or a Natural Earth data revision that later gained rows for that
// country), and since has_children is a permanent flag, the gap never gets revisited. Found
// live via a real user report — the US was missing Florida, Georgia, Maryland, and Montana
// entirely — then confirmed 154 of 670 already-drilled-down countries have the same gap, ranging
// from a single missing entry (e.g. Angola's Cabinda exclave) to nearly all of them (Portugal
// had 5 of 20). This script re-fetches every has_children=true country's provinces and inserts
// whatever's missing — the existing ON CONFLICT (name, parent_id) DO NOTHING makes this safe to
// run repeatedly, matching every other redownload/reapply path's own idempotency guarantee.
import { pool } from "../db.js";
import { fetchProvincesForCountry } from "data-pipeline/src/fetch/fetch-region-boundary.js";

async function main() {
  const countriesRes = await pool.query<{ id: string; name: string; external_codes: string[] }>(
    `SELECT id, name, external_codes FROM regions
     WHERE has_children = true AND external_codes IS NOT NULL AND array_length(external_codes, 1) > 0`,
  );
  console.log(`[backfill-provinces] checking ${countriesRes.rows.length} countries`);

  let countriesWithGaps = 0;
  let totalCreated = 0;
  let fetchErrors = 0;

  for (const country of countriesRes.rows) {
    const iso3 = country.external_codes[0];
    let provinces;
    try {
      provinces = await fetchProvincesForCountry(iso3);
    } catch (err) {
      fetchErrors++;
      console.log(`[backfill-provinces] ${country.name} (${iso3}): fetch error — ${(err as Error).message}`);
      continue;
    }
    if (provinces.length === 0) continue;

    let createdForCountry = 0;
    for (const province of provinces) {
      const r = await pool.query(
        `INSERT INTO regions (name, parent_id, external_codes, ebird_region_code, boundary_geojson, is_overseas_territory)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (name, parent_id) DO NOTHING
         RETURNING id`,
        [
          province.name,
          country.id,
          province.iso3166_2 ? [province.iso3166_2] : [],
          province.iso3166_2 ?? null,
          JSON.stringify(province.feature),
          province.isOverseasTerritory,
        ],
      );
      if (r.rows.length > 0) createdForCountry++;
    }
    if (createdForCountry > 0) {
      countriesWithGaps++;
      totalCreated += createdForCountry;
      console.log(`[backfill-provinces] ${country.name}: created ${createdForCountry} missing province(s)`);
    }
  }

  console.log(
    `[backfill-provinces] done. ${countriesWithGaps} countries had gaps, ${totalCreated} province(s) created total, ` +
      `${fetchErrors} fetch error(s).`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
