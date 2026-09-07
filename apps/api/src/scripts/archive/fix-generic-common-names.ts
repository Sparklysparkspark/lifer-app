// Fixes species whose common_name is a generic family/group-level term (e.g. "Anchovy", "Eel",
// "Goby") rather than anything species-specific — GBIF's own vernacular-name data genuinely
// only has that generic term for these species (confirmed: not an extraction bug, see
// fetch-gbif-vernacular.ts), but showing e.g. "Eel" as if it were this species' name is less
// useful than the scientific name. Tries iNaturalist's preferred_common_name first (often has a
// more specific name GBIF's checklists don't carry); falls back to nulling common_name out
// so the app displays the scientific name instead of a misleadingly generic one.
import { pool } from "../db.js";
import { mapWithConcurrency } from "data-pipeline/src/concurrency.js";

const CONCURRENCY = 3;
const GENERIC_NAME_PATTERN =
  /^(Eel|Shark|Ray|Fish|Goby|Skate|Snake Eel|Moray|Moray Eel|Anchovy|Herring|Conger|Cusk-Eel|Cusk Eel)$/;

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
    const data = (await res.json()) as { results: Array<{ name: string; preferred_common_name?: string }> };
    const exact = data.results.find((r) => r.name.toLowerCase() === scientificName.toLowerCase());
    return exact?.preferred_common_name ?? null;
  }
  console.error(`  giving up on ${scientificName} after retries`);
  return null;
}

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
    `SELECT id, common_name, scientific_name FROM species WHERE taxon_class = 'actinopterygii' AND common_name ~ $1`,
    [GENERIC_NAME_PATTERN.source],
  );
  console.log(`${res.rows.length} species with a generic family-level common_name\n`);

  let improved = 0;
  let nulled = 0;
  await mapWithConcurrency(res.rows, CONCURRENCY, async (row) => {
    const realName = await preferredCommonName(row.scientific_name);
    if (realName && !GENERIC_NAME_PATTERN.test(realName)) {
      const titled = titleCase(realName);
      console.log(`  IMPROVE: ${row.common_name} -> ${titled}  (${row.scientific_name})`);
      if (!dryRun) await pool.query(`UPDATE species SET common_name = $1 WHERE id = $2`, [titled, row.id]);
      improved++;
    } else {
      console.log(`  NULL: ${row.common_name} (${row.scientific_name}) — no better name found`);
      if (!dryRun) await pool.query(`UPDATE species SET common_name = NULL WHERE id = $1`, [row.id]);
      nulled++;
    }
  });

  console.log(`\n${dryRun ? "Would improve" : "Improved"} ${improved}, ${dryRun ? "would null" : "nulled"} ${nulled}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => pool.end());
