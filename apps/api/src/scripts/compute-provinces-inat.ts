// Fills in province/state-level checklists using iNaturalist Research Grade data as the primary
// source, instead of compute-provinces-bulk.ts's GBIF-SQL-download pipeline — for the ~4,300
// province-level regions worldwide that have never had a checklist computed at all (country-
// level coverage is close to complete; province-level lagged far behind it). No GBIF download,
// no point-matching scan, no rarity/hotspot computation: just "does this species already in our
// catalog have Research Grade iNaturalist records in this exact place," which is both lighter
// (one place lookup + one paginated fetch per region, entirely cached/incremental after the
// first pass — see inatChecklist.ts) and, per the user's own read, likely more thorough than
// GBIF's raw-record coverage for the same regions.
//
// Deliberately does NOT create new species — only links species ALREADY in the catalog to a
// region (see this file's is_other_taxa exclusion below). A taxon iNaturalist has but Lifer has
// no dataset for (insects, plants, fungi, ...) is exactly what Settings > Species & Import's
// any-taxa search is for instead — this script isn't a backdoor bulk importer for that.
//
// No rarity/hotspot/weekly-frequency data gets computed here (local_tier/local_frequency/
// weekly_frequency all stay NULL) — GBIF's own point data is still what drives those, for
// whichever species/region combination has it. A province filled in by this script just shows
// an unrated checklist until (if ever) a real GBIF pass covers it too; that's a strictly better
// state than "not on the checklist at all," which is what every one of these regions has today.
//
// Usage: npx tsx src/scripts/compute-provinces-inat.ts [--limit=N] [--apply]
import "../config.js"; // loads .env from the repo root before anything below reads process.env
import { pool } from "../db.js";
import { resolveInatPlaceId, fetchInatResearchGradeTaxa } from "./inatChecklist.js";

interface RegionRow {
  id: string;
  name: string;
  parent_id: string | null;
}

function findCountry(regionId: string, byId: Map<string, RegionRow>): RegionRow | null {
  let current = byId.get(regionId);
  while (current) {
    const parent = current.parent_id ? byId.get(current.parent_id) : null;
    const grandparent = parent?.parent_id ? byId.get(parent.parent_id) : null;
    if (parent && grandparent?.name === "World") return current;
    if (!parent) return null;
    current = parent;
  }
  return null;
}

