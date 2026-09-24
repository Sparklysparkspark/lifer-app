// Country-level tier computation backed by the already-downloaded GBIF per-country cache
// (packages/data-pipeline/data/gbif-country-cache/{iso2}.zip — the same cache
// compute-provinces-bulk.ts uses for its own province partitioning) instead of live per-request
// GBIF API calls. Each zip holds one pre-aggregated CSV: species / decimallatitude /
// decimallongitude / class / year / basisofrecord / week / record_count — real per-point data
// (unlike the one-time, now-gone GBIF SQL dump the original country pass used, which had no
// lat/lon at all), just aggregated by point+year+week to keep file size sane. That's enough to
// replicate the live pipeline's percentile-rank tier scoring, seasonality (from week), and
// recurrence/vagrancy checks (from year) — everything except the live path's marine cross-
// exclusion, fish geographic-outlier scrutiny, and captive-locality check, which need per-record
// institution/locality metadata this simplified format doesn't carry. Reading from disk instead
// of GBIF's live (heavily rate-limited) API turns a ~6-10 minute-per-country sweep into a local
// parse, at that accepted accuracy cost.
//
// Membership still comes entirely from iNat (see matchedSpeciesIdsForRegion/
// resolveRemovalRescues) — this only ever supplies OCCURRENCE DATA for whichever species iNat
// says belong here, exactly like the live computeRegionOccurrences. And just like that function,
// a species already on the checklist with a real tier is left completely untouched — the
// expensive part of this (parsing the country's whole zip) is skipped ENTIRELY whenever there's
// nothing new to tier, which is the common case once a country's already been through this once.
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../db.js";
import { matchedSpeciesIdsForRegion, resolveRemovalRescues } from "../scripts/inatChecklist.js";
import {
  MIN_RECORDS,
  FISH_MIN_RECORDS,
  RECENT_YEARS_WINDOW,
  RECURRENCE_ALLTIME_FLOOR,
  passesRecurrenceCheck,
} from "data-pipeline/src/build/build-region-species.js";
import {
  tierForScore,
  BIRD_ABSOLUTE_TIER_THRESHOLDS,
  MAMMAL_ABSOLUTE_TIER_THRESHOLDS,
  FISH_ABSOLUTE_TIER_THRESHOLDS,
  percentileRankScores,
  boostElusivenessForNocturnal,
  boostElusivenessForDensity,
  boostElusivenessForHabitatDensity,
} from "data-pipeline/src/build/compute-rarity-phase1.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const GBIF_COUNTRY_CACHE_DIR = path.join(REPO_ROOT, "packages/data-pipeline/data/gbif-country-cache");

// GBIF's bulk warehouse reports ray-finned/cartilaginous fish (and a handful of other basal fish
// classes) far more finely than the single "Actinopterygii" this codebase's live taxonKey
// queries use — same class list the original bulk pass already validated.
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
const FISH_VAGRANT_MIN_RECORDS = 3;

export function hasCachedGbifData(iso2: string): boolean {
  return existsSync(path.join(GBIF_COUNTRY_CACHE_DIR, `${iso2}.zip`));
}

// Aggregated on the fly while streaming (see loadAggregatedRowsBySpecies below) — everything
// scoreCountryFromCachedRows actually needs per species, and nothing more. Retaining every
// individual raw row in memory instead (the previous approach) meant a Map holding one array
// entry per occurrence point — for a large, biodiverse country's cache (Australia's own raw
// CSV is 7+ GB uncompressed, tens of millions of rows) that blew well past any reasonable
// heap size before scoring ever got a chance to run, crashing the whole multi-day reconcile
// job outright. Aggregating during the same single streaming pass instead keeps memory
// proportional to distinct SPECIES (tens of thousands at most), not total occurrence points.
interface AggregatedSpeciesRows {
  class: string;
  recordCount: number;
  monthCounts: number[];
  yearCounts: Map<number, number>;
}

