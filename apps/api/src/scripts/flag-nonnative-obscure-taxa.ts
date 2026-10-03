// Cross-checks reptiles, amphibians and marine invertebrates on checklists against iNaturalist's
// curated establishment_means per place. A pet photographed at home can reach Research Grade, so
// this is the signal for "established here" rather than "photographed here".
//
// One request per species: GET /v1/taxa/{id} returns every place with a verdict (capped at 100
// entries; countries past the cap get no verdict). Verdicts are often at continent level, so each
// country's ancestor places are checked too, nearest first.
//
// Outcomes:
//   - "introduced": the region_species row is deleted (not a wild occurrence at all).
//   - "naturalized" or "invasive": kept, with is_invasive set true.
//   - "native"/"endemic", or no verdict: left untouched.
//
// Usage: npx tsx src/scripts/flag-nonnative-obscure-taxa.ts [--countries=Canada,Portugal] [--apply]
import "../config.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../db.js";
import { resolveInatPlaceId, resolveCurrentInatTaxonId, fetchWithHardTimeout } from "./inatChecklist.js";
import { mapWithConcurrency } from "data-pipeline/src/concurrency.js";

const CONCURRENCY = 8;

// scripts -> src -> api -> apps -> repo root.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const NEW_OBSCURE_TAXON_CLASSES = [
  "squamata",
  "testudines",
  "amphibia",
  "corals",
  "jellies_and_anemones",
  "echinodermata",
  "nudibranchs",
  "marine_mollusks",
  "cephalopoda",
  "crustacea",
  "sponges_tunicates_other",
];

const INAT_TAXA_API = "https://api.inaturalist.org/v1/taxa";
const INAT_PLACES_API = "https://api.inaturalist.org/v1/places";
const INAT_USER_AGENT = "lifer-app/0.1 (personal project; region checklist verification)";

// ~1 request/sec pacing for this script's own iNat calls.
const INAT_REQUEST_INTERVAL_MS = 1000;
let lastRequestAt = 0;
async function paceRequest(): Promise<void> {
  const wait = lastRequestAt + INAT_REQUEST_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

type EstablishmentMeans = "native" | "endemic" | "introduced" | "naturalized" | "invasive" | "managed" | "captive";

// Disk cache per taxon id of every place's curated verdict, keyed by iNat place id.
const LISTED_TAXA_CACHE_PATH = path.join(REPO_ROOT, "packages/data-pipeline/data/inat-listed-taxa-cache.json");
let listedTaxaDiskCache: Record<number, Record<number, EstablishmentMeans>> | null = null;

function loadListedTaxaDiskCache(): Record<number, Record<number, EstablishmentMeans>> {
  if (listedTaxaDiskCache) return listedTaxaDiskCache;
  if (existsSync(LISTED_TAXA_CACHE_PATH)) {
    try {
      listedTaxaDiskCache = JSON.parse(readFileSync(LISTED_TAXA_CACHE_PATH, "utf8"));
      return listedTaxaDiskCache!;
    } catch {
      // corrupt file is no worse than a missing one
    }
  }
  listedTaxaDiskCache = {};
  return listedTaxaDiskCache;
}

function saveListedTaxaDiskCache(taxonId: number, byPlaceId: Record<number, EstablishmentMeans>): void {
  const cache = loadListedTaxaDiskCache();
  cache[taxonId] = byPlaceId;
  mkdirSync(path.dirname(LISTED_TAXA_CACHE_PATH), { recursive: true });
  writeFileSync(LISTED_TAXA_CACHE_PATH, JSON.stringify(cache));
}

interface ListedTaxon {
  establishment_means?: string | null;
  place?: { id: number } | null;
}

const LISTED_TAXA_FETCH_RETRIES = 4;

// Every place this taxon has a curated verdict for, keyed by place id. Only a successful fetch
// is cached, so a transient failure is never stored as "no verdict anywhere".
async function fetchListedTaxaByPlace(taxonId: number): Promise<Record<number, EstablishmentMeans>> {
  const disk = loadListedTaxaDiskCache();
  if (disk[taxonId]) return disk[taxonId];

  for (let attempt = 0; attempt < LISTED_TAXA_FETCH_RETRIES; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt)); // 2s, 4s, 8s
    await paceRequest();
    try {
      const res = await fetchWithHardTimeout(`${INAT_TAXA_API}/${taxonId}`, {
        headers: { "User-Agent": INAT_USER_AGENT },
      });
      if (!res.ok) continue; // transient (rate limit, 5xx): retry rather than cache a blank
      const data = (await res.json()) as { results: Array<{ listed_taxa?: ListedTaxon[] }> };
      const listedTaxa = data.results[0]?.listed_taxa ?? [];
      const byPlaceId: Record<number, EstablishmentMeans> = {};
      for (const lt of listedTaxa) {
        if (lt.place?.id && lt.establishment_means) {
          byPlaceId[lt.place.id] = lt.establishment_means as EstablishmentMeans;
        }
      }
      saveListedTaxaDiskCache(taxonId, byPlaceId); // successful fetch: an empty result here is a real "no curated data"
      return byPlaceId;
    } catch {
      // timed out or network failure: retry
    }
  }
  return {}; // exhausted all retries: not cached, so the next run tries again
}

