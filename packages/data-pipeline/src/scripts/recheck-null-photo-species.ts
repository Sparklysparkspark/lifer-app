// Re-enriches species marked enriched_at but with no reference_photo, since a transient rate
// limit during enrichment can leave a species photoless. Only photos whose license allows
// publishing are used (enrichSpecies' publishableOnly), so a species whose iNaturalist photos are
// all "all rights reserved" stays photoless. Each species checked is stamped with
// photo_checked_at and skipped until it's older than --recheck-after-days, so those species don't
// spend iNaturalist's daily allowance on every refresh. Safe to re-run: persistEnrichment never
// overwrites existing data with NULL.
//
// Usage: npx tsx src/scripts/recheck-null-photo-species.ts [--listed-only] [--countries=Canada,France]
//          [--recheck-after-days=90]
import { pool } from "@lifer/core/db.js";
import { enrichSpecies, persistEnrichment, PersistentRateLimitError } from "@lifer/core/species/lazyEnrich.js";
import { mapWithConcurrency } from "@lifer/core/lib/concurrency.js";
import { applyPhotoLicensePolicy } from "../pipeline/photoLicensePolicy.js";
import { selectSpeciesToRecheck } from "../pipeline/photoRecheck.js";
import { RateLimitBreaker } from "../pipeline/rateLimitBreaker.js";

const CONCURRENCY = 4;

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

async function main() {
  // --countries= limits this to species on those countries' checklists; --listed-only to species
  // on any checklist or sea zone (what packs ship); neither means the whole catalog.
  const countries = arg("countries")?.split(",") ?? null;
  const listedOnly = process.argv.includes("--listed-only");
  const recheckAfterDays = Number(arg("recheck-after-days") ?? 90);
  if (!Number.isFinite(recheckAfterDays) || recheckAfterDays < 0) throw new Error("--recheck-after-days must be a number of days");

  const res = { rows: await selectSpeciesToRecheck(pool, { countries, listedOnly, recheckAfterDays }) };
  const scope = countries ? ` (scoped to ${countries.join(", ")})` : listedOnly ? " (listed species)" : "";
  console.log(`[recheck-null-photo] ${res.rows.length} enriched-but-photoless species to recheck${scope}`);

  let done = 0;
  let recovered = 0;
  let failed = 0;
  // When iNaturalist keeps refusing, the day's allowance is spent: stop, and let the next run carry
  // on (rate-limited species aren't stamped, so they come round again).
  const breaker = new RateLimitBreaker();
  let stopped = false;
  await mapWithConcurrency(res.rows, CONCURRENCY, async (row) => {
    if (stopped) return;
    try {
      const enrichment = await enrichSpecies({ id: row.id, scientific_name: row.scientific_name }, { publishableOnly: true });
      if (enrichment.referencePhoto) recovered++;
      await persistEnrichment(row.id, enrichment);
      await pool.query(`UPDATE species SET photo_checked_at = now() WHERE id = $1`, [row.id]);
      breaker.record(false);
    } catch (err) {
      failed++;
      if (err instanceof PersistentRateLimitError) {
        if (breaker.record(true) && !stopped) {
          stopped = true;
          console.warn("[recheck-null-photo] iNaturalist is refusing most requests; stopping until the next run");
        }
      } else {
        // A real failure for this species: stamp it, so it waits like any other checked species.
        await pool.query(`UPDATE species SET photo_checked_at = now() WHERE id = $1`, [row.id]);
        console.error(`[recheck-null-photo] FAILED ${row.scientific_name}:`, err);
      }
    }
    done++;
    if (done % 250 === 0) {
      console.log(`[recheck-null-photo] ${done}/${res.rows.length} (${recovered} recovered a photo, ${failed} failed)`);
    }
  });

  console.log(`[recheck-null-photo] done. ${done} processed, ${recovered} recovered a photo, ${failed} failed.`);
  // Belt and braces: enrichment above only takes publishable photos, but the policy is what the
  // publishing steps check for.
  await applyPhotoLicensePolicy(pool);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
