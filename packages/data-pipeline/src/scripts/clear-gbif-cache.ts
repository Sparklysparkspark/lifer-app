// Clears the raw GBIF response cache (migration 040 / fetch-with-retry.ts) when a genuinely fresh
// pull is wanted. Re-deriving a checklist after a filtering fix should reuse the cache instead.
//
// Usage:
//   npx tsx src/scripts/clear-gbif-cache.ts                 clear everything
//   npx tsx src/scripts/clear-gbif-cache.ts --like=EGY      clear only URLs containing "EGY"
//     (e.g. one country's gadmGid code, to refresh just that region)
import { pool } from "../db.js";

async function main() {
  const likeArg = process.argv.find((a) => a.startsWith("--like="));
  const pattern = likeArg ? likeArg.split("=")[1] : null;

  const res = pattern
    ? await pool.query(`DELETE FROM gbif_response_cache WHERE url LIKE $1`, [`%${pattern}%`])
    : await pool.query(`DELETE FROM gbif_response_cache`);

  console.log(
    `[clear-gbif-cache] deleted ${res.rowCount} cached response(s)${pattern ? ` matching "${pattern}"` : ""}.`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