// Disk cache of each country place's ancestor chain, which never changes.
const PLACE_ANCESTRY_CACHE_PATH = path.join(REPO_ROOT, "packages/data-pipeline/data/inat-place-ancestry-cache.json");
let placeAncestryDiskCache: Record<number, number[]> | null = null;

function loadPlaceAncestryDiskCache(): Record<number, number[]> {
  if (placeAncestryDiskCache) return placeAncestryDiskCache;
  if (existsSync(PLACE_ANCESTRY_CACHE_PATH)) {
    try {
      placeAncestryDiskCache = JSON.parse(readFileSync(PLACE_ANCESTRY_CACHE_PATH, "utf8"));
      return placeAncestryDiskCache!;
    } catch {
      // corrupt file is no worse than a missing one
    }
  }
  placeAncestryDiskCache = {};
  return placeAncestryDiskCache;
}

function savePlaceAncestryDiskCache(placeId: number, ancestorPlaceIds: number[]): void {
  const cache = loadPlaceAncestryDiskCache();
  cache[placeId] = ancestorPlaceIds;
  mkdirSync(path.dirname(PLACE_ANCESTRY_CACHE_PATH), { recursive: true });
  writeFileSync(PLACE_ANCESTRY_CACHE_PATH, JSON.stringify(cache));
}

// A country's place id plus its ancestor places, nearest first, so a continent-level verdict
// still applies to the country.
async function resolveCountryAncestry(countryPlaceId: number): Promise<number[]> {
  const disk = loadPlaceAncestryDiskCache();
  if (disk[countryPlaceId]) return disk[countryPlaceId];

  await paceRequest();
  let ancestorPlaceIds = [countryPlaceId];
  try {
    const res = await fetchWithHardTimeout(`${INAT_PLACES_API}/${countryPlaceId}`, {
      headers: { "User-Agent": INAT_USER_AGENT },
    });
    if (res.ok) {
      const data = (await res.json()) as { results: Array<{ ancestor_place_ids?: number[] | null }> };
      const fetched = data.results[0]?.ancestor_place_ids;
      // iNat lists ancestors root first; reverse so the country's own verdict wins.
      if (fetched && fetched.length > 0) ancestorPlaceIds = [...fetched].reverse();
    }
  } catch {
    // best-effort: fall back to just the country's own place id
  }
  savePlaceAncestryDiskCache(countryPlaceId, ancestorPlaceIds);
  return ancestorPlaceIds;
}

interface SpeciesCandidateRow {
  species_id: string;
  scientific_name: string;
  common_name: string;
  inat_taxon_id: number | null;
  country_ids: string[];
  country_names: string[];
}

