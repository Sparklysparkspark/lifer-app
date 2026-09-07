// Drills every country worldwide into provinces/states (reusing compute-all-regions.ts's own
// drill-down step — most countries had never been split before this, only the handful used
// for earlier testing/development), then does a full pass over EVERY resulting region that
// carries external_codes (not just countries, and not just ones already computed — see
// recompute-stale-regions.ts for that narrower "already computed, refresh it" pass) so every
// checklist is genuinely up to date ahead of building offline packs from them, rather than
// waiting on the lazy on-first-view path. Sea zones get covered as a side effect:
// computeRegionOccurrences already calls ensureSeaZoneComputed for every zone bordering the
// region it's given (see regions/routes.ts), so this sweep computes essentially every relevant
// sea zone too, with no separate loop needed. Ordered continent/country/province rather than
// alphabetically so a failure partway through still leaves the coarser, more-used levels done
// first.
import { pool } from "../db.js";
import { computeRegionOccurrences } from "../regions/routes.js";
import { drillDownAllCountries } from "./compute-all-regions.js";
import { probeProvinceValue } from "./probe-province-value.js";

async function main() {
  // Drills every country that hasn't been split into provinces/states yet (most of them, as
  // of writing — only the handful used for earlier testing/development had this run before)
  // BEFORE the recompute query below, so newly created provinces are included in this same
  // pass rather than needing a second run.
  console.log(`[recompute-all-regions] drilling down every country into provinces/states first...`);
  await drillDownAllCountries();

  // Cheap density probe BEFORE the expensive pass below — a country whose provinces come back
  // near-empty (see probe-province-value.ts's own comment: Thailand's first 3 provinces all
  // computed to zero real species, at real GBIF-call cost each) gets its provinces excluded
  // from the full computation entirely, rather than spending the full ~30-100+ calls/region
  // pass just to confirm what a ~2-call/region probe already showed.
  console.log(`[recompute-all-regions] probing province-level data density before the full pass...`);
  await probeProvinceValue();

  const res = await pool.query(
    `WITH RECURSIVE depth(id, level) AS (
       SELECT id, 0 FROM regions WHERE parent_id IS NULL
       UNION ALL
       SELECT r.id, d.level + 1 FROM regions r JOIN depth d ON r.parent_id = d.id
     )
     SELECT r.id, r.name, r.boundary_geojson, r.external_codes, r.occurrence_computed_at
     FROM regions r JOIN depth d ON d.id = r.id
     WHERE r.external_codes IS NOT NULL AND array_length(r.external_codes, 1) > 0
       AND r.province_split_meaningful IS NOT FALSE
     ORDER BY d.level, r.name`,
  );
  console.log(`[recompute-all-regions] ${res.rows.length} regions to recompute (every level, worldwide)`);

  let done = 0;
  let failed = 0;
  for (const region of res.rows) {
    const before = await pool.query(`SELECT count(*) FROM region_species WHERE region_id = $1`, [region.id]);
    try {
      await computeRegionOccurrences(region);
    } catch (err) {
      failed++;
      console.error(`[recompute-all-regions] FAILED ${region.name}:`, err);
      continue;
    }
    const after = await pool.query(`SELECT count(*) FROM region_species WHERE region_id = $1`, [region.id]);
    done++;
    console.log(
      `[recompute-all-regions] ${done + failed}/${res.rows.length} ${region.name}: ${before.rows[0].count} -> ${after.rows[0].count} species`,
    );
  }
  console.log(`[recompute-all-regions] done. ${done} recomputed, ${failed} failed.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
