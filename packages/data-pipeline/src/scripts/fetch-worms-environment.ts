// Fills species_traits.worms_* (marine, brackish, freshwater, terrestrial) from WoRMS for the
// species sea zone checklists can include: fish and marine mammals. Re-runnable: only species
// never checked, or checked more than --recheck-after-days ago (default 180), are looked up, and
// each batch is saved as it goes, so a stopped run continues where it left off.
//
//   npx tsx src/scripts/fetch-worms-environment.ts
//   npx tsx src/scripts/fetch-worms-environment.ts --recheck-after-days=0 --limit=500
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORMS_BATCH_SIZE, fetchEnvironments } from "../pipeline/wormsEnvironment.js";
import { RateLimitBreaker } from "../pipeline/rateLimitBreaker.js";

// The same species compute-sea-zones-offline.ts considers: bony and cartilaginous fish (the
// catalog files every fish under actinopterygii) and the whales, dolphins and sirenians.
const MARINE_MAMMAL_ORDERS = ["Cetacea", "Sirenia"];
const MARINE_MAMMAL_FAMILIES = [
  "Balaenidae",
  "Balaenopteridae",
  "Delphinidae",
  "Eschrichtiidae",
  "Iniidae",
  "Kogiidae",
  "Lipotidae",
  "Monodontidae",
  "Neobalaenidae",
  "Phocoenidae",
  "Physeteridae",
  "Platanistidae",
  "Pontoporiidae",
  "Ziphiidae",
  "Dugongidae",
  "Trichechidae",
];
// WoRMS asks API users to keep requests modest; one batch of 50 names a second is well within it.
const REQUEST_INTERVAL_MS = 1000;

function parseArgs(argv: string[]) {
  const value = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  return {
    recheckAfterDays: Number(value("recheck-after-days") ?? 180),
    limit: value("limit") ? Number(value("limit")) : null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { pool } = await import("../db.js");
  try {
    const res = await pool.query<{ species_id: string; scientific_name: string }>(
      `SELECT s.id AS species_id, s.scientific_name
       FROM species s JOIN species_traits t ON t.species_id = s.id
       WHERE (s.taxon_class = 'actinopterygii' OR s.taxon_order = ANY($1) OR s.family = ANY($2))
         AND (t.worms_checked_at IS NULL OR t.worms_checked_at < now() - make_interval(days => $3))
       ORDER BY s.scientific_name
       ${args.limit ? `LIMIT ${Math.floor(args.limit)}` : ""}`,
      [MARINE_MAMMAL_ORDERS, MARINE_MAMMAL_FAMILIES, args.recheckAfterDays],
    );
    const rows = res.rows;
    console.log(`[fetch-worms-environment] ${rows.length} species to look up`);
    const breaker = new RateLimitBreaker(10, 0.5);
    let done = 0;
    let unknown = 0;
    for (let i = 0; i < rows.length; i += WORMS_BATCH_SIZE) {
      const batch = rows.slice(i, i + WORMS_BATCH_SIZE);
      let envs;
      for (let attempt = 0; ; attempt++) {
        try {
          envs = await fetchEnvironments(batch.map((r) => r.scientific_name));
          breaker.record(false);
          break;
        } catch (err) {
          const status = (err as { status?: number }).status;
          const limited = status === 429 || (status != null && status >= 500);
          if (breaker.record(limited)) {
            console.error(
              `[fetch-worms-environment] WoRMS keeps refusing; stopping. ${done} saved, rerun to continue.`,
            );
            return;
          }
          if (attempt >= 4) throw err;
          await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
        }
      }
      await pool.query(
        `UPDATE species_traits t SET
           worms_aphia_id = v.aphia_id, worms_is_marine = v.marine, worms_is_brackish = v.brackish,
           worms_is_freshwater = v.freshwater, worms_is_terrestrial = v.terrestrial, worms_checked_at = now()
         FROM unnest($1::uuid[], $2::int[], $3::bool[], $4::bool[], $5::bool[], $6::bool[])
           AS v(species_id, aphia_id, marine, brackish, freshwater, terrestrial)
         WHERE t.species_id = v.species_id`,
        [
          batch.map((r) => r.species_id),
          envs.map((e) => e?.aphiaId ?? null),
          envs.map((e) => e?.marine ?? null),
          envs.map((e) => e?.brackish ?? null),
          envs.map((e) => e?.freshwater ?? null),
          envs.map((e) => e?.terrestrial ?? null),
        ],
      );
      done += batch.length;
      unknown += envs.filter((e) => e === null).length;
      if ((i / WORMS_BATCH_SIZE) % 20 === 0) console.log(`[fetch-worms-environment] ${done}/${rows.length}`);
      await new Promise((r) => setTimeout(r, REQUEST_INTERVAL_MS));
    }
    console.log(`[fetch-worms-environment] done: ${done} looked up, ${unknown} not known to WoRMS`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
