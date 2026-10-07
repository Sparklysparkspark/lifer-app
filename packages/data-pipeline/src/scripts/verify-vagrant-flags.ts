// Cross-checks algorithmic vagrant flags (from thin GBIF record density) against GBIF's
// species/{key}/distributions, checklist range data from taxonomic authorities with a country and
// establishmentMeans, or a broad named realm. One call per species covers all its flags.
//
// Outcomes per (region, species) vagrant flag:
//   1. Country is in the native set, or inside a native realm: clear the flag.
//   2. Country is in the introduced set: also clear it (an established population, not a
//      vagrant). Tagging it invasive stays a manual decision.
//   3. No signal: keep the flag and log it to VAGRANT_NEEDS_SEARCH_LOG for a web-search pass.
//
// Resumable per species via species_traits.vagrant_checked_at.
import { writeFileSync, appendFileSync, existsSync } from "node:fs";
import { pool } from "@lifer/core/db.js";
import { fetchWithRetry } from "@lifer/core/lib/fetchWithRetry.js";
import { fetchAllCountries } from "@lifer/core/regions/regionBoundary.js";
import { mapWithConcurrency } from "@lifer/core/lib/concurrency.js";
import { vagrantReportPath } from "./vagrantReports.js";

const CONCURRENCY = 4;
const VAGRANT_NEEDS_SEARCH_LOG = vagrantReportPath("vagrant-needs-search.jsonl");

// `locality` is free text. Only these unambiguous realm names map to continents; anything else is
// left unmapped so uncertain cases go to the needs-search log instead of clearing a flag.
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
      // A country entry with no stated means counts as native range too.
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
    // Walk up until the parent is a continent; `current` is then the country.
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
