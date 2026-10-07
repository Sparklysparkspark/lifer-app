// Puts species new to the catalog onto the province and country checklists already built, without
// rebuilding them. The catalog stage (packages/data-pipeline add-missing-species.ts) adds species
// found on iNaturalist research-grade lists or eBird's taxonomy; a province built before that has
// no row for them. This adds each new species to every province whose cached iNaturalist list
// has it (by taxon id), and each new eBird-only bird to every province whose cached eBird list
// has its code, the same evidence a full build would have accepted. No network: caches only.
// Species the catalog marks as introduced in the country are flagged, as the full build does.
// Tiers and records are filled in afterwards by the tiers stage; country lists by
// build-country-checklists.ts.
//
// "New" means a catalog species with a synthetic gbif_key (< 0), outside Other Taxa: what the
// catalog stage adds. Safe to rerun: rows that exist are left alone.
//
// Usage (from packages/data-pipeline): npx tsx src/scripts/add-new-species-to-checklists.ts [--apply]
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "@lifer/core/db.js";
import { cachedPlaceCounts } from "@lifer/core/regions/inatChecklist.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const EBIRD_CACHE_DIR = path.join(REPO_ROOT, "packages/data-pipeline/data/ebird-spplist-cache");
const INAT_CACHE_DIR = path.join(REPO_ROOT, "packages/data-pipeline/data/inat-species-counts-cache");

/** Taxon ids on a place's cached list, with or without counts. */
function cachedPlaceTaxonIds(placeId: number): Set<number> | null {
  const counts = cachedPlaceCounts(placeId);
  if (counts) return new Set(counts.keys());
  const file = path.join(INAT_CACHE_DIR, `${placeId}.json`);
  if (!existsSync(file)) return null;
  const d = JSON.parse(readFileSync(file, "utf8")) as { taxa?: Array<{ id: number }> };
  return d.taxa ? new Set(d.taxa.map((t) => t.id)) : null;
}

/** eBird species codes on a region's cached eBird list (every species ever reported there). */
export function cachedEbirdCodes(regionCode: string): Set<string> | null {
  const file = path.join(EBIRD_CACHE_DIR, `${regionCode}.json`);
  if (!existsSync(file)) return null;
  return new Set(JSON.parse(readFileSync(file, "utf8")) as string[]);
}

export async function addNewSpeciesToChecklists(apply: boolean): Promise<{ provinces: number; rows: number }> {
  const newSpecies = await pool.query<{ id: string; inat_taxon_id: number | null; ebird_code: string | null }>(
    `SELECT id, inat_taxon_id, ebird_code FROM species WHERE gbif_key < 0 AND NOT is_other_taxa`,
  );
  const byInat = new Map(newSpecies.rows.filter((s) => s.inat_taxon_id != null).map((s) => [s.inat_taxon_id!, s.id]));
  const byEbird = new Map(
    newSpecies.rows.filter((s) => s.inat_taxon_id == null && s.ebird_code).map((s) => [s.ebird_code!, s.id]),
  );

  // Provinces: regions directly under a country (World > continent > country > province).
  const provinces = await pool.query<{
    id: string;
    inat_place_id: number | null;
    ebird_region_code: string | null;
    iso3: string[];
  }>(
    `SELECT r.id, r.inat_place_id, r.ebird_region_code, c.external_codes AS iso3
     FROM regions r JOIN regions c ON c.id = r.parent_id JOIN regions cont ON cont.id = c.parent_id
     JOIN regions w ON w.id = cont.parent_id AND w.parent_id IS NULL`,
  );
  let touched = 0;
  let rows = 0;
  for (const p of provinces.rows) {
    const add = new Set<string>();
    const taxa = p.inat_place_id != null ? cachedPlaceTaxonIds(p.inat_place_id) : null;
    if (taxa) for (const id of taxa) if (byInat.has(id)) add.add(byInat.get(id)!);
    const codes = p.ebird_region_code ? cachedEbirdCodes(p.ebird_region_code) : null;
    if (codes) for (const code of codes) if (byEbird.has(code)) add.add(byEbird.get(code)!);
    if (add.size === 0) continue;
    touched++;
    if (!apply) {
      rows += add.size;
      continue;
    }
    const res = await pool.query(
      `INSERT INTO region_species (region_id, species_id, is_vagrant, is_invasive, evidence_source)
       SELECT $1, id, EXISTS (SELECT 1 FROM species_nonnative_countries snc WHERE snc.species_id = id AND snc.country_iso3 = ANY($3)), false, 'inat'
       FROM unnest($2::uuid[]) AS id
       ON CONFLICT (region_id, species_id) DO NOTHING`,
      [p.id, [...add], p.iso3],
    );
    rows += res.rowCount ?? 0;
  }
  return { provinces: touched, rows };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const apply = process.argv.includes("--apply");
  addNewSpeciesToChecklists(apply)
    .then(async (r) => {
      console.log(`[new-species] ${apply ? "added" : "would add"} ${r.rows} rows across ${r.provinces} provinces`);
      await pool.end();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
