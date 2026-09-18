// Cross-checks reptiles/amphibians/marine-invertebrates already on a checklist against
// iNaturalist's own curated establishment_means — the field iNat's taxon-framework maintainers
// set to "native"/"endemic"/"introduced"/"naturalized"/"invasive"/"managed" per taxon per place,
// independent of any individual observation.
//
// Why this pass exists (see compute-provinces-bulk.ts's own reconcileProvinceMembershipWithInat):
// a species only needs ONE Research Grade iNat observation in a place to survive that pass's
// membership check, and Research Grade requires the observer (or community) to mark an
// observation "not captive/cultivated" — a checkbox, not an automatic detection. A pet corn
// snake or tortoise photographed at home, posted without that box ticked and never challenged by
// the community, reaches Research Grade despite never having been wild in that country.
// establishment_means is the one signal actually curated to answer "does iNat consider this
// species established here," not "was a photo of it taken here."
//
// One request PER SPECIES, not per (species, country) pair: GET /v1/taxa/{id} (no
// preferred_place_id) returns that taxon's full listed_taxa — every place iNat's curators have
// an establishment_means verdict for, all at once (confirmed live: a single request for the Corn
// Snake returned 100 place verdicts spanning Europe, Africa, the Bahamas, Italy, South Africa,
// ...). A globally-traded pet species that shows up as a checklist candidate in 80 different
// countries used to cost 80 separate paced requests; now it costs exactly one, and the result is
// a reusable per-species whitelist (disk-cached) rather than a throwaway per-country answer.
// iNat caps the embedded listed_taxa array at 100 entries even when listed_taxa_count is higher —
// for the rare species curated in more than 100 places, any of our candidate countries past that
// cutoff simply gets no verdict (the existing conservative default: no evidence, no action), not
// a wrong one.
//
// A species' own listed_taxa entries are often curated at continent grain ("Europe",
// "North America"), not always at the exact country we're asking about — resolveCountryAncestry
// mirrors what passing preferred_place_id would have resolved automatically, by walking each
// candidate country's own ancestor_place_ids (cached once per country, ~232 total, negligible
// next to the species-level savings) and checking every ancestor for a listed_taxa match, not
// just the country's own exact place id.
//
// Deliberately conservative in both directions:
//   - "introduced" alone (no naturalized/invasive) → DELETE the region_species row entirely, not
//     just flag it. A captive-only occurrence isn't a rare-but-real wild sighting (that's what
//     is_vagrant already means, e.g. a storm-blown bird) — it's not a wild occurrence at all.
//   - "naturalized" or "invasive" → kept, with is_invasive set true. A real, self-sustaining wild
//     population is a legitimate photography target even though it isn't native.
//   - "native"/"endemic", or no verdict on record at all (including the 100-entry truncation
//     case above) → left untouched. Absence of evidence isn't evidence of absence; only an
//     explicit "introduced" verdict removes anything.
//
// Usage: npx tsx src/scripts/flag-nonnative-obscure-taxa.ts [--countries=Canada,Portugal] [--apply]
import "../config.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../db.js";
import { resolveInatPlaceId, resolveCurrentInatTaxonId, fetchWithHardTimeout } from "./inatChecklist.js";
import { mapWithConcurrency } from "data-pipeline/src/concurrency.js";

// Root cause of three separate "the scan is stuck" false alarms: this loop used to run fully
// sequential (one species, one iNat request, awaited before starting the next), and progress
// only logs every 500 species — so a run that's actually alive and crawling looked identical,
// from the outside, to a genuine hang for the several minutes it took to clear one batch of
// 500 requests. Bounded concurrency (matching every other per-item-HTTP-call script in this
// codebase, e.g. build-seed-marine-mollusks.ts's GBIF_CONCURRENCY) turns those minutes into
// seconds and removes the ambiguity, not just the wait.
const CONCURRENCY = 8;

// scripts -> src -> api -> apps -> lifer-app is 4 levels up, not 5 — confirmed live: the extra
// ".." silently wrote every cache in this file one directory ABOVE the actual repo (as
// /Users/.../Development/packages/... instead of /Users/.../Development/lifer-app/packages/...).
// Self-consistent (every read/write in a given script invocation agrees), so it never crashed
// anything — just meant these caches lived outside the repo entirely, uncommitted and easy to
// lose. inatChecklist.ts has this exact same off-by-one in its own REPO_ROOT; not fixed here
// since correcting it there would orphan every cache entry already built up during in-flight
// background jobs mid-run.
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

