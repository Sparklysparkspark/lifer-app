// A country's checklist, built one way: the union of its provinces' checklists, plus species on
// the country's own iNaturalist research-grade list that no province has, then the country's
// manual overrides. The single place country rows are written.
//
// Also keeps the country's own well-evidenced species that no province has (records outside every
// province boundary). Only adds at country level: each province's list has already been through
// the removal checks, so a species a province keeps belongs to the country too. Overseas
// territories stay out of the union, as the app leaves them out of a country by default. A
// country with no computed provinces keeps its own list untouched.
// Tiers aren't set here: the tiers stage (compute-local-tiers.ts) rates every row afterwards.
//
// Usage (from packages/data-pipeline):
//   npx tsx src/scripts/build-country-checklists.ts --countries="United States of America"   (preview)
//   npx tsx src/scripts/build-country-checklists.ts --apply                                  (every country)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "@lifer/core/db.js";
import { matchedSpeciesIdsForRegion } from "@lifer/core/regions/inatChecklist.js";

export interface CountryChecklistResult {
  country: string;
  provinces: number;
  before: number;
  fromProvinces: number;
  keptOwn: number;
  addedFromInat: number;
  after: number;
}

export async function buildCountryChecklist(country: { id: string; name: string }, apply: boolean): Promise<CountryChecklistResult | null> {
  const provinces = await pool.query<{ id: string }>(
    `SELECT id FROM regions WHERE parent_id = $1 AND NOT is_overseas_territory AND occurrence_computed_at IS NOT NULL`,
    [country.id],
  );
  if (provinces.rows.length === 0) return null;
  const provinceIds = provinces.rows.map((r) => r.id);

  const before = Number((await pool.query<{ n: string }>(`SELECT count(*) AS n FROM region_species WHERE region_id = $1`, [country.id])).rows[0].n);
  const inat = await matchedSpeciesIdsForRegion(country.id, country.name);
  const inatIds = inat ? [...inat.matchedSpeciesIds] : [];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // The union: frequencies and weekly counts add up; a species is a vagrant for the country
    // only if it's a vagrant everywhere it's listed, and invasive if it's invasive anywhere.
    await client.query(
      `CREATE TEMP TABLE country_rows ON COMMIT DROP AS
       SELECT rs.species_id,
              sum(rs.local_frequency) AS local_frequency,
              bool_and(rs.is_vagrant) AS is_vagrant,
              bool_or(rs.is_invasive) AS is_invasive,
              CASE WHEN count(rs.weekly_frequency) = 0 THEN NULL
                   ELSE (SELECT array_agg(w ORDER BY i) FROM (
                          SELECT i, sum(x)::int AS w
                          FROM region_species r2, unnest(r2.weekly_frequency) WITH ORDINALITY AS u(x, i)
                          WHERE r2.species_id = rs.species_id AND r2.region_id = ANY($1)
                          GROUP BY i) weeks) END AS weekly_frequency,
              'provinces'::text AS evidence
       FROM region_species rs JOIN species s ON s.id = rs.species_id
       WHERE rs.region_id = ANY($1) AND NOT s.is_other_taxa
       GROUP BY rs.species_id`,
      [provinceIds],
    );
    const fromProvinces = (await client.query<{ n: string }>(`SELECT count(*) AS n FROM country_rows`)).rows[0].n;
    // The country's own records that fall outside every province boundary (coastal and offshore
    // species, above all): kept from its existing list when well evidenced, 10+ records or on its
    // iNaturalist list, until the province scan keeps those records itself.
    const keptOwn = await client.query(
      `INSERT INTO country_rows (species_id, local_frequency, is_vagrant, is_invasive, weekly_frequency, evidence)
       SELECT rs.species_id, rs.local_frequency, rs.is_vagrant, rs.is_invasive, rs.weekly_frequency, 'country'
       FROM region_species rs JOIN species s ON s.id = rs.species_id
       WHERE rs.region_id = $1 AND NOT s.is_other_taxa
         AND rs.species_id NOT IN (SELECT species_id FROM country_rows)
         AND (COALESCE(rs.local_frequency, 0) >= 10 OR rs.species_id = ANY($2))`,
      [country.id, inatIds],
    );
    // Species on the country's own iNaturalist list that no province has (a coastal or offshore
    // species whose records fall outside every province boundary, most often).
    const added = await client.query(
      `INSERT INTO country_rows (species_id, is_vagrant, is_invasive, evidence)
       SELECT id, false, false, 'inat' FROM unnest($1::uuid[]) AS id
       WHERE id NOT IN (SELECT species_id FROM country_rows)`,
      [inatIds],
    );
    // Rows from provinces keep their flags; ones added from the country's iNaturalist list have none,
    // so an introduced species among them is flagged here (apply-introduced-flags.ts refines it).
    await client.query(
      `UPDATE country_rows cr SET is_vagrant = true
       FROM species_nonnative_countries snc, regions r
       WHERE r.id = $1 AND cr.species_id = snc.species_id AND snc.country_iso3 = ANY(r.external_codes) AND cr.evidence = 'inat'`,
      [country.id],
    );
    await client.query(
      `UPDATE country_rows cr SET is_vagrant = COALESCE(o.is_vagrant, cr.is_vagrant), is_invasive = COALESCE(o.is_invasive, cr.is_invasive)
       FROM region_species_manual_overrides o WHERE o.region_id = $1 AND o.species_id = cr.species_id`,
      [country.id],
    );
    const after = Number((await client.query<{ n: string }>(`SELECT count(*) AS n FROM country_rows`)).rows[0].n);

    if (apply) {
      // Other Taxa rows are the user's own additions and never part of a computed list.
      await client.query(
        `DELETE FROM region_species rs USING species s WHERE rs.region_id = $1 AND s.id = rs.species_id AND NOT s.is_other_taxa`,
        [country.id],
      );
      await client.query(
        `INSERT INTO region_species (region_id, species_id, local_frequency, is_vagrant, is_invasive, weekly_frequency, evidence_source)
         SELECT $1, species_id, local_frequency, is_vagrant, is_invasive, weekly_frequency, evidence FROM country_rows`,
        [country.id],
      );
      await client.query(`UPDATE regions SET occurrence_computed_at = now(), has_children = true WHERE id = $1`, [country.id]);
      await client.query("COMMIT");
    } else {
      await client.query("ROLLBACK");
    }
    return { country: country.name, provinces: provinceIds.length, before, fromProvinces: Number(fromProvinces), keptOwn: keptOwn.rowCount ?? 0, addedFromInat: added.rowCount ?? 0, after };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const names = args.find((a) => a.startsWith("--countries="))?.slice("--countries=".length).split(",").map((s) => s.trim()).filter(Boolean) ?? null;
  const countries = await pool.query<{ id: string; name: string }>(
    `SELECT c.id, c.name FROM regions c JOIN regions cont ON cont.id = c.parent_id JOIN regions w ON w.id = cont.parent_id AND w.parent_id IS NULL
     WHERE ($1::text[] IS NULL OR c.name = ANY($1)) ORDER BY c.name`,
    [names],
  );
  for (const c of countries.rows) {
    const r = await buildCountryChecklist(c, apply);
    if (!r) continue;
    console.log(
      `[country-checklists] ${r.country}: ${r.before} -> ${r.after} (${r.fromProvinces} from ${r.provinces} provinces, ${r.keptOwn} of its own outside them, ${r.addedFromInat} more from its iNaturalist list)`,
    );
  }
  console.log(apply ? "[country-checklists] applied" : "[country-checklists] preview only (pass --apply)");
  await pool.end();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
