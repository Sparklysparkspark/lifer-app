// Read-only reverse check, the opposite direction of compute-provinces-bulk.ts's own
// iNaturalist rescue pass: that pass uses Research Grade presence to RESCUE a species GBIF's own
// pattern check would exclude/flag; this instead looks at species GBIF's check already ACCEPTED
// (is_vagrant = false, currently on the checklist) and asks whether iNaturalist Research Grade
// has ever documented that species in this exact region at all.
//
// Zero Research Grade records for an already-included species doesn't prove it's wrong — Research
// Grade requires two independent identifiers to agree, which a genuinely rare or hard-to-
// photograph species can fail even when it's real. But it's still a real, worth-a-human-look
// signal, especially for taxa GBIF's own inclusion floor barely gates at all: fish specifically
// (FISH_MIN_RECORDS = 1 in build-region-species.ts — a SINGLE GBIF record is enough to include a
// fish and mark it non-vagrant), where bad data (a misidentification, a bad coordinate, an
// aquarium-trade escapee with no captive flag) slips through easiest. This makes no DB writes —
// see report-vagrant-ebird.ts for the sibling read-only pattern this follows.
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

// Walks a region's own parent chain to find its country — the nearest ancestor whose OWN
// parent is a continent (itself a direct child of World). Done in JS against an in-memory map
// rather than a SQL self-join: the region tree is only ~5000 rows total, and a chain walk here
// is far easier to get right than encoding "country = the region two or three levels up,
// depending on whether this row is a province or a country itself" as a single SQL expression.
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

  // Every currently-included (is_vagrant = false), non-manually-overridden species/region pair,
  // optionally scoped to a taxon — manual overrides are an explicit human decision already, so a
  // mismatch there isn't worth re-litigating here. Country filtering happens below in JS, after
  // each region's country has been resolved via findCountry.
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
