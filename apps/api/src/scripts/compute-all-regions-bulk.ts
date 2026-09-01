// World-scale replacement for compute-all-regions.ts's per-country GBIF live calls, driven
// instead by one pre-aggregated GBIF SQL Download (species/countrycode/class/year with
// record_count — see gbif-bulk-ab-test.ts's own comment on why this MUST be aggregated
// server-side: an unaggregated version of this same query came back as 1.5 billion rows/42GB
// before being aborted). Validated against 4 already-live-computed countries first (see task
// #75) — 79-88% direct overlap, with nearly all of the remaining gap traced to genus-name
// drift between GBIF's bulk warehouse and this catalog, which build-species-name-index.ts
// exists to close.
//
// Deliberately does NOT reproduce every nuance of the live per-region computation
// (computeRegionOccurrences, apps/api/src/regions/routes.ts): no marine-zone cross-exclusion
// (needs each region's own polygon + a live sea-zone GBIF query), no fish
// type-specimen/geographic-outlier scrutiny or captive-locality check on rescued birds (both
// need live per-species record sampling this bulk dataset doesn't carry — it's aggregated
// away). Those are exactly the kind of dataset-wide sweep check-extinction-status.ts,
// detect-implausible-regions.ts, and fix-fish-region-vagrancy.ts already exist for — meant to
// run against these regions afterward, same as they did for Canada/Finland earlier.
//
// Country-level regions ONLY: a country's default checklist query (both live and here) is
// `country=<ISO2>`, which this bulk dataset's own countrycode column matches directly.
// Province-level regions use a real lat/lon point-in-polygon match in the live path — this
// bulk dataset has no lat/lon (aggregated away for size), so provinces stay on
// compute-all-regions.ts's live path, untouched by this script.
import { readdirSync, createReadStream } from "node:fs";
import readline from "node:readline";
import { pool } from "../db.js";
import { fetchAllCountries } from "data-pipeline/src/fetch/fetch-region-boundary.js";
import {
  MIN_RECORDS,
  FISH_MIN_RECORDS,
  RECENT_YEARS_WINDOW,
  RECURRENCE_ALLTIME_FLOOR,
  passesRecurrenceCheck,
} from "data-pipeline/src/build/build-region-species.js";
import {
  tierForPercentile,
  percentileRankScores,
  boostElusivenessForNocturnal,
  boostElusivenessForDensity,
  boostElusivenessForHabitatDensity,
  boostTowardHarderToDetect,
} from "data-pipeline/src/build/compute-rarity-phase1.js";

const FISH_VAGRANT_MIN_RECORDS = 3;
// See gbif-bulk-ab-test.ts's own comment — GBIF's SQL warehouse reports ray-finned fish under
// several finer classes, not the single "Actinopterygii" used by this codebase's taxonKey
// queries elsewhere.
const FISH_CLASSES = new Set([
  "Myxini",
  "Petromyzonti",
  "Elasmobranchii",
  "Holocephali",
  "Coelacanthi",
  "Dipneusti",
  "Actinopterygii",
  "Teleostei",
  "Chondrostei",
  "Cladistii",
  "Holostei",
]);
const BIRD_MAMMAL_CLASSES = new Set(["Aves", "Mammalia"]);

interface OccRow {
  species: string;
  countrycode: string;
  year: number | null;
  class: string;
  recordCount: number;
}

async function loadRowsByCountry(dir: string): Promise<Map<string, OccRow[]>> {
  const fileName = readdirSync(dir).find((f) => f.endsWith(".csv") || f.endsWith(".tsv"));
  if (!fileName) throw new Error(`no .csv/.tsv found in ${dir}`);
  const byCountry = new Map<string, OccRow[]>();
  const rl = readline.createInterface({ input: createReadStream(`${dir}/${fileName}`), crlfDelay: Infinity });
  let header: string[] | null = null;
  let idx: Record<string, number> = {};
  for await (const line of rl) {
    if (!line) continue;
    const cols = line.split("\t");
    if (!header) {
      header = cols;
      header.forEach((h, i) => (idx[h] = i));
      continue;
    }
    const countrycode = cols[idx.countrycode];
    const species = cols[idx.species];
    if (!countrycode || !species) continue;
    const row: OccRow = {
      species,
      countrycode,
      year: cols[idx.year] ? Number(cols[idx.year]) : null,
      class: cols[idx.class],
      recordCount: cols[idx.record_count] ? Number(cols[idx.record_count]) : 1,
    };
    if (!byCountry.has(countrycode)) byCountry.set(countrycode, []);
    byCountry.get(countrycode)!.push(row);
  }
  return byCountry;
}

interface ComputedSpecies {
  speciesId: string;
  gbifKey: number;
  recordCount: number;
  isVagrant: boolean;
  isFish: boolean;
}