// Same pacing shape as inatChecklist.ts's own paceInatTaxaRequest — kept separate rather than
// shared since this script now makes roughly one request per DISTINCT SPECIES plus one per
// distinct country (for ancestor resolution), a completely different call shape than that file's
// own per-province calls, and sharing one lastRequestAt clock across two concurrently-run scripts
// would just make both slower for no benefit.
const INAT_REQUEST_INTERVAL_MS = 1000;
let lastRequestAt = 0;
async function paceRequest(): Promise<void> {
  const wait = lastRequestAt + INAT_REQUEST_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

type EstablishmentMeans = "native" | "endemic" | "introduced" | "naturalized" | "invasive" | "managed" | "captive";

// Disk-persisted per taxon id: every place iNat has a curated verdict for, keyed by that place's
// own iNat place id. A species' real-world curation doesn't change run to run, so once fetched
// this never needs asking again — the same "durable, not just in-memory" reasoning as
// inatChecklist.ts's own INAT_CURRENT_TAXON_CACHE_PATH.
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

// Returns every place this taxon has a curated establishment_means verdict for, keyed by place
// id — see this file's own header comment on the 100-entry cap.
//
// Retries with backoff and, critically, only persists to disk on a CONFIRMED successful fetch —
// confirmed live: a single transient timeout on the Common Wall Lizard's own request got cached
// as an empty {} result, which then silently read back as "no curated data anywhere" on every
// later run and made a species that's genuinely flagged "introduced" for Canada look like it had
// no verdict at all. Same failure-vs-confirmed-empty distinction inatChecklist.ts's own
// fetchSpeciesCountsPages comment already calls out — a failure must retry or return nothing
// cacheable, never get entombed as if it were a real answer.
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
      if (!res.ok) continue; // transient (rate limit, 5xx) — retry rather than cache a blank
      const data = (await res.json()) as { results: Array<{ listed_taxa?: ListedTaxon[] }> };
      const listedTaxa = data.results[0]?.listed_taxa ?? [];
      const byPlaceId: Record<number, EstablishmentMeans> = {};
      for (const lt of listedTaxa) {
        if (lt.place?.id && lt.establishment_means) {
          byPlaceId[lt.place.id] = lt.establishment_means as EstablishmentMeans;
        }
      }
      saveListedTaxaDiskCache(taxonId, byPlaceId); // confirmed successful fetch — an empty result here is a real "no curated data"
      return byPlaceId;
    } catch {
      // timed out or a network-level failure — fall through to the backoff/retry above
    }
  }
  return {}; // exhausted all retries — deliberately NOT cached, so the next run tries again fresh
}

// Disk-persisted per country iNat place id — a country's own ancestor chain (itself plus every
// continent/region it belongs to) never changes, so this is a true one-time cost regardless of
// how many runs this script sees.
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

// A country's own place id plus every continent/region ancestor above it, nearest first — a
// species curated at "Europe" rather than "Portugal" specifically still needs to resolve against
// a Portugal lookup, the same resolution passing preferred_place_id would have done automatically
// on a per-country request; walking this ourselves is the price of asking iNat once per SPECIES
// instead of once per (species, country) pair.
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
      // Nearest-first (own id last in iNat's own ancestor_place_ids ordering — reverse it) so a
      // country-specific verdict is always preferred over a broader continent-level one when
      // both happen to exist for the same taxon.
      if (fetched && fetched.length > 0) ancestorPlaceIds = [...fetched].reverse();
    }
  } catch {
    // best-effort — falls back to just the country's own place id, still correct, just narrower
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
  if (!apply) console.log(`[flag-nonnative-obscure-taxa] DRY RUN — pass --apply to actually change region_species`);

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

  // One row per SPECIES, with every one of our in-scope candidate countries it currently sits on
  // the checklist for aggregated in — this is the query shape that actually delivers the
  // "one request per species" saving described above, rather than iterating country-by-country.
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
      return; // no iNat taxon resolvable — no verdict possible, leave untouched
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
      if (!countryInatPlaceId) continue; // no iNat place resolved for this country — no verdict possible

      const ancestry = await resolveCountryAncestry(countryInatPlaceId);
      let means: EstablishmentMeans | null = null;
      for (const placeId of ancestry) {
        if (byPlaceId[placeId]) {
          means = byPlaceId[placeId];
          break; // nearest-first ancestry — first match is the most specific curated verdict
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
