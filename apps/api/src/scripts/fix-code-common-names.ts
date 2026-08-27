// Fixes species whose common_name is actually a raw banding/ringing alpha code (SAFRING-style
// 4-6 letter codes, mostly on African species — e.g. "BEWO" for Bearded Woodpecker) instead of
// a real English name — a data-pipeline bug where a fallback common-name source apparently
// returned the wrong kind of value. Looks up the real name via iNaturalist's
// preferred_common_name field (keyed by scientific_name, which is unaffected by this bug).
import { pool } from "../db.js";
import { mapWithConcurrency } from "data-pipeline/src/concurrency.js";

const CONCURRENCY = 3;
const ALPHA_CODE_PATTERN = /^[A-Z]{3,7}$/;

async function preferredCommonName(scientificName: string): Promise<string | null> {
  for (let attempt = 0; attempt <= 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(
        `https://api.inaturalist.org/v1/taxa?q=${encodeURIComponent(scientificName)}&rank=species&is_active=true&per_page=5`,
      );
    } catch (err) {
      console.error(`  network error for ${scientificName} (attempt ${attempt}):`, err instanceof Error ? err.message : err);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
      console.error(`  429 for ${scientificName}, backing off ${Math.round(delayMs / 1000)}s`);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    if (!res.ok) {
      console.error(`  HTTP ${res.status} for ${scientificName}`);
      return null;
    }
    const data = (await res.json()) as {
      results: Array<{ name: string; preferred_common_name?: string }>;
    };
    const exact = data.results.find((r) => r.name.toLowerCase() === scientificName.toLowerCase());
    return exact?.preferred_common_name ?? null;
  }
  console.error(`  giving up on ${scientificName} after retries`);
  return null;
}

// Title-cases iNaturalist's name to match this app's existing common_name convention, which
// capitalizes after hyphens too (e.g. "Green-Winged Teal", not "Green-winged Teal").
function titleCase(name: string): string {
  return name
    .split(" ")
    .map((word) =>
      word
        .split("-")
        .map((part) => (part.length > 0 ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : part))
        .join("-"),
    )
    .join(" ");
}

async function main() {
  const dryRun = !process.argv.includes("--apply");

  const res = await pool.query<{ id: string; common_name: string; scientific_name: string }>(
    `SELECT id, common_name, scientific_name FROM species WHERE common_name ~ '^[A-Z]{3,7}$'`,
  );
  console.log(`${res.rows.length} species with an alpha-code-looking common_name\n`);

  let fixed = 0;
  let failed = 0;
  await mapWithConcurrency(res.rows, CONCURRENCY, async (row) => {
    const realName = await preferredCommonName(row.scientific_name);
    if (!realName) {
      console.error(`  NO MATCH: [${row.common_name}] ${row.scientific_name}`);
      failed++;
      return;
    }
    const titled = titleCase(realName);
    console.log(`  ${row.common_name} -> ${titled}  (${row.scientific_name})`);
    if (!dryRun) {
      await pool.query(`UPDATE species SET common_name = $1 WHERE id = $2`, [titled, row.id]);
    }
    fixed++;
  });

  console.log(`\n${dryRun ? "Would fix" : "Fixed"} ${fixed}, ${failed} had no iNaturalist match (left as-is).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => pool.end());