async function main() {
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : null;
  const apply = process.argv.includes("--apply");
  if (!apply) console.log(`[compute-provinces-inat] DRY RUN — pass --apply to actually write region_species`);

  const regionRowsRes = await pool.query<RegionRow>(`SELECT id, name, parent_id FROM regions`);
  const regionsById = new Map(regionRowsRes.rows.map((r) => [r.id, r]));

  // Province-level = has a boundary, has a parent, and that parent is NOT a continent (i.e. this
  // region itself isn't a country) — same shape findCountry itself checks, just filtering the
  // candidate set down first instead of calling findCountry on literally every region row.
  const provincesRes = await pool.query<{ id: string; name: string }>(
    `SELECT r.id, r.name FROM regions r
     WHERE r.boundary_geojson IS NOT NULL
       AND r.parent_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM regions cont WHERE cont.id = r.parent_id
         AND EXISTS (SELECT 1 FROM regions w WHERE w.id = cont.parent_id AND w.name = 'World')
       )
       AND NOT EXISTS (SELECT 1 FROM region_species rs WHERE rs.region_id = r.id)
     ORDER BY r.name`,
  );
  const provinces = limit ? provincesRes.rows.slice(0, limit) : provincesRes.rows;
  console.log(`[compute-provinces-inat] ${provinces.length} province(s) with no existing checklist to fill`);

  const countryPlaceIdCache = new Map<string, number | null>();
  let filled = 0;
  let skippedNoPlace = 0;
  let skippedNoSpecies = 0;
  let totalLinked = 0;
  let done = 0;

  for (const province of provinces) {
    done++;
    const country = findCountry(province.id, regionsById);
    if (!country) {
      skippedNoPlace++;
      continue;
    }

    if (!countryPlaceIdCache.has(country.id)) {
      countryPlaceIdCache.set(country.id, await resolveInatPlaceId(country.id, country.name, true, null));
    }
    const countryPlaceId = countryPlaceIdCache.get(country.id) ?? null;

    const provincePlaceId = await resolveInatPlaceId(province.id, province.name, false, countryPlaceId);
    if (provincePlaceId == null) {
      skippedNoPlace++;
      if (done % 50 === 0 || done === provinces.length) {
        console.log(`[compute-provinces-inat] ${done}/${provinces.length} processed (${filled} filled, ${totalLinked} species linked so far)`);
      }
      continue;
    }

    const taxa = await fetchInatResearchGradeTaxa(provincePlaceId);
    if (!taxa || taxa.size === 0) {
      skippedNoSpecies++;
      if (done % 50 === 0 || done === provinces.length) {
        console.log(`[compute-provinces-inat] ${done}/${provinces.length} processed (${filled} filled, ${totalLinked} species linked so far)`);
      }
      continue;
    }

    // Pass 1: species already carrying this exact inat_taxon_id.
    const taxonIds = [...taxa.keys()];
    const byIdRes = await pool.query<{ id: string; inat_taxon_id: number }>(
      `SELECT id, inat_taxon_id FROM species WHERE inat_taxon_id = ANY($1) AND is_other_taxa = false`,
      [taxonIds],
    );
    const matchedSpeciesIds = new Set(byIdRes.rows.map((r) => r.id));
    const matchedTaxonIds = new Set(byIdRes.rows.map((r) => r.inat_taxon_id));

    // Pass 2: species with no inat_taxon_id yet, matched by exact scientific name — backfills
    // inat_taxon_id in the same query so every later province's pass-1 lookup benefits, same
    // "move stuff around, don't re-enrich" reasoning as the rest of this feature.
    const unmatchedTaxa = [...taxa.entries()].filter(([id]) => !matchedTaxonIds.has(id));
    if (unmatchedTaxa.length > 0) {
      const names = unmatchedTaxa.map(([, name]) => name);
      const byNameRes = await pool.query<{ id: string; scientific_name: string }>(
        `SELECT id, scientific_name FROM species WHERE scientific_name = ANY($1) AND inat_taxon_id IS NULL AND is_other_taxa = false`,
        [names],
      );
      const idByName = new Map(unmatchedTaxa.map(([id, name]) => [name, id]));
      for (const row of byNameRes.rows) {
        const taxonId = idByName.get(row.scientific_name);
        if (!taxonId) continue;
        matchedSpeciesIds.add(row.id);
        if (apply) await pool.query(`UPDATE species SET inat_taxon_id = $1 WHERE id = $2`, [taxonId, row.id]);
      }
    }

    if (matchedSpeciesIds.size === 0) {
      skippedNoSpecies++;
    } else {
      filled++;
      totalLinked += matchedSpeciesIds.size;
      if (apply) {
        await pool.query(
          `INSERT INTO region_species (region_id, species_id, is_vagrant, is_invasive)
           SELECT $1, unnest($2::uuid[]), false, false
           ON CONFLICT (region_id, species_id) DO NOTHING`,
          [province.id, [...matchedSpeciesIds]],
        );
      }
    }

    if (done % 50 === 0 || done === provinces.length) {
      console.log(
        `[compute-provinces-inat] ${done}/${provinces.length} processed — ${filled} filled (${totalLinked} species linked), ` +
          `${skippedNoPlace} skipped (no iNat place), ${skippedNoSpecies} skipped (no catalog matches)`,
      );
    }
  }

  console.log(
    `[compute-provinces-inat] done. ${filled}/${provinces.length} provinces filled, ${totalLinked} species links written, ` +
      `${skippedNoPlace} skipped (no resolvable iNat place), ${skippedNoSpecies} skipped (iNat had records but none matched the catalog).`,
  );
  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