function computeCoreChecklist(rows: OccRow[], nameToSpeciesId: Map<string, string>): ComputedSpecies[] {
  const currentYear = new Date().getFullYear();
  const bySpecies = new Map<string, OccRow[]>();
  for (const r of rows) {
    if (!BIRD_MAMMAL_CLASSES.has(r.class) && !FISH_CLASSES.has(r.class)) continue;
    if (!nameToSpeciesId.has(r.species)) continue;
    if (!bySpecies.has(r.species)) bySpecies.set(r.species, []);
    bySpecies.get(r.species)!.push(r);
  }

  const results: ComputedSpecies[] = [];
  for (const [name, occs] of bySpecies) {
    const speciesId = nameToSpeciesId.get(name)!;
    const isFish = FISH_CLASSES.has(occs[0].class);
    if (isFish) {
      const recordCount = occs.reduce((sum, o) => sum + o.recordCount, 0);
      if (recordCount < FISH_MIN_RECORDS) continue;
      results.push({ speciesId, gbifKey: 0, recordCount, isVagrant: recordCount < FISH_VAGRANT_MIN_RECORDS, isFish: true });
      continue;
    }
    const recentTotal = occs
      .filter((o) => o.year != null && o.year >= currentYear - RECENT_YEARS_WINDOW)
      .reduce((sum, o) => sum + o.recordCount, 0);
    const yearCounts = new Map<number, number>();
    for (const o of occs) if (o.year != null) yearCounts.set(o.year, (yearCounts.get(o.year) ?? 0) + o.recordCount);
    const yearCountArr = [...yearCounts.entries()].map(([year, count]) => ({ year, count }));
    const allTimeTotal = occs.reduce((sum, o) => sum + o.recordCount, 0);

    if (recentTotal >= MIN_RECORDS) {
      results.push({ speciesId, gbifKey: 0, recordCount: recentTotal, isVagrant: !passesRecurrenceCheck(yearCountArr), isFish: false });
      continue;
    }
    if (allTimeTotal >= RECURRENCE_ALLTIME_FLOOR && passesRecurrenceCheck(yearCountArr)) {
      results.push({ speciesId, gbifKey: 0, recordCount: allTimeTotal, isVagrant: false, isFish: false });
    }
  }
  return results;
}