async function main() {
  const countriesArg = process.argv.find((a) => a.startsWith("--countries="));
  const apply = process.argv.includes("--apply");
  if (!apply) console.log(`[flag-nonnative-obscure-taxa] DRY RUN: pass --apply to actually change region_species`);

  const nameFilter = countriesArg ? new Set(countriesArg.split("=")[1].split(",")) : null;

  const countriesRes = await pool.query<{ id: string; name: string }>(
    `SELECT c.id, c.name
     FROM regions c
     WHERE c.external_codes[1] ~ '^[A-Z]{3}$'
       AND EXISTS (SELECT 1 FROM regions p WHERE p.parent_id = c.id AND p.boundary_geojson IS NOT NULL)
     ORDER BY c.name`,
  );
  const countries = nameFilter ? countriesRes.rows.filter((c) => nameFilter.has(c.name)) : countriesRes.rows;
  const countryIds = countries.map((c) => c.id);
  console.log(`[flag-nonnative-obscure-taxa] ${countries.length} countries in scope`);

  // One row per species with all its in-scope countries aggregated, so iNat is asked once per species.
  const candidatesRes = await pool.query<SpeciesCandidateRow>(
    `SELECT s.id AS species_id, s.scientific_name, s.common_name, s.inat_taxon_id,
            array_agg(DISTINCT country.id) AS country_ids,
            array_agg(DISTINCT country.name) AS country_names
     FROM region_species rs
     JOIN species s ON s.id = rs.species_id
     JOIN regions r ON r.id = rs.region_id
     JOIN regions country ON country.id = r.parent_id
     WHERE country.id = ANY($1)
       AND s.taxon_class = ANY($2)
       AND COALESCE(rs.is_vagrant, false) = false
       AND COALESCE(rs.is_invasive, false) = false
     GROUP BY s.id, s.scientific_name, s.common_name, s.inat_taxon_id
     ORDER BY s.scientific_name`,
    [countryIds, NEW_OBSCURE_TAXON_CLASSES],
  );
  console.log(`[flag-nonnative-obscure-taxa] ${candidatesRes.rows.length} distinct species to check`);

  const countryById = new Map(countries.map((c) => [c.id, c]));
  const countryInatPlaceIdCache = new Map<string, number | null>();

  let totalDeleted = 0;
  let totalMarkedInvasive = 0;
  let checkedCount = 0;
  const introducedSpeciesSeen = new Map<string, { scientificName: string; commonName: string; countries: string[] }>();
  const naturalizedSpeciesSeen = new Map<string, { scientificName: string; commonName: string; countries: string[] }>();

  await mapWithConcurrency(candidatesRes.rows, CONCURRENCY, async (candidate) => {
    const taxonId = candidate.inat_taxon_id ?? (await resolveCurrentInatTaxonId(candidate.scientific_name));
    if (!taxonId) {
      checkedCount++;
      if (checkedCount % 500 === 0) console.log(`[flag-nonnative-obscure-taxa] ${checkedCount}/${candidatesRes.rows.length} checked so far`);
      return; // no iNat taxon resolvable: no verdict possible, leave untouched
    }

    const byPlaceId = await fetchListedTaxaByPlace(taxonId);
    const deletedCountries: string[] = [];
    const invasiveCountries: string[] = [];

    for (let j = 0; j < candidate.country_ids.length; j++) {
      const countryId = candidate.country_ids[j];
      const country = countryById.get(countryId);
      if (!country) continue;

      if (!countryInatPlaceIdCache.has(countryId)) {
        countryInatPlaceIdCache.set(countryId, await resolveInatPlaceId(countryId, country.name, true, null));
      }
      const countryInatPlaceId = countryInatPlaceIdCache.get(countryId);
      if (!countryInatPlaceId) continue; // no iNat place resolved for this country: no verdict possible

      const ancestry = await resolveCountryAncestry(countryInatPlaceId);
      let means: EstablishmentMeans | null = null;
      for (const placeId of ancestry) {
        if (byPlaceId[placeId]) {
          means = byPlaceId[placeId];
          break; // nearest-first ancestry: the first match is the most specific curated verdict
        }
      }

      if (means === "introduced") {
        deletedCountries.push(country.name);
        totalDeleted++;
        if (apply) {
          await pool.query(
            `DELETE FROM region_species
             WHERE species_id = $1
               AND region_id IN (SELECT id FROM regions WHERE parent_id = $2)`,
            [candidate.species_id, countryId],
          );
        }
      } else if (means === "naturalized" || means === "invasive") {
        invasiveCountries.push(country.name);
        totalMarkedInvasive++;
        if (apply) {
          await pool.query(
            `UPDATE region_species SET is_invasive = true
             WHERE species_id = $1
               AND region_id IN (SELECT id FROM regions WHERE parent_id = $2)`,
            [candidate.species_id, countryId],
          );
        }
      }
    }

    if (deletedCountries.length > 0) {
      introducedSpeciesSeen.set(candidate.species_id, {
        scientificName: candidate.scientific_name,
        commonName: candidate.common_name,
        countries: deletedCountries,
      });
    }
    if (invasiveCountries.length > 0) {
      naturalizedSpeciesSeen.set(candidate.species_id, {
        scientificName: candidate.scientific_name,
        commonName: candidate.common_name,
        countries: invasiveCountries,
      });
    }
    checkedCount++;
    if (deletedCountries.length > 0 || invasiveCountries.length > 0) {
      console.log(
        `[flag-nonnative-obscure-taxa] ${checkedCount}/${candidatesRes.rows.length} ${candidate.common_name}: ` +
          `removed from ${deletedCountries.length} countr${deletedCountries.length === 1 ? "y" : "ies"}, ` +
          `marked invasive in ${invasiveCountries.length}`,
      );
    } else if (checkedCount % 500 === 0) {
      console.log(`[flag-nonnative-obscure-taxa] ${checkedCount}/${candidatesRes.rows.length} checked so far`);
    }
  });

  console.log(
    `[flag-nonnative-obscure-taxa] done. ${candidatesRes.rows.length} distinct species checked, ` +
      `${introducedSpeciesSeen.size} flagged introduced (${totalDeleted} region removals), ` +
      `${naturalizedSpeciesSeen.size} flagged naturalized/invasive (${totalMarkedInvasive} regions kept+flagged).`,
  );

  const reviewPath = path.join(REPO_ROOT, "packages/data-pipeline/data/nonnative-obscure-taxa-review.json");
  writeFileSync(
    reviewPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        introduced: [...introducedSpeciesSeen.entries()].map(([speciesId, v]) => ({ speciesId, ...v })),
        naturalizedOrInvasive: [...naturalizedSpeciesSeen.entries()].map(([speciesId, v]) => ({ speciesId, ...v })),
      },
      null,
      2,
    ),
  );
  console.log(`[flag-nonnative-obscure-taxa] full review list written to ${reviewPath}`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
