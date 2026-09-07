// World-scale vagrant-flag cross-check. The algorithmic vagrant flag (compute-provinces-bulk.ts)
// is derived from GBIF occurrence-record density in a region — thin records there can mean
// "genuinely rare/vagrant" OR just "algorithm hasn't seen enough data" (the same class of bug
// that mislabeled Emperor Goose as merely hard-to-find in BC). This re-checks each flagged
// species against GBIF's own `species/{key}/distributions` endpoint, which is NOT occurrence
// records — it's checklist-sourced range data from independent taxonomic authorities (IOC World
// Bird List, Catalogue of Life, ITIS, IUCN Red List, national alien-species registries), each
// entry carrying either a real country code + establishmentMeans (NATIVE/INTRODUCED) or a
// broad named region (e.g. "North America", "PAL" for Palearctic).
//
// One GBIF call per species (not per region, not per country) resolves every place that species
// is flagged vagrant at once — a species' native range is one fact, not one fact per country.
//
// Three outcomes per (region, species) vagrant flag:
//   1. The flagged country appears in the species' own NATIVE establishmentMeans set, or falls
//      within one of its named native/breeding realms (mapped to our continent set below) ->
//      clear the vagrant flag (false positive, same fix category as Emperor Goose).
//   2. The flagged country appears in the species' INTRODUCED establishmentMeans set -> also
//      clear the vagrant flag (this is an established non-native population, not a vagrant one-
//      off; whether it should be tagged "Invasive" is a separate, deliberately manual decision
//      per region_species_manual_overrides.is_invasive, never auto-inferred).
//   3. No signal either way -> leave the flag as-is, but log the (region, species, country)
//      triple to VAGRANT_NEEDS_SEARCH_LOG for a follow-up real web-search pass, per the explicit
//      instruction that ambiguous cases get a search rather than a guess.
//
// Idempotent per species via species_traits.vagrant_checked_at (086_vagrant_checked_at.sql) —
// a killed/resumed run picks up where it left off without re-spending GBIF calls already paid
// for, same pattern as verify-and-label-endemics.ts's endemic_checked_at gate.
import { writeFileSync, appendFileSync, existsSync } from "node:fs";
import { pool } from "../db.js";
import { fetchWithRetry } from "data-pipeline/src/fetch-with-retry.js";
import { fetchAllCountries } from "data-pipeline/src/fetch/fetch-region-boundary.js";
import { mapWithConcurrency } from "data-pipeline/src/concurrency.js";

const CONCURRENCY = 4;
const VAGRANT_NEEDS_SEARCH_LOG = "/Users/judahstarkey/.claude/jobs/d9ace272/tmp/vagrant-needs-search.jsonl";

// GBIF's distributions `locality` field is free text sourced from whichever checklist supplied
// the record — sometimes a real country, sometimes a named biogeographic realm, sometimes a
// marine region or a small island group. Only the realm phrases below are common/unambiguous
// enough to map to one of our own continent regions with confidence; anything else (marine
// regions, "Global", named islands, unrecognized phrasing) is left unmapped rather than guessed,
// so an uncertain match falls through to the needs-search log instead of silently clearing a
// flag that might be wrong.
const REALM_TO_CONTINENTS: Record<string, string[]> = {
  "north america": ["North America"],
  "central america": ["North America"],
  "south america": ["South America"],
  "europe & northern asia (excluding china)": ["Europe", "Asia"],
  pal: ["Europe", "Asia"],
  palearctic: ["Europe", "Asia"],
  "southern asia": ["Asia"],
  asia: ["Asia"],
  europe: ["Europe"],
  africa: ["Africa"],
  oceania: ["Oceania"],
  antarctica: ["Antarctica"],
};

interface GbifDistribution {
  locality?: string;
  country?: string;
  establishmentMeans?: string;
  status?: string;
}

async function fetchDistributions(gbifKey: number): Promise<GbifDistribution[]> {
  const all: GbifDistribution[] = [];
  let offset = 0;
  for (;;) {
    const res = await fetchWithRetry(
      `https://api.gbif.org/v1/species/${gbifKey}/distributions?limit=200&offset=${offset}`,
      { method: "GET" },
    );
    if (!res.ok) return all;
    const data = (await res.json()) as { results: GbifDistribution[]; endOfRecords: boolean };
    all.push(...data.results);
    if (data.endOfRecords) break;
    offset += 200;
  }
  return all;
}

function classifySpecies(distributions: GbifDistribution[]): {
  nativeIso2: Set<string>;
  introducedIso2: Set<string>;
  nativeContinents: Set<string>;
} {
  const nativeIso2 = new Set<string>();
  const introducedIso2 = new Set<string>();
  const nativeContinents = new Set<string>();

  for (const d of distributions) {
    if (d.country) {
      const iso2 = d.country.toUpperCase();
      if (d.establishmentMeans === "INTRODUCED") introducedIso2.add(iso2);
      // NATIVE, or PRESENT with no establishmentMeans stated on a real-country entry, both read
      // as "this checklist places the species here as part of its normal range" — the absence of
      // an explicit means on a country-level (not realm-level) entry is not the same ambiguity as
      // a bare realm name with no country at all, so it's treated as a native signal too.
      else nativeIso2.add(iso2);
      continue;
    }
    if (!d.locality) continue;
    const key = d.locality.trim().toLowerCase();
    const continents = REALM_TO_CONTINENTS[key];
    if (continents) for (const c of continents) nativeContinents.add(c);
  }
  return { nativeIso2, introducedIso2, nativeContinents };
}

