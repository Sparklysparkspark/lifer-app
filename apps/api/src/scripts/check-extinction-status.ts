// Verifies "possibly extinct" candidates against GBIF's IUCN-sourced distribution data
// (species/{gbifKey}/distributions — confirmed reliable this session for Acanthobrama
// centisquama/Long-spine Bream: threatStatus "EXTINCT" from source "The IUCN Red List of
// Threatened Species") and flags fully_extinct when confirmed. Scoped to a real signal, not
// "no photo" alone — no_photo touches ~46k species and mostly just means genuinely obscure,
// not extinct. Narrowed to species that are ALSO historically rare by our own occurrence data
// (migration 036: occurrence_count < 20 or last_occurrence_year < 1990) — the same profile
// that actually caught the Bream. Re-runnable: only ever queries species not yet checked
// (migration 039), so it can be re-run periodically as fetch-occurrence-stats.ts's backfill
// fills in more species and the candidate pool grows.
import { pool } from "../db.js";
import { mapWithConcurrency } from "data-pipeline/src/concurrency.js";

const CONCURRENCY = 2;

async function fetchIucnThreatStatus(gbifKey: number): Promise<string | null> {
  const url = `https://api.gbif.org/v1/species/${gbifKey}/distributions`;
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
    if (!res.ok) return null;
    const data = (await res.json()) as {
      results: Array<{ locality?: string; status?: string; threatStatus?: string; source?: string }>;
    };
    const iucn = data.results.find((r) => r.source === "The IUCN Red List of Threatened Species" && r.threatStatus);
    return iucn?.threatStatus ?? null;
  }
  console.error(`  giving up on gbifKey=${gbifKey} after retries`);
  return null;
}

async function main() {
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : null;
  const res = await pool.query<{ species_id: string; gbif_key: string; scientific_name: string; common_name: string | null }>(
    `SELECT s.id AS species_id, s.gbif_key, s.scientific_name, s.common_name
     FROM species s
     LEFT JOIN species_traits t ON t.species_id = s.id
     LEFT JOIN species_rarity r ON r.species_id = s.id
     WHERE (s.reference_photo IS NULL OR r.tier = 'legendary')
       AND COALESCE(t.fully_extinct, false) = false
       AND t.extinction_checked_at IS NULL
       AND t.occurrence_count IS NOT NULL
       AND (t.occurrence_count < 20 OR t.last_occurrence_year < 1990)
     ORDER BY s.scientific_name
     ${limit ? `LIMIT ${limit}` : ""}`,
  );
  console.log(`[check-extinction] ${res.rows.length} candidates to check against GBIF/IUCN`);

  let checked = 0;
  let flagged = 0;
  await mapWithConcurrency(res.rows, CONCURRENCY, async (row) => {
    const status = await fetchIucnThreatStatus(Number(row.gbif_key));
    if (status === "EXTINCT") {
      await pool.query(
        `UPDATE species_traits SET fully_extinct = true, iucn_status = 'extinct', extinction_checked_at = now() WHERE species_id = $1`,
        [row.species_id],
      );
      console.log(`  EXTINCT: ${row.common_name ?? row.scientific_name} (${row.scientific_name})`);
      flagged++;
    } else {
      await pool.query(`UPDATE species_traits SET extinction_checked_at = now() WHERE species_id = $1`, [row.species_id]);
    }
    checked++;
    if (checked % 100 === 0) console.log(`[check-extinction] ${checked}/${res.rows.length} (${flagged} flagged extinct so far)`);
  });

  console.log(`[check-extinction] done. ${checked} checked, ${flagged} newly flagged extinct.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
