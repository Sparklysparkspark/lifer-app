// Marks which listings are introduced species, from iNaturalist's curated establishment status for
// each place, and clears the vagrant flag from natives that were only flagged vagrant through the
// distance-based species_nonnative_countries list.
//
// Per listing, with the place's introduced list (a province's own, else its country's), counting
// a taxon only when most of its observations there are of introduced populations:
//   - introduced and established (ESTABLISHED_* records over years): is_invasive, not vagrant;
//   - introduced with few records: is_invasive too, and the vagrant flag left as the province
//     build's recurrence check set it (few records alone don't make a stray);
//   - not introduced, flagged vagrant only through the old list: vagrant only when its records
//     don't show it recurring (RESIDENT_*). Flags from the province build's own recurrence check
//     are left alone.
// Then species_nonnative_countries is rewritten from the countries' iNaturalist lists, so later
// province builds read the same answer.
//
// Usage (from apps/api):
//   npx tsx src/scripts/apply-introduced-flags.ts            (fetch what's missing, preview)
//   npx tsx src/scripts/apply-introduced-flags.ts --apply
//   LIFER_INAT_OFFLINE=1 ... --apply                          (cached lists only)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../db.js";
import { cachedPlaceCounts, cachedPlaceIntroduced, refreshPlaceIntroduced } from "./inatChecklist.js";

const ESTABLISHED_RECORDS = 20;
const ESTABLISHED_YEARS = 3;
const ESTABLISHED_INAT_PHOTOS = 10;
const RESIDENT_RECORDS = 5;
const RESIDENT_YEARS = 2;
const RESIDENT_INAT_PHOTOS = 3;
// A place's introduced list holds anything introduced anywhere inside it, so a taxon counts as
// introduced there only when most of its observations there are of introduced populations.
const INTRODUCED_MIN_SHARE = 0.5;

interface Region {
  id: string;
  inat_place_id: number | null;
  country_id: string | null;
  iso3: string | null;
}