interface RegionNode {
  id: string;
  name: string;
  parentId: string | null;
}

async function buildRegionCountryMap(): Promise<Map<string, { countryName: string; continentName: string }>> {
  const res = await pool.query<{ id: string; name: string; parent_id: string | null }>(
    `SELECT id, name, parent_id FROM regions`,
  );
  const byId = new Map<string, RegionNode>();
  for (const r of res.rows) byId.set(r.id, { id: r.id, name: r.name, parentId: r.parent_id });

  const world = res.rows.find((r) => r.name === "World" && r.parent_id === null);
  if (!world) throw new Error("Could not find World root region");
  const continentIds = new Set(res.rows.filter((r) => r.parent_id === world.id).map((r) => r.id));

  const map = new Map<string, { countryName: string; continentName: string }>();
  for (const r of res.rows) {
    let current = byId.get(r.id)!;
    // Walk up until `current`'s parent is a continent — that makes `current` the country node,
    // whether r itself (a non-split country) or an ancestor of r (a province of a split country).
    const path: RegionNode[] = [current];
    let guard = 0;
    while (current.parentId && !continentIds.has(current.parentId) && guard++ < 10) {
      const parent = byId.get(current.parentId);
      if (!parent) break;
      current = parent;
      path.push(current);
    }
    if (!current.parentId || !continentIds.has(current.parentId)) continue; // continent/World itself, or malformed
    const continent = byId.get(current.parentId)!;
    map.set(r.id, { countryName: current.name, continentName: continent.name });
  }
  return map;
}

async function main() {
  if (!existsSync(VAGRANT_NEEDS_SEARCH_LOG)) writeFileSync(VAGRANT_NEEDS_SEARCH_LOG, "");

  console.log("[verify-vagrant] building region->country map...");
  const regionCountryMap = await buildRegionCountryMap();

  console.log("[verify-vagrant] loading country name -> iso2...");
  const countries = await fetchAllCountries();
  const nameToIso2 = new Map(countries.filter((c) => c.iso2).map((c) => [c.name, c.iso2 as string]));

  const res = await pool.query<{ species_id: string; gbif_key: number; scientific_name: string }>(`
    SELECT DISTINCT s.id AS species_id, s.gbif_key, s.scientific_name
    FROM species s
    JOIN species_traits t ON t.species_id = s.id
    JOIN region_species rs ON rs.species_id = s.id
    WHERE rs.is_vagrant = true AND t.vagrant_checked_at IS NULL
    ORDER BY s.scientific_name
  `);
  console.log(`[verify-vagrant] ${res.rows.length} candidate species to check`);

  let done = 0;
  let clearedFlags = 0;
  let needsSearch = 0;
  await mapWithConcurrency(res.rows, CONCURRENCY, async (row) => {
    try {
      const distributions = await fetchDistributions(row.gbif_key);
      const { nativeIso2, introducedIso2, nativeContinents } = classifySpecies(distributions);

      const flagged = await pool.query<{ region_id: string; region_species_id: string }>(
        `SELECT region_id FROM region_species WHERE species_id = $1 AND is_vagrant = true`,
        [row.species_id],
      );

      for (const f of flagged.rows) {
        const info = regionCountryMap.get(f.region_id);
        if (!info) continue;
        const iso2 = nameToIso2.get(info.countryName);
        const isNative = iso2 && nativeIso2.has(iso2);
        const isIntroduced = iso2 && introducedIso2.has(iso2);
        const isInNativeRealm = nativeContinents.has(info.continentName);

        if (isNative || isIntroduced || isInNativeRealm) {
          const source = isNative
            ? "gbif-distributions:native-checklist"
            : isIntroduced
              ? "gbif-distributions:introduced-checklist"
              : "gbif-distributions:native-realm";
          await pool.query(
            `INSERT INTO region_species_manual_overrides (region_id, species_id, is_vagrant, source)
             VALUES ($1, $2, false, $3)
             ON CONFLICT (region_id, species_id) DO UPDATE SET is_vagrant = false, source = EXCLUDED.source`,
            [f.region_id, row.species_id, source],
          );
          await pool.query(`UPDATE region_species SET is_vagrant = false WHERE region_id = $1 AND species_id = $2`, [
            f.region_id,
            row.species_id,
          ]);
          clearedFlags++;
        } else {
          appendFileSync(
            VAGRANT_NEEDS_SEARCH_LOG,
            JSON.stringify({
              regionId: f.region_id,
              speciesId: row.species_id,
              scientificName: row.scientific_name,
              country: info.countryName,
              continent: info.continentName,
            }) + "\n",
          );
          needsSearch++;
        }
      }

      await pool.query(`UPDATE species_traits SET vagrant_checked_at = now() WHERE species_id = $1`, [
        row.species_id,
      ]);
    } catch (err) {
      console.error(`[verify-vagrant] FAILED ${row.scientific_name}:`, err);
    }
    done++;
    if (done % 50 === 0 || done === res.rows.length) {
      console.log(`[verify-vagrant] ${done}/${res.rows.length} (${clearedFlags} cleared, ${needsSearch} need search)`);
    }
  });

  console.log(
    `[verify-vagrant] done. ${done} species checked, ${clearedFlags} vagrant flags cleared, ${needsSearch} logged for follow-up search.`,
  );
  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