async function loadAggregatedRowsBySpecies(iso2: string): Promise<Map<string, AggregatedSpeciesRows>> {
  const zipPath = path.join(GBIF_COUNTRY_CACHE_DIR, `${iso2}.zip`);
  const bySpecies = new Map<string, AggregatedSpeciesRows>();
  const unzipProc = spawn("unzip", ["-p", zipPath]);
  const rl = readline.createInterface({ input: unzipProc.stdout, crlfDelay: Infinity });
  let header: string[] | null = null;
  let idx: Record<string, number> = {};
  let unzipStderr = "";
  unzipProc.stderr.on("data", (chunk) => (unzipStderr += chunk));
  for await (const line of rl) {
    if (!line) continue;
    const cols = line.split("\t");
    if (!header) {
      header = cols;
      header.forEach((h, i) => (idx[h] = i));
      continue;
    }
    const species = cols[idx.species];
    if (!species) continue;
    const recordCount = cols[idx.record_count] ? Number(cols[idx.record_count]) : 1;
    const year = cols[idx.year] ? Number(cols[idx.year]) : null;
    const week = cols[idx.week] ? Number(cols[idx.week]) : null;

    let agg = bySpecies.get(species);
    if (!agg) {
      agg = { class: cols[idx.class], recordCount: 0, monthCounts: new Array(12).fill(0), yearCounts: new Map() };
      bySpecies.set(species, agg);
    }
    agg.recordCount += recordCount;
    if (week != null) agg.monthCounts[weekToMonth(week) - 1] += recordCount;
    if (year != null) agg.yearCounts.set(year, (agg.yearCounts.get(year) ?? 0) + recordCount);
  }
  const exitCode: number = await new Promise((resolve) => unzipProc.on("close", resolve));
  if (exitCode !== 0) throw new Error(`unzip -p ${zipPath} failed: ${unzipStderr}`);
  return bySpecies;
}

/** ISO week (1-53) -> calendar month (1-12), close enough for a seasonality histogram — this
 *  only ever feeds a display chart, not a scoring decision, so the ~1-day boundary imprecision
 *  of a fixed week-to-month mapping doesn't matter. */
function weekToMonth(week: number): number {
  return Math.min(12, Math.max(1, Math.ceil((week / 52) * 12)));
}

interface ScoredSpecies {
  speciesId: string;
  recordCount: number;
  seasonality: number[];
  isVagrant: boolean;
  isFish: boolean;
  tier: string | null;
}

/** The scoring half of this file — everything computeAndWriteRegion needs once it's already
 *  decided (via the cheap iNat diff) that there's real new tiering work to do. Mirrors the live
 *  computeRegionOccurrences's percentile-rank + absolute-threshold + trait-boost + global-tier
 *  clamp pipeline, minus the marine/geographic-outlier/captive-locality scrutiny this data
 *  format can't support (see this file's own top comment). */