async function computeAndWriteRegion(
  regionId: string,
  regionName: string,
  rows: OccRow[],
  nameToSpeciesId: Map<string, string>,
): Promise<number> {
  const filtered = computeCoreChecklist(rows, nameToSpeciesId);
  if (filtered.length === 0) return 0;

  const speciesIds = filtered.map((c) => c.speciesId);
  const traitsRes = await pool.query<{
    id: string;
    nocturnal: boolean | null;
    range_size_km2: string | null;
    population_estimate: string | null;
    habitat_density: number | null;
    domestic: boolean;
  }>(
    `SELECT s.id, t.nocturnal, t.range_size_km2, t.population_estimate, t.habitat_density, t.domestic
     FROM species s JOIN species_traits t ON t.species_id = s.id WHERE s.id = ANY($1)`,
    [speciesIds],
  );
  const traitsBySpeciesId = new Map(traitsRes.rows.map((r) => [r.id, r]));
  const domesticSpeciesIds = new Set(traitsRes.rows.filter((r) => r.domestic).map((r) => r.id));

  const wildFiltered = filtered.filter((c) => !domesticSpeciesIds.has(c.speciesId));
  const densityIndexes = wildFiltered
    .map((c, idx) => {
      const t = traitsBySpeciesId.get(c.speciesId);
      const population = t?.population_estimate != null ? Number(t.population_estimate) : null;
      const range = t?.range_size_km2 != null ? Number(t.range_size_km2) : null;
      const density = population != null && range != null && range > 0 ? population / range : null;
      return { idx, value: density };
    })
    .filter((e): e is { idx: number; value: number } => e.value != null);
  const densityScoreBySpeciesId = new Map(
    [...percentileRankScores(densityIndexes)].map(([idx, score]) => [wildFiltered[idx].speciesId, score]),
  );

  const baseScoreByIdx = percentileRankScores(wildFiltered.map((c, idx) => ({ idx, value: c.recordCount })));
  const boostedScores = wildFiltered.map((c, idx) => {
    const t = traitsBySpeciesId.get(c.speciesId);
    const nocturnalBoosted = boostElusivenessForNocturnal(baseScoreByIdx.get(idx) ?? 0.5, t?.nocturnal ?? null);
    const densityBoosted = boostElusivenessForDensity(nocturnalBoosted, densityScoreBySpeciesId.get(c.speciesId) ?? null);
    const habitatBoosted = boostElusivenessForHabitatDensity(densityBoosted, t?.habitat_density ?? null);
    // No year-concentration signal available here (that's the live "vagrant burst" boost,
    // which needs per-year facet data this aggregation already used up for the pass/fail
    // recurrence check above, not a continuous concentration score) — deferred, same as the
    // other live-only scrutiny passes this script skips.
    return { speciesId: c.speciesId, score: habitatBoosted };
  });
  const sortedByBoostedScore = [...boostedScores].sort((a, b) => b.score - a.score);
  const localTierBySpeciesId = new Map<string, string>();
  const localN = sortedByBoostedScore.length;
  sortedByBoostedScore.forEach((row, idx) => {
    localTierBySpeciesId.set(row.speciesId, tierForPercentile((idx + 1) / localN));
  });

  const LOCAL_TIER_GLOBAL_FLOOR_STEPS = 1;
  const TIER_ORDER = ["legendary", "epic", "rare", "uncommon", "common"];
  const globalTierRes = await pool.query<{ species_id: string; tier: string }>(
    `SELECT species_id, tier FROM species_rarity WHERE species_id = ANY($1)`,
    [wildFiltered.map((c) => c.speciesId)],
  );
  const globalTierBySpeciesId = new Map(globalTierRes.rows.map((r) => [r.species_id, r.tier]));
  for (const [speciesId, localTier] of localTierBySpeciesId) {
    const globalTier = globalTierBySpeciesId.get(speciesId);
    if (!globalTier || globalTier === "unrated") continue;
    const globalRank = TIER_ORDER.indexOf(globalTier);
    const localRank = TIER_ORDER.indexOf(localTier);
    const flooredRank = Math.min(localRank, globalRank + LOCAL_TIER_GLOBAL_FLOOR_STEPS);
    if (flooredRank !== localRank) localTierBySpeciesId.set(speciesId, TIER_ORDER[flooredRank]);
  }
  for (const speciesId of domesticSpeciesIds) localTierBySpeciesId.set(speciesId, "common");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM region_species WHERE region_id = $1`, [regionId]);
    for (const c of filtered) {
      await client.query(
        `INSERT INTO region_species (region_id, species_id, local_frequency, seasonality, local_tier, is_vagrant)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (region_id, species_id) DO UPDATE SET
           local_frequency = EXCLUDED.local_frequency, seasonality = EXCLUDED.seasonality, local_tier = EXCLUDED.local_tier,
           is_vagrant = EXCLUDED.is_vagrant`,
        [regionId, c.speciesId, c.recordCount, null, localTierBySpeciesId.get(c.speciesId) ?? null, c.isVagrant],
      );
    }
    await client.query(`UPDATE regions SET occurrence_computed_at = now() WHERE id = $1`, [regionId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return filtered.length;
}

async function main() {
  const dirArg = process.argv.find((a) => a.startsWith("--dir="))?.split("=")[1];
  if (!dirArg) throw new Error("usage: --dir=<extracted GBIF download dir>");

  console.log(`[compute-all-regions-bulk] loading ${dirArg}...`);
  const rowsByIso2 = await loadRowsByCountry(dirArg);
  console.log(`[compute-all-regions-bulk] loaded data for ${rowsByIso2.size} countries`);

  const nameRes = await pool.query<{ name: string; species_id: string }>(
    `SELECT scientific_name AS name, id AS species_id FROM species
     UNION
     SELECT synonym_name AS name, species_id FROM species_synonyms`,
  );
  const nameToSpeciesId = new Map(nameRes.rows.map((r) => [r.name, r.species_id]));
  console.log(`[compute-all-regions-bulk] ${nameToSpeciesId.size} known species names (incl. synonyms) for matching`);

  const countries = await fetchAllCountries();
  const iso3ToIso2 = new Map(countries.filter((c) => c.iso2 && /^[A-Z]{2}$/.test(c.iso2)).map((c) => [c.iso3, c.iso2!]));

  const regionsRes = await pool.query<{ id: string; name: string; external_codes: string[] }>(
    `SELECT id, name, external_codes FROM regions
     WHERE occurrence_computed_at IS NULL AND external_codes IS NOT NULL AND array_length(external_codes, 1) > 0
       AND external_codes[1] ~ '^[A-Z]{3}$'
     ORDER BY name`,
  );
  console.log(`[compute-all-regions-bulk] ${regionsRes.rows.length} not-yet-computed country-level region(s) to try`);

  let computed = 0;
  let skippedNoIso2 = 0;
  let skippedNoData = 0;
  for (const region of regionsRes.rows) {
    const iso2 = iso3ToIso2.get(region.external_codes[0]);
    if (!iso2) {
      skippedNoIso2++;
      continue;
    }
    const rows = rowsByIso2.get(iso2);
    if (!rows || rows.length === 0) {
      skippedNoData++;
      console.log(`[compute-all-regions-bulk] ${region.name} (${iso2}): no bulk data — leaving for the live per-country path`);
      continue;
    }
    const speciesCount = await computeAndWriteRegion(region.id, region.name, rows, nameToSpeciesId);
    computed++;
    console.log(`[compute-all-regions-bulk] ${computed}/${regionsRes.rows.length} ${region.name} (${iso2}): ${speciesCount} species`);
  }

  console.log(
    `[compute-all-regions-bulk] done. ${computed} computed, ${skippedNoIso2} skipped (no ISO2 mapping), ` +
      `${skippedNoData} skipped (no bulk data for this country — needs the live per-country path).`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