export async function applyIntroducedFlags(opts: { apply: boolean; log?: (m: string) => void }) {
  const log = opts.log ?? ((m) => console.log(`[introduced] ${m}`));
  // Countries (World > continent > country) and everything under them, each with its country.
  const regions = (
    await pool.query<Region>(
      `WITH RECURSIVE countries AS (
         SELECT c.id FROM regions c JOIN regions cont ON cont.id = c.parent_id JOIN regions w ON w.id = cont.parent_id AND w.parent_id IS NULL
       ), tree AS (
         SELECT id, id AS country_id FROM countries
         UNION ALL SELECT r.id, t.country_id FROM regions r JOIN tree t ON r.parent_id = t.id
       )
       SELECT r.id, r.inat_place_id, t.country_id,
              (SELECT code FROM unnest(c.external_codes) code WHERE code ~ '^[A-Z]{3}$' LIMIT 1) AS iso3
       FROM tree t JOIN regions r ON r.id = t.id JOIN regions c ON c.id = t.country_id
       WHERE EXISTS (SELECT 1 FROM region_species rs WHERE rs.region_id = r.id)`,
    )
  ).rows;

  const places = [...new Set(regions.map((r) => r.inat_place_id).filter((p): p is number => p != null))];
  let failed = 0;
  for (const [i, place] of places.entries()) {
    if (!(await refreshPlaceIntroduced(place))) {
      // Almost always iNaturalist throttling: carrying on straight away only keeps it throttled.
      failed++;
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
    if ((i + 1) % 250 === 0) log(`${i + 1}/${places.length} places (${failed} failed)`);
  }
  if (failed > 0) log(`${failed} place(s) couldn't be fetched; their regions use their country's list`);

  const species = (await pool.query<{ id: string; inat_taxon_id: number | null; scientific_name: string }>(
    `SELECT id, inat_taxon_id, scientific_name FROM species WHERE NOT is_other_taxa`,
  )).rows;
  const byInatId = new Map(species.filter((s) => s.inat_taxon_id != null).map((s) => [s.inat_taxon_id!, s.id]));
  const byName = new Map(species.map((s) => [s.scientific_name, s.id]));
  const introducedIds = (place: number | null): string[] | null => {
    const taxa = place == null ? null : cachedPlaceIntroduced(place);
    if (!taxa) return null;
    const totals = cachedPlaceCounts(place!);
    const ids = new Set<string>();
    for (const [id, { name, count }] of taxa) {
      const total = totals?.get(id)?.count ?? 0;
      if (total > 0 && count / total < INTRODUCED_MIN_SHARE) continue;
      const sid = byInatId.get(id) ?? byName.get(name);
      if (sid) ids.add(sid);
    }
    return [...ids];
  };

  const placeOf = new Map(regions.map((r) => [r.id, r.inat_place_id]));
  const pairs: Array<[string, string]> = [];
  const countryPairs: Array<[string, string]> = [];
  let noList = 0;
  for (const r of regions) {
    const ids = introducedIds(r.inat_place_id) ?? (r.country_id ? introducedIds(placeOf.get(r.country_id) ?? null) : null);
    if (!ids) {
      noList++;
      continue;
    }
    for (const sid of ids) pairs.push([r.id, sid]);
    if (r.id === r.country_id && r.iso3) for (const sid of ids) countryPairs.push([sid, r.iso3]);
  }
  log(`${pairs.length} introduced listings across ${regions.length - noList} regions (${noList} with no list)`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE intro (region_id uuid, species_id uuid, PRIMARY KEY (region_id, species_id)) ON COMMIT DROP`);
    await client.query(
      `INSERT INTO intro SELECT DISTINCT * FROM unnest($1::uuid[], $2::uuid[]) ON CONFLICT DO NOTHING`,
      [pairs.map((p) => p[0]), pairs.map((p) => p[1])],
    );
    // The old list's pairs, per region, before it's replaced.
    await client.query(
      `CREATE TEMP TABLE old_nonnative ON COMMIT DROP AS
       SELECT t.region_id, snc.species_id FROM unnest($1::uuid[], $2::text[]) AS t(region_id, iso3)
       JOIN species_nonnative_countries snc ON snc.country_iso3 = t.iso3`,
      [regions.map((r) => r.id), regions.map((r) => r.iso3)],
    );
    const established = `((COALESCE(rs.live_recent_records, 0) >= ${ESTABLISHED_RECORDS} AND COALESCE(rs.recent_distinct_years, 0) >= ${ESTABLISHED_YEARS})
                          OR COALESCE(rs.inat_rg_count, 0) >= ${ESTABLISHED_INAT_PHOTOS})`;
    const resident = `((COALESCE(rs.live_recent_records, 0) >= ${RESIDENT_RECORDS} AND COALESCE(rs.recent_distinct_years, 0) >= ${RESIDENT_YEARS})
                       OR COALESCE(rs.inat_rg_count, 0) >= ${RESIDENT_INAT_PHOTOS})`;
    const introducedEstablished = await client.query(
      `UPDATE region_species rs SET is_invasive = true, is_vagrant = false
       FROM intro i WHERE i.region_id = rs.region_id AND i.species_id = rs.species_id AND ${established}
         AND (rs.is_vagrant OR NOT COALESCE(rs.is_invasive, false))`,
    );
    // Few records don't make an introduced species a stray: it's marked introduced, and the
    // vagrant flag stays whatever the province build's recurrence check made it.
    const introducedThin = await client.query(
      `UPDATE region_species rs SET is_invasive = true
       FROM intro i WHERE i.region_id = rs.region_id AND i.species_id = rs.species_id AND NOT ${established} AND NOT COALESCE(rs.is_invasive, false)`,
    );
    const nativeCleared = await client.query(
      `UPDATE region_species rs SET is_vagrant = false
       FROM old_nonnative o WHERE o.region_id = rs.region_id AND o.species_id = rs.species_id AND rs.is_vagrant AND ${resident}
         AND NOT EXISTS (SELECT 1 FROM intro i WHERE i.region_id = rs.region_id AND i.species_id = rs.species_id)
         AND NOT EXISTS (SELECT 1 FROM region_species_manual_overrides m WHERE m.region_id = rs.region_id AND m.species_id = rs.species_id)`,
    );
    const sample = async (where: string, from: string) =>
      (
        await client.query<{ s: string }>(
          `SELECT s.common_name || ' in ' || r.name AS s FROM ${from} JOIN region_species rs ON rs.region_id = x.region_id AND rs.species_id = x.species_id
           JOIN species s ON s.id = rs.species_id JOIN regions r ON r.id = rs.region_id WHERE ${where} ORDER BY md5(s.id::text || r.id::text) LIMIT 12`,
        )
      ).rows.map((r) => r.s).join("; ");
    if (!opts.apply) {
      log(`e.g. introduced, established: ${await sample(`rs.is_invasive AND NOT rs.is_vagrant`, "intro x")}`);
      log(`e.g. introduced, few records: ${await sample(`NOT ${established}`, "intro x")}`);
      log(`e.g. natives cleared: ${await sample(`NOT rs.is_vagrant AND NOT EXISTS (SELECT 1 FROM intro i WHERE i.region_id = x.region_id AND i.species_id = x.species_id)`, "old_nonnative x")}`);
    }
    log(
      `introduced and established: ${introducedEstablished.rowCount}; introduced with few records: ${introducedThin.rowCount}; ` +
        `natives no longer flagged vagrant: ${nativeCleared.rowCount}`,
    );
    const countriesWithList = [...new Set(countryPairs.map((p) => p[1]))];
    await client.query(`DELETE FROM species_nonnative_countries WHERE country_iso3 = ANY($1)`, [countriesWithList]);
    await client.query(
      `INSERT INTO species_nonnative_countries (species_id, country_iso3) SELECT DISTINCT * FROM unnest($1::uuid[], $2::text[]) ON CONFLICT DO NOTHING`,
      [countryPairs.map((p) => p[0]), countryPairs.map((p) => p[1])],
    );
    log(`species_nonnative_countries: ${countryPairs.length} pairs for ${countriesWithList.length} countries`);
    await client.query(opts.apply ? "COMMIT" : "ROLLBACK");
    log(opts.apply ? "applied" : "preview only (pass --apply)");
    return { introducedEstablished: introducedEstablished.rowCount, introducedThin: introducedThin.rowCount, nativeCleared: nativeCleared.rowCount };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  applyIntroducedFlags({ apply: process.argv.includes("--apply") })
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