async function scoreCountryFromCachedRows(
  rowsBySpecies: Map<string, AggregatedSpeciesRows>,
  nameToSpeciesId: Map<string, string>,
): Promise<Map<string, ScoredSpecies>> {
  const currentYear = new Date().getFullYear();
  const scored: ScoredSpecies[] = [];

  for (const [name, agg] of rowsBySpecies) {
    const speciesId = nameToSpeciesId.get(name);
    if (!speciesId) continue;
    const isFish = FISH_CLASSES.has(agg.class);
    if (!isFish && !BIRD_MAMMAL_CLASSES.has(agg.class)) continue;

    const monthCounts = agg.monthCounts;

    if (isFish) {
      const recordCount = agg.recordCount;
      if (recordCount < FISH_MIN_RECORDS) continue;
      scored.push({
        speciesId,
        recordCount,
        seasonality: monthCounts,
        isVagrant: recordCount < FISH_VAGRANT_MIN_RECORDS,
        isFish: true,
        tier: null,
      });
      continue;
    }

    const recentTotal = [...agg.yearCounts.entries()]
      .filter(([year]) => year >= currentYear - RECENT_YEARS_WINDOW)
      .reduce((s, [, count]) => s + count, 0);
    const yearCountArr = [...agg.yearCounts.entries()].map(([year, count]) => ({ year, count }));
    const allTimeTotal = agg.recordCount;

    if (recentTotal >= MIN_RECORDS) {
      scored.push({
        speciesId,
        recordCount: recentTotal,
        seasonality: monthCounts,
        isVagrant: !passesRecurrenceCheck(yearCountArr),
        isFish: false,
        tier: null,
      });
    } else if (allTimeTotal >= RECURRENCE_ALLTIME_FLOOR && passesRecurrenceCheck(yearCountArr)) {
      scored.push({ speciesId, recordCount: allTimeTotal, seasonality: monthCounts, isVagrant: false, isFish: false, tier: null });
    }
  }

  const traitsRes = await pool.query<{
    id: string;
    nocturnal: boolean | null;
    range_size_km2: string | null;
    population_estimate: string | null;
    habitat_density: number | null;
    domestic: boolean;
    taxon_class: string | null;
  }>(
    `SELECT s.id, t.nocturnal, t.range_size_km2, t.population_estimate, t.habitat_density, t.domestic, s.taxon_class
     FROM species s JOIN species_traits t ON t.species_id = s.id WHERE s.id = ANY($1::uuid[])`,
    [scored.map((c) => c.speciesId)],
  );
  const traitsBySpeciesId = new Map(traitsRes.rows.map((r) => [r.id, r]));
  const domesticIds = new Set(traitsRes.rows.filter((r) => r.domestic).map((r) => r.id));
  const wild = scored.filter((c) => !domesticIds.has(c.speciesId));

  const densityIndexes = wild
    .map((c, idx) => {
      const t = traitsBySpeciesId.get(c.speciesId);
      const population = t?.population_estimate != null ? Number(t.population_estimate) : null;
      const range = t?.range_size_km2 != null ? Number(t.range_size_km2) : null;
      const density = population != null && range != null && range > 0 ? population / range : null;
      return { idx, value: density };
    })
    .filter((e): e is { idx: number; value: number } => e.value != null);
  const densityScoreBySpeciesId = new Map([...percentileRankScores(densityIndexes)].map(([idx, score]) => [wild[idx].speciesId, score]));

  const baseScoreByIdx = percentileRankScores(wild.map((c, idx) => ({ idx, value: c.recordCount })));
  const tierBySpeciesId = new Map<string, string>();
  wild.forEach((c, idx) => {
    const t = traitsBySpeciesId.get(c.speciesId);
    const nocturnalBoosted = boostElusivenessForNocturnal(baseScoreByIdx.get(idx) ?? 0.5, t?.nocturnal ?? null);
    const densityBoosted = boostElusivenessForDensity(nocturnalBoosted, densityScoreBySpeciesId.get(c.speciesId) ?? null);
    const habitatBoosted = boostElusivenessForHabitatDensity(densityBoosted, t?.habitat_density ?? null);
    const thresholds = c.isFish
      ? FISH_ABSOLUTE_TIER_THRESHOLDS
      : t?.taxon_class === "mammalia"
        ? MAMMAL_ABSOLUTE_TIER_THRESHOLDS
        : BIRD_ABSOLUTE_TIER_THRESHOLDS;
    tierBySpeciesId.set(c.speciesId, tierForScore(habitatBoosted, thresholds));
  });

  const LOCAL_TIER_GLOBAL_FLOOR_STEPS = 1;
  const LOCAL_TIER_GLOBAL_CEILING_STEPS = 2;
  const TIER_ORDER = ["legendary", "epic", "rare", "uncommon", "common"];
  const globalTierRes = await pool.query<{ species_id: string; tier: string }>(
    `SELECT species_id, tier FROM species_rarity WHERE species_id = ANY($1::uuid[])`,
    [wild.map((c) => c.speciesId)],
  );
  const globalTierBySpeciesId = new Map(globalTierRes.rows.map((r) => [r.species_id, r.tier]));
  for (const [speciesId, localTier] of tierBySpeciesId) {
    const globalTier = globalTierBySpeciesId.get(speciesId);
    if (!globalTier || globalTier === "unrated") continue;
    const globalRank = TIER_ORDER.indexOf(globalTier);
    const localRank = TIER_ORDER.indexOf(localTier);
    const clamped = Math.min(Math.max(localRank, globalRank - LOCAL_TIER_GLOBAL_CEILING_STEPS), globalRank + LOCAL_TIER_GLOBAL_FLOOR_STEPS);
    if (clamped !== localRank) tierBySpeciesId.set(speciesId, TIER_ORDER[clamped]);
  }
  for (const speciesId of domesticIds) tierBySpeciesId.set(speciesId, "common");

  const bySpeciesId = new Map<string, ScoredSpecies>();
  for (const c of scored) bySpeciesId.set(c.speciesId, { ...c, tier: tierBySpeciesId.get(c.speciesId) ?? null });
  return bySpeciesId;
}

