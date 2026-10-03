// Read-only report: species GBIF accepted (is_vagrant = false) that iNaturalist has no Research
// Grade record of in that region. Not proof of an error (rare species may never reach Research
// Grade), but worth a human look, especially for fish, where one GBIF record is enough to list
// one. Makes no DB writes.
//
// Usage: npx tsx src/scripts/flag-vagrant-mismatch-inat.ts [--countries=France,Germany] [--taxon=actinopterygii]
import { writeFileSync, appendFileSync } from "node:fs";
import "../config.js"; // loads .env from the repo root before anything below reads process.env
import { pool } from "../db.js";
import { resolveInatPlaceId, fetchInatResearchGradeTaxonIds } from "./inatChecklist.js";

const FLAGGED_REPORT = "/Users/judahstarkey/.claude/jobs/d9ace272/tmp/vagrant-mismatch-inat.jsonl";

interface CandidateRow {
  region_id: string;
  species_id: string;
  scientific_name: string;
  common_name: string | null;
  inat_taxon_id: number | null;
}

interface RegionRow {
  id: string;
  name: string;
  parent_id: string | null;
}

// Walks up to the region's country: the ancestor whose parent is a continent.
function findCountry(regionId: string, byId: Map<string, RegionRow>): RegionRow | null {
  let current = byId.get(regionId);
  while (current) {
    const parent = current.parent_id ? byId.get(current.parent_id) : null;
    const grandparent = parent?.parent_id ? byId.get(parent.parent_id) : null;
    if (parent && grandparent?.name === "World") return current; // current's parent is a continent -> current IS the country
    if (!parent) return null;
    current = parent;
  }
  return null;
}

async function main() {
  const countriesArg = process.argv.find((a) => a.startsWith("--countries="));
  const countryNames = countriesArg ? new Set(countriesArg.split("=")[1].split(",")) : null;
  const taxonArg = process.argv.find((a) => a.startsWith("--taxon="));
  const taxonClass = taxonArg ? taxonArg.split("=")[1] : null;

  writeFileSync(FLAGGED_REPORT, "");

  const regionRowsRes = await pool.query<RegionRow>(`SELECT id, name, parent_id FROM regions`);
  const regionsById = new Map(regionRowsRes.rows.map((r) => [r.id, r]));

  // Every included (is_vagrant = false) pair without a manual override, optionally by taxon.
  // Country filtering happens below, after findCountry.
  const res = await pool.query<CandidateRow>(
    `SELECT rs.region_id, s.id AS species_id, s.scientific_name, s.common_name, s.inat_taxon_id
     FROM region_species rs
     JOIN species s ON s.id = rs.species_id
     WHERE rs.is_vagrant = false
       AND ($1::text IS NULL OR s.taxon_class = $1)
       AND NOT EXISTS (
         SELECT 1 FROM region_species_manual_overrides mo WHERE mo.region_id = rs.region_id AND mo.species_id = rs.species_id
       )`,
    [taxonClass],
  );
  console.log(`[flag-vagrant-mismatch-inat] ${res.rows.length} included (non-overridden) species/region pairs to check`);

  const byRegion = new Map<string, CandidateRow[]>();
  for (const row of res.rows) {
    const country = findCountry(row.region_id, regionsById);
    if (!country) continue; // e.g. World/continent rows, which never carry their own region_species
    if (countryNames && !countryNames.has(country.name)) continue;
    if (!byRegion.has(row.region_id)) byRegion.set(row.region_id, []);
    byRegion.get(row.region_id)!.push(row);
  }
  console.log(`[flag-vagrant-mismatch-inat] ${byRegion.size} region(s) match the given filters`);

  let flagged = 0;
  let checked = 0;
  let skippedNoPlace = 0;
  let done = 0;
  for (const [regionId, rows] of byRegion) {
    const region = regionsById.get(regionId)!;
    const country = findCountry(regionId, regionsById)!;
    const countryPlaceId = await resolveInatPlaceId(country.id, country.name, true, null);
    const placeId = region.id === country.id ? countryPlaceId : await resolveInatPlaceId(region.id, region.name, false, countryPlaceId);
    done++;
    if (placeId == null) {
      skippedNoPlace += rows.length;
      continue;
    }
    const researchGradeTaxonIds = await fetchInatResearchGradeTaxonIds(placeId);
    if (!researchGradeTaxonIds) {
      skippedNoPlace += rows.length;
      continue;
    }
    for (const row of rows) {
      checked++;
      if (row.inat_taxon_id != null && researchGradeTaxonIds.has(row.inat_taxon_id)) continue;
      flagged++;
      appendFileSync(
        FLAGGED_REPORT,
        JSON.stringify({
          regionId: row.region_id,
          regionName: region.name,
          countryName: country.name,
          speciesId: row.species_id,
          scientificName: row.scientific_name,
          commonName: row.common_name,
        }) + "\n",
      );
    }
    if (done % 20 === 0 || done === byRegion.size) {
      console.log(`[flag-vagrant-mismatch-inat] ${done}/${byRegion.size} regions checked, ${flagged} flagged so far`);
    }
  }

  console.log(
    `[flag-vagrant-mismatch-inat] done. ${checked} checked, ${flagged} have zero iNaturalist Research Grade ` +
      `records for their region (written to ${FLAGGED_REPORT} for manual/web-search verification), ` +
      `${skippedNoPlace} skipped (no resolvable iNaturalist place for that region).`,
  );
  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
