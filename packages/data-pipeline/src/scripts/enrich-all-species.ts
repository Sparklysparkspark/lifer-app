// Eagerly enriches (photo, blurb, gallery) every species still missing it, instead of waiting
// for the lazy on-view path in lazyEnrich.ts. Long-running and unattended.
//
// Processed in priority order: Canada, then the rest of North America, then everything else.
// Concurrency stays low to be polite to iNaturalist's public API.
//
// Usage: npx tsx src/scripts/enrich-all-species.ts [--taxa=squamata,amphibia] [--listed-only]
import { pool } from "@lifer/core/db.js";
import { enrichSpecies, persistEnrichment, PersistentRateLimitError } from "@lifer/core/species/lazyEnrich.js";
import { computeRegionOccurrences } from "@lifer/core/regions/compute/occurrences.js";
import { mapWithConcurrency } from "@lifer/core/lib/concurrency.js";
import { applyPhotoLicensePolicy } from "../pipeline/photoLicensePolicy.js";

const CONCURRENCY = 2;

// Defaults to fish, birds and mammals. --taxa= overrides this and skips the regional priority
// tiers, which would otherwise trigger live GBIF region computations.
const taxaArg = process.argv.find((a) => a.startsWith("--taxa="));
// Only species on some region checklist: what packs ship. The rest are enriched the first time
// someone opens them (lazyEnrich.ts), so a pipeline run needn't wait on tens of thousands of them.
const listedOnly = process.argv.includes("--listed-only");
const INITIAL_RELEASE_TAXA = taxaArg ? taxaArg.split("=")[1].split(",") : ["actinopterygii", "aves", "mammalia"];

type RegionRow = {
  id: string;
  boundary_geojson: { bbox?: [number, number, number, number]; geometry?: { type: string; coordinates: unknown } } | null;
  external_codes: string[] | null;
  occurrence_computed_at: Date | null;
};

async function primeCountries(countries: RegionRow[], label: string): Promise<void> {
  let primed = 0;
  for (const region of countries) {
    if (!region.occurrence_computed_at && region.external_codes?.length) {
      await computeRegionOccurrences(region);
      primed++;
      if (primed % 10 === 0) console.log(`[enrich-all]   ${label}: ${primed}/${countries.length} primed`);
    }
  }
  console.log(`[enrich-all] ${label}: ${countries.length} countries primed`);
}

async function speciesForRegions(regionIds: string[]): Promise<Set<string>> {
  if (regionIds.length === 0) return new Set();
  const res = await pool.query<{ species_id: string }>(
    `SELECT DISTINCT species_id FROM region_species WHERE region_id = ANY($1)`,
    [regionIds],
  );
  return new Set(res.rows.map((r) => r.species_id));
}

// Returns three priority tiers, most urgent first: Canada, the rest of North America, and
// (implicitly, by not being in either set) everything else.
async function priorityTiers(): Promise<{ canada: Set<string>; restOfNorthAmerica: Set<string> }> {
  const naRes = await pool.query<{ id: string }>(`SELECT id FROM regions WHERE name = 'North America'`);
  const naRegionId = naRes.rows[0]?.id;
  if (!naRegionId) return { canada: new Set(), restOfNorthAmerica: new Set() };

  const countriesRes = await pool.query<RegionRow & { name: string }>(
    `SELECT id, name, boundary_geojson, external_codes, occurrence_computed_at FROM regions WHERE parent_id = $1`,
    [naRegionId],
  );
  const canadaRow = countriesRes.rows.find((r) => r.name === "Canada");
  const restRows = countriesRes.rows.filter((r) => r.name !== "Canada");

  if (canadaRow) await primeCountries([canadaRow], "Canada");
  const canada = canadaRow ? await speciesForRegions([canadaRow.id]) : new Set<string>();
  console.log(`[enrich-all] Canada: ${canada.size} distinct species identified for priority`);

  await primeCountries(restRows, "rest of North America");
  const restOfNorthAmerica = await speciesForRegions(restRows.map((r) => r.id));
  console.log(`[enrich-all] rest of North America: ${restOfNorthAmerica.size} distinct species identified for priority`);

  return { canada, restOfNorthAmerica };
}

async function main() {
  const { canada, restOfNorthAmerica } = taxaArg
    ? { canada: new Set<string>(), restOfNorthAmerica: new Set<string>() }
    : await priorityTiers();

  const res = await pool.query(
    `SELECT id, scientific_name, taxon_class FROM species s
     WHERE enriched_at IS NULL AND taxon_class = ANY($1)
       AND ($2 = false OR EXISTS (SELECT 1 FROM region_species rs WHERE rs.species_id = s.id))
     ORDER BY scientific_name`,
    [INITIAL_RELEASE_TAXA, listedOnly],
  );
  const rows = res.rows as Array<{
    id: string;
    scientific_name: string;
    taxon_class: string;
  }>;

  // Region order first (Canada, rest of North America, world), each a stable partition of `rows`.
  const isCanada = (r: { id: string }) => canada.has(r.id);
  const isRestOfNA = (r: { id: string }) => !isCanada(r) && restOfNorthAmerica.has(r.id);
  const remaining = new Set(rows.map((r) => r.id));
  const take = (pred: (r: (typeof rows)[number]) => boolean) => {
    const matched = rows.filter((r) => remaining.has(r.id) && pred(r));
    for (const r of matched) remaining.delete(r.id);
    return matched;
  };

  const canadaAll = take((r) => isCanada(r));
  const restOfNaAll = take((r) => isRestOfNA(r));
  const worldAll = take(() => true);

  const ordered = [...canadaAll, ...restOfNaAll, ...worldAll];
  console.log(
    `[enrich-all] ${ordered.length} species to enrich: ${canadaAll.length} Canada, ${restOfNaAll.length} rest of NA, ` +
      `${worldAll.length} rest of world (concurrency=${CONCURRENCY})`,
  );

  let done = 0;
  let failed = 0;
  await mapWithConcurrency(ordered, CONCURRENCY, async (row) => {
    try {
      const enrichment = await enrichSpecies({ id: row.id, scientific_name: row.scientific_name }, { publishableOnly: true });
      await persistEnrichment(row.id, enrichment);
    } catch (err) {
      failed++;
      console.error(`[enrich-all] FAILED ${row.scientific_name}:`, err);
      // A persistent 429 means iNat never answered, so leave enriched_at null for a later retry
      // rather than recording "no photo". Other failures mark it so they don't retry forever.
      if (!(err instanceof PersistentRateLimitError)) {
        await pool.query(`UPDATE species SET enriched_at = now() WHERE id = $1`, [row.id]);
      }
    }
    done++;
    if (done % 100 === 0) {
      console.log(`[enrich-all] ${done}/${ordered.length} (${failed} failed)`);
    }
  });

  console.log(`[enrich-all] done. ${done} processed, ${failed} failed.`);
  // Enrichment keeps photos whatever their license; only publishable ones may reach packs.
  await applyPhotoLicensePolicy(pool);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
