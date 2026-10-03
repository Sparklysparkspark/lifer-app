// Re-runnable backfill: each species' global GBIF occurrence count and most recent occurrence
// year, for the "hide obscure/inaccessible species" filter's historical-rarity rule
// (species_traits.occurrence_count < 20 or last_occurrence_year < 1950, see migration 036).
// GBIF's records reach back to 1800s specimens, unlike iNaturalist's modern-only counts, so it
// can tell "never photographed" from "gone from the record". One request per species
// (facet=year on the count call).
import { pool } from "../db.js";
import { mapWithConcurrency } from "../concurrency.js";

const CONCURRENCY = 1;
// GBIF throttles this endpoint hard, so a fixed pause between every request (not just after a
// 429) keeps under its rate limit.
const REQUEST_INTERVAL_MS = 1500;

interface OccurrenceStats {
  count: number;
  lastYear: number | null;
}

async function fetchOccurrenceStats(gbifKey: number): Promise<OccurrenceStats | null> {
  const url = `https://api.gbif.org/v1/occurrence/search?taxonKey=${gbifKey}&limit=0&facet=year&facetLimit=300`;
  for (let attempt = 0; attempt <= 4; attempt++) {
    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      console.error(`  network error for gbifKey=${gbifKey} (attempt ${attempt}):`, err instanceof Error ? err.message : err);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
      console.error(`  429 for gbifKey=${gbifKey}, backing off ${Math.round(delayMs / 1000)}s`);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    if (!res.ok) {
      console.error(`  HTTP ${res.status} for gbifKey=${gbifKey}`);
      return null;
    }
    const data = (await res.json()) as {
      count: number;
      facets?: Array<{ field: string; counts: Array<{ name: string; count: number }> }>;
    };
    const yearFacet = data.facets?.[0]?.counts ?? [];
    const years = yearFacet.filter((c) => c.count > 0).map((c) => Number(c.name));
    const lastYear = years.length > 0 ? Math.max(...years) : null;
    return { count: data.count, lastYear };
  }
  console.error(`  giving up on gbifKey=${gbifKey} after retries`);
  return null;
}

async function main() {
  const onlyMissing = process.argv.includes("--only-missing");
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : null;
  const res = await pool.query<{ species_id: string; gbif_key: string; scientific_name: string }>(
    `SELECT s.id AS species_id, s.gbif_key, s.scientific_name
     FROM species s
     JOIN species_traits st ON st.species_id = s.id
     WHERE s.gbif_key IS NOT NULL ${onlyMissing ? "AND st.occurrence_count IS NULL" : ""}
     ORDER BY s.scientific_name
     ${limit ? `LIMIT ${limit}` : ""}`,
  );
  console.log(`[fetch-occurrence-stats] ${res.rows.length} species to check`);

  let done = 0;
  let failed = 0;
  await mapWithConcurrency(res.rows, CONCURRENCY, async (row) => {
    const stats = await fetchOccurrenceStats(Number(row.gbif_key));
    if (!stats) {
      failed++;
      return;
    }
    await pool.query(
      `UPDATE species_traits SET occurrence_count = $1, last_occurrence_year = $2 WHERE species_id = $3`,
      [stats.count, stats.lastYear, row.species_id],
    );
    await new Promise((r) => setTimeout(r, REQUEST_INTERVAL_MS));
    done++;
    if (done % 500 === 0) {
      console.log(`[fetch-occurrence-stats] ${done}/${res.rows.length} done, ${failed} failed so far`);
    }
  });

  console.log(`[fetch-occurrence-stats] done. ${done} updated, ${failed} failed.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