let nameToSpeciesIdCache: Promise<Map<string, string>> | null = null;
async function loadNameToSpeciesId(): Promise<Map<string, string>> {
  if (!nameToSpeciesIdCache) {
    nameToSpeciesIdCache = pool
      .query<{ name: string; species_id: string }>(
        `SELECT scientific_name AS name, id AS species_id FROM species
         UNION
         SELECT synonym_name AS name, species_id FROM species_synonyms`,
      )
      .then((res) => new Map(res.rows.map((r) => [r.name, r.species_id])));
  }
  return nameToSpeciesIdCache;
}

/** Cache-backed counterpart to computeRegionOccurrences (regions/routes.ts) — same iNat-driven
 *  membership + "don't recompute an already-tiered species" contract, just sourcing occurrence
 *  data from the local GBIF cache instead of live API calls. Returns false (does nothing) when
 *  this country has no cached zip, so the caller can fall back to the live path. */
export async function computeRegionOccurrencesFromCache(
  region: { id: string; name: string },
  iso2: string,
): Promise<boolean> {
  if (!hasCachedGbifData(iso2)) return false;

  const inatMatch = await matchedSpeciesIdsForRegion(region.id, region.name);
  if (!inatMatch) return false; // no iNat data either — let the live path's own GBIF-only fallback handle it
  const { matchedSpeciesIds, rawTaxonIds } = inatMatch;

  const existingRes = await pool.query<{ species_id: string; local_tier: string | null }>(
    `SELECT species_id, local_tier FROM region_species WHERE region_id = $1`,
    [region.id],
  );
  const existingIds = new Set(existingRes.rows.map((r) => r.species_id));
  const alreadyTieredIds = new Set(existingRes.rows.filter((r) => r.local_tier != null).map((r) => r.species_id));

  const removalCandidateIds = [...existingIds].filter((id) => !matchedSpeciesIds.has(id));
  let rescuedIds = new Set<string>();
  if (removalCandidateIds.length > 0) {
    const candidateRows = await pool.query<{ id: string; scientific_name: string }>(
      `SELECT id, scientific_name FROM species WHERE id = ANY($1::uuid[])`,
      [removalCandidateIds],
    );
    rescuedIds = await resolveRemovalRescues(candidateRows.rows, rawTaxonIds);
  }

  const idList = [...matchedSpeciesIds, ...rescuedIds];
  const needsTierIds = idList.filter((id) => !alreadyTieredIds.has(id));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM region_species WHERE region_id = $1 AND NOT (species_id = ANY($2::uuid[]))`, [region.id, idList]);

    // The whole point: a country with nothing new to tier never touches the cached zip at all —
    // just the cheap iNat diff above, then done.
    if (needsTierIds.length > 0) {
      const nameToSpeciesId = await loadNameToSpeciesId();
      const rowsBySpecies = await loadAggregatedRowsBySpecies(iso2);
      const scoredBySpeciesId = await scoreCountryFromCachedRows(rowsBySpecies, nameToSpeciesId);
      for (const speciesId of needsTierIds) {
        const scored = scoredBySpeciesId.get(speciesId);
        await client.query(
          `INSERT INTO region_species (region_id, species_id, local_frequency, seasonality, local_tier, is_vagrant)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (region_id, species_id) DO UPDATE SET
             local_frequency = EXCLUDED.local_frequency, seasonality = EXCLUDED.seasonality, local_tier = EXCLUDED.local_tier,
             is_vagrant = EXCLUDED.is_vagrant`,
          [
            region.id,
            speciesId,
            scored?.recordCount ?? 0,
            scored ? scored.seasonality : null,
            scored?.tier ?? "legendary",
            scored?.isVagrant ?? false,
          ],
        );
      }
    }

    await client.query(`UPDATE regions SET occurrence_computed_at = now() WHERE id = $1`, [region.id]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return true;
}
