// Clears the raw-GBIF-response cache (migration 040 / fetch-with-retry.ts) — for when a
// genuinely fresh pull is wanted (e.g. periodically, or because GBIF's underlying data itself
// changed), as opposed to the normal case of re-deriving a region's checklist from the same
// raw data after fixing a filtering bug, which should NOT clear the cache.
//
// Usage:
//   npx tsx src/scripts/clear-gbif-cache.ts                 — clear everything
//   npx tsx src/scripts/clear-gbif-cache.ts --like=EGY       — clear only URLs containing "EGY"
//     (e.g. one country's gadmGid code, to force-refresh just that region)
import { pool } from "../db.js";

async function main() {
  const likeArg = process.argv.find((a) => a.startsWith("--like="));
  const pattern = likeArg ? likeArg.split("=")[1] : null;

  const res = pattern
    ? await pool.query(`DELETE FROM gbif_response_cache WHERE url LIKE $1`, [`%${pattern}%`])
    : await pool.query(`DELETE FROM gbif_response_cache`);

  console.log(`[clear-gbif-cache] deleted ${res.rowCount} cached response(s)${pattern ? ` matching "${pattern}"` : ""}.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
