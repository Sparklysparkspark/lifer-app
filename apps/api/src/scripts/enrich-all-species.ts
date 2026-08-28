// Bulk enrichment pass that eagerly fetches every species still missing enrichment, rather
// than waiting for the lazy on-view path (see species/routes.ts, lazyEnrich.ts) to enrich it
// the first time someone opens its page. Ensures the whole species backbone ends up with a
// photo/blurb/gallery even for species nobody has viewed yet. Meant to run once, unattended,
// for a long time: fetching iNaturalist + Wikipedia data per species at real external-API
// pace is the slow part that the lazy-enrichment design intentionally keeps off the request
// path.
//
// Species are processed in priority tiers — Canada first, then the rest of North America,
// then everything else — computed eagerly here (rather than waiting for someone to view each
// country and trigger the lazy region-occurrence path) so those regions are fully populated
// with photos well before the rest of the world finishes in the background. Concurrency is
// limited (mapWithConcurrency, see data-pipeline/src/concurrency.ts — pure control-flow, no
// heavy runtime deps, safe to import here per licensePolicy.ts's split) rather than
// processing one species at a time — 4 in flight balances real speedup against staying
// polite to iNaturalist/Wikipedia's public APIs.
import { pool } from "../db.js";
import { enrichSpecies, persistEnrichment } from "../species/lazyEnrich.js";
import { computeRegionOccurrences } from "../regions/routes.js";
import { mapWithConcurrency } from "data-pipeline/src/concurrency.js";

const CONCURRENCY = 2;

// Temporary: scoped to the three taxon groups needed for the initial release (fish, birds,
// mammals) so those finish in hours rather than getting stuck behind the other 12 groups'
// ~47k still-unenriched species. Remove this filter once ready to enrich everything else.
const INITIAL_RELEASE_TAXA = ["actinopterygii", "aves", "mammalia"];

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
  const { canada, restOfNorthAmerica } = await priorityTiers();

  const res = await pool.query(
    `SELECT id, scientific_name, taxon_class FROM species WHERE enriched_at IS NULL AND taxon_class = ANY($1) ORDER BY scientific_name`,
    [INITIAL_RELEASE_TAXA],
  );
  const rows = res.rows as Array<{
    id: string;
    scientific_name: string;
    taxon_class: string;
  }>;

  // Canada is completed first (every taxon), then the rest of North America, then everything
  // else in the world — rather than birds-everywhere first. Goal is "Canada usable offline"
  // as soon as possible, not "birds usable offline worldwide" first. Each group is a stable
  // partition of `rows`, not a re-sort within itself.
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
      // iNaturalist-only (see lazyEnrich.ts's top comment) — no Wikipedia/Commons fallback to
      // worry about stalling this bulk pass any more.
      const enrichment = await enrichSpecies({ id: row.id, scientific_name: row.scientific_name });
      await persistEnrichment(row.id, enrichment);
    } catch (err) {
      failed++;
      console.error(`[enrich-all] FAILED ${row.scientific_name}:`, err);
      // Still mark enriched_at so a species that errors out (e.g. malformed Wikipedia
      // page) doesn't retry forever on the next overnight pass — same "already tried"
      // semantics as the lazy path.
      await pool.query(`UPDATE species SET enriched_at = now() WHERE id = $1`, [row.id]);
    }
    done++;
    if (done % 100 === 0) {
      console.log(`[enrich-all] ${done}/${ordered.length} (${failed} failed)`);
    }
  });

  console.log(`[enrich-all] done. ${done} processed, ${failed} failed.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
