// Photos, gallery and description for every species on a region checklist that has no photo,
// 30 species to an iNaturalist request (/v1/taxa/{ids} returns each one's default photo, taxon
// photos and Wikipedia summary together), far fewer requests than the one-at-a-time path
// (enrich-all-species.ts). Same result: each record goes through lazyEnrich's own assembly, image
// caching and persistEnrichment. Species whose catalog taxon id iNaturalist doesn't return are left
// for the one-at-a-time path, which searches by name.
//
// Usage (from apps/api): npx tsx src/scripts/enrich-listed-batch.ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../db.js";
import { enrichmentFromTaxonRecord, persistEnrichment, type INaturalistTaxonRecord } from "../species/lazyEnrich.js";
import { mapWithConcurrency } from "data-pipeline/src/concurrency.js";
import { inatGet } from "data-pipeline/src/inatApi.js";

const BATCH = 30;
// Image downloads come from iNaturalist's photo storage, not its API, so a few run at once.
const DOWNLOAD_CONCURRENCY = 12;

async function fetchTaxa(ids: number[]): Promise<INaturalistTaxonRecord[] | null> {
  try {
    return (await inatGet<{ results: INaturalistTaxonRecord[] }>(`https://api.inaturalist.org/v1/taxa/${ids.join(",")}`)).results;
  } catch {
    return null;
  }
}

export async function enrichListedBatch(log: (m: string) => void = console.log): Promise<{ enriched: number; photos: number; missing: number }> {
  const res = await pool.query<{ id: string; inat_taxon_id: number }>(
    `SELECT s.id, s.inat_taxon_id FROM species s
     LEFT JOIN species_traits t ON t.species_id = s.id
     WHERE s.reference_photo IS NULL AND s.inat_taxon_id IS NOT NULL AND NOT s.is_other_taxa
       AND NOT COALESCE(t.fully_extinct, false)
       AND EXISTS (SELECT 1 FROM region_species rs WHERE rs.species_id = s.id)
     ORDER BY s.scientific_name`,
  );
  log(`[enrich-batch] ${res.rows.length} listed species without a photo (${Math.ceil(res.rows.length / BATCH)} requests)`);
  let enriched = 0;
  let photos = 0;
  let missing = 0;
  for (let i = 0; i < res.rows.length; i += BATCH) {
    const batch = res.rows.slice(i, i + BATCH);
    const taxa = await fetchTaxa(batch.map((b) => b.inat_taxon_id));
    if (!taxa) {
      log(`[enrich-batch] batch at ${i} failed after retries, skipped`);
      continue;
    }
    const byId = new Map(taxa.map((t) => [t.id, t]));
    await mapWithConcurrency(batch, DOWNLOAD_CONCURRENCY, async (row) => {
      const taxon = byId.get(row.inat_taxon_id);
      if (!taxon) {
        missing++;
        return;
      }
      try {
        const result = await enrichmentFromTaxonRecord(row.id, taxon);
        await persistEnrichment(row.id, result);
        enriched++;
        if (result.referencePhoto) photos++;
      } catch (err) {
        log(`[enrich-batch] ${row.id}: ${err instanceof Error ? err.message : err}`);
      }
    });
    if ((i / BATCH) % 20 === 0) log(`[enrich-batch] ${Math.min(i + BATCH, res.rows.length)}/${res.rows.length} (${photos} with a photo)`);
  }
  log(`[enrich-batch] done: ${enriched} enriched, ${photos} now have a photo, ${missing} not returned by iNaturalist`);
  return { enriched, photos, missing };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  enrichListedBatch()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
