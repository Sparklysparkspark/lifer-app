// Takes escaped pets and one-off releases off checklists. One research-grade photo is enough to
// put a species on a province list, so a single escapee would otherwise be listed (and tiered
// Legendary) as if it lived wild. Birds that fly, bats and sea life are left alone: they really do
// turn up far from home, and the vagrant rule covers them. Flightless birds (an emu on a farm)
// can't, so they're judged like mammals. For the rest, a province listing is an escape
// when all of these hold:
//   - only a handful of records there (under ESCAPE_MAX_RECORDS), counting GBIF records or
//     iNaturalist photos, whichever is more (GBIF hides sensitive species' locations);
//   - the province is well surveyed for the group (ESCAPE_MIN_GROUP_RECORDS records or photos of
//     it), so a real population would show, and its iNaturalist photo counts are downloaded;
//   - the species is established somewhere (ESTABLISHED_MIN_RECORDS in a province), but nowhere
//     within ESCAPE_MIN_DISTANCE_KM. Where it's introduced (species_nonnative_countries) it also
//     needs ESTABLISHED_MIN_SHARE of the group's records there, or ESTABLISHED_SURE_RECORDS: pets
//     and plant-shipment stowaways get photographed in every big city without living there;
//   - no chain of listings, each within NEIGHBOUR_KM of the next, links it to a listing that isn't
//     itself in doubt. A rare native or a range edge has neighbours that list it too; scattered
//     escapes are islands, or only have each other. An introduced listing with more records than
//     an escape's that still isn't established isn't a link.
// Where the group is too little recorded to judge, an introduced species with SPARSE_MAX_RECORDS
// or fewer still goes by the same distance and chain rules: a lone pet record doesn't need a
// well-surveyed province to stand out. Not one established as an introduction in
// INVADER_MIN_PROVINCES or more (rats, house geckos, feral pigs): a proven coloniser turning up
// in a little-recorded place has most likely settled there.
// Farm and pet animals (DOMESTIC_SPECIES) stay only where ESTABLISHED_MIN_RECORDS show a feral
// population: a handful of records is a farm or a pet.
// Listings in data/reference/known-feral-populations.json always stay.
// A country row goes by the same rules once none of its provinces keeps the species, measured
// from its provinces, since the country's own iNaturalist list would otherwise re-add it. Run
// after the province build and again after the country build.
//
// Usage (from packages/data-pipeline): npx tsx src/scripts/remove-escapes.ts [--apply]
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  COUNTRIES_SQL,
  PROVINCES_WITH_COUNTRY_SQL,
  descendantIdsSql,
  provinceIdsSql,
} from "@lifer/core/regions/regionTree.js";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { pool } from "@lifer/core/db.js";
import { refreshInatInputs } from "./compute-local-tiers.js";
import { requirePostgis } from "../pipeline/requirePostgis.js";

export const ESCAPE_MAX_RECORDS = 5;
export const ESCAPE_MIN_GROUP_RECORDS = 5000;
export const ESTABLISHED_MIN_RECORDS = 20;
// Edge to edge: neighbouring provinces are 0 km apart, however big they are.
export const ESCAPE_MIN_DISTANCE_KM = 400;
export const NEIGHBOUR_KM = 300;
// A country row has no location finer than the country, so it needs a wider margin.
export const COUNTRY_ESCAPE_MIN_DISTANCE_KM = 1000;
export const ESTABLISHED_MIN_SHARE = 0.001;
export const ESTABLISHED_SURE_RECORDS = 100;
export const SPARSE_MAX_RECORDS = 2;
export const INVADER_MIN_PROVINCES = 10;
export const DOMESTIC_SPECIES = [
  "Felis catus",
  "Bos taurus",
  "Bos indicus",
  "Bos frontalis",
  "Bos grunniens",
  "Bubalus bubalis",
  "Capra hircus",
  "Ovis aries",
  "Equus caballus",
  "Equus asinus",
  "Camelus dromedarius",
  "Camelus bactrianus",
  "Lama glama",
  "Vicugna pacos",
  "Cavia porcellus",
  "Mustela furo",
];

const LAND_CLASSES = ["mammalia", "amphibia", "squamata", "testudines", "aves"];
// The birds judged here besides the captive-origin list: ostriches, rheas, emus and cassowaries, kiwis.
const FLIGHTLESS_BIRD_ORDERS = ["Struthioniformes", "Rheiformes", "Casuariiformes", "Apterygiformes"];
const EFFORT_GROUP_SQL = `CASE s.taxon_class WHEN 'mammalia' THEN 'mammals' WHEN 'aves' THEN 'birds' ELSE 'herps' END`;
// Bats fly; whales, seals, sea cows, sea turtles and sea snakes swim. None of them are escapes.
const EXCLUDED_ORDERS = ["Chiroptera", "Cetacea", "Sirenia"];
// Sea snakes are elapids, so they're named by genus.
const SEA_SNAKE_GENERA = [
  "Hydrophis",
  "Aipysurus",
  "Emydocephalus",
  "Laticauda",
  "Microcephalophis",
  "Ephalophis",
  "Hydrelaps",
  "Parahydrophis",
];
const EXCLUDED_FAMILIES = [
  "Balaenidae",
  "Balaenopteridae",
  "Cetotheriidae",
  "Delphinidae",
  "Eschrichtiidae",
  "Kogiidae",
  "Monodontidae",
  "Neobalaenidae",
  "Phocoenidae",
  "Physeteridae",
  "Platanistidae",
  "Iniidae",
  "Pontoporiidae",
  "Lipotidae",
  "Ziphiidae",
  "Phocidae",
  "Otariidae",
  "Odobenidae",
  "Trichechidae",
  "Dugongidae",
  "Cheloniidae",
  "Dermochelyidae",
];

const REFERENCE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "reference");

/** Flying birds kept as pets or in collections (captive-origin-species.json). They are judged by
 *  the same rules as flightless birds and mammals, since a few records of one far from its
 *  range are far more likely an escape than a vagrant. */
export const captiveOriginSpecies = (): string[] =>
  (
    JSON.parse(readFileSync(path.join(REFERENCE_DIR, "captive-origin-species.json"), "utf8")) as Array<{
      species: string;
    }>
  ).map((e) => e.species);

/** Listings known-feral-populations.json keeps, as "region_id|species_id". An entry for a whole
 *  country keeps its provinces too. */
export const knownFeral = (client: PoolClient) => referenceListings(client, "known-feral-populations.json");

/** The listings a data/reference file of {species, region, country, reason} entries names, as
 *  "region_id|species_id". An entry for a whole country names its provinces too. */
export async function referenceListings(client: Pool | PoolClient, file: string): Promise<Set<string>> {
  const entries = JSON.parse(readFileSync(path.join(REFERENCE_DIR, file), "utf8")) as Array<{
    species: string;
    region: string;
    country: string;
  }>;
  const res = await client.query<{ i: string; region_id: string; species_id: string }>(
    `SELECT v.i, r.id AS region_id, s.id AS species_id
     FROM unnest($1::text[], $2::text[], $3::text[]) WITH ORDINALITY AS v(sci, region, country, i)
     JOIN species s ON s.scientific_name = v.sci
     JOIN (${COUNTRIES_SQL}) c ON c.name = v.country
     JOIN regions r ON r.id = c.id AND v.region = v.country
       OR r.id IN (${descendantIdsSql("c.id")}) AND (r.name = v.region OR v.region = v.country)`,
    [entries.map((e) => e.species), entries.map((e) => e.region), entries.map((e) => e.country)],
  );
  const matched = new Set(res.rows.map((r) => Number(r.i)));
  entries.forEach((e, i) => {
    if (!matched.has(i + 1))
      console.warn(`[${file}] matches no region or species: ${e.species} in ${e.region}, ${e.country}`);
  });
  return new Set(res.rows.map((r) => `${r.region_id}|${r.species_id}`));
}

export async function deleteListings(
  client: PoolClient,
  rows: Array<{ region_id: string; species_id: string }>,
): Promise<void> {
  if (rows.length === 0) return;
  const args = [rows.map((r) => r.region_id), rows.map((r) => r.species_id)];
  await client.query(
    `DELETE FROM region_species rs USING unnest($1::uuid[], $2::uuid[]) AS v(region_id, species_id)
     WHERE rs.region_id = v.region_id AND rs.species_id = v.species_id`,
    args,
  );
  await client.query(
    `DELETE FROM region_species_hotspots h USING unnest($1::uuid[], $2::uuid[]) AS v(region_id, species_id)
     WHERE h.region_id = v.region_id AND h.species_id = v.species_id`,
    args,
  );
}

/** Candidates not linked, by a chain of listings each within NEIGHBOUR_KM of the next, to any
 *  listing of the species that isn't a candidate. A flood fill per species, from the listings not
 *  in doubt outwards. */
async function unconnectedCandidates(client: PoolClient): Promise<Listing[]> {
  const rows = await client.query<{ species_id: string; region_id: string; candidate: boolean; link: boolean }>(
    `SELECT r.species_id, r.region_id,
            EXISTS (SELECT 1 FROM esc_candidates c WHERE c.region_id = r.region_id AND c.species_id = r.species_id) AS candidate,
            NOT r.intro OR r.n < $2
            OR EXISTS (SELECT 1 FROM esc_near nr JOIN esc_established s ON s.region_id = nr.b AND s.species_id = r.species_id
                       WHERE nr.a = r.region_id AND nr.km <= $1) AS link
     FROM esc_rows r WHERE r.species_id IN (SELECT species_id FROM esc_candidates)`,
    [ESCAPE_MIN_DISTANCE_KM, ESCAPE_MAX_RECORDS],
  );
  const edges = await client.query<{ species_id: string; a: string; b: string }>(
    `SELECT x.species_id, x.region_id AS a, y.region_id AS b
     FROM esc_rows x
     JOIN esc_near n ON n.a = x.region_id AND n.b <> x.region_id AND n.km <= $1
     JOIN esc_rows y ON y.region_id = n.b AND y.species_id = x.species_id
     WHERE x.species_id IN (SELECT species_id FROM esc_candidates)`,
    [NEIGHBOUR_KM],
  );
  const near = new Map<string, string[]>();
  for (const e of edges.rows) {
    const k = `${e.species_id}|${e.a}`;
    const list = near.get(k) ?? [];
    list.push(e.b);
    near.set(k, list);
  }
  const bySpecies = new Map<string, typeof rows.rows>();
  for (const r of rows.rows) {
    const list = bySpecies.get(r.species_id) ?? [];
    list.push(r);
    bySpecies.set(r.species_id, list);
  }
  const lost: Array<{ species_id: string; region_id: string }> = [];
  for (const [speciesId, list] of bySpecies) {
    const reached = new Set(list.filter((r) => !r.candidate && r.link).map((r) => r.region_id));
    const queue = [...reached];
    while (queue.length > 0) {
      for (const next of near.get(`${speciesId}|${queue.pop()!}`) ?? []) {
        if (!reached.has(next)) {
          reached.add(next);
          queue.push(next);
        }
      }
    }
    for (const r of list)
      if (r.candidate && !reached.has(r.region_id)) lost.push({ species_id: r.species_id, region_id: r.region_id });
  }
  if (lost.length === 0) return [];
  return describe(client, lost);
}

/** Names and the distance to the nearest established population, for the report. Only the few
 *  rows being removed get a real distance computed. */
async function describe(
  client: PoolClient,
  rows: Array<{ species_id: string; region_id: string }>,
  countryLevel = false,
): Promise<Listing[]> {
  const out = await client.query<Listing>(
    `SELECT v.species_id, v.region_id, s.common_name AS species, r.name AS region,
            ${countryLevel ? "r.name" : "p.country"} AS country,
            (SELECT round(min(ST_Distance(ep.pt, pp.pt)) / 1000)::int
               FROM esc_established e JOIN esc_province ep ON ep.id = e.region_id
               JOIN esc_province pp ON ${countryLevel ? "pp.country_id = v.region_id" : "pp.id = v.region_id"}
              WHERE e.species_id = v.species_id) AS km
     FROM unnest($1::uuid[], $2::uuid[]) AS v(species_id, region_id)
     JOIN species s ON s.id = v.species_id JOIN regions r ON r.id = v.region_id
     ${countryLevel ? "" : "JOIN esc_province p ON p.id = v.region_id"}
     ORDER BY 5, 4, 3`,
    [rows.map((l) => l.species_id), rows.map((l) => l.region_id)],
  );
  return out.rows;
}

type Listing = { species_id: string; region_id: string; species: string; region: string; country: string; km: number };

// Province pairs this close are all any check here looks at; the widest distance used.
const NEAR_KM = Math.max(ESCAPE_MIN_DISTANCE_KM, NEIGHBOUR_KM, COUNTRY_ESCAPE_MIN_DISTANCE_KM);

export async function removeEscapes(
  apply: boolean,
): Promise<Array<{ species: string; region: string; country: string; km: number }>> {
  const client = await pool.connect();
  await requirePostgis(client, "remove-escapes.ts");
  try {
    await client.query("BEGIN");
    // One outline per province, referenced by id: copying outlines into every listing row makes
    // the temp tables huge.
    await client.query(
      `CREATE TEMP TABLE esc_province ON COMMIT DROP AS
       SELECT r.id, r.name, c.id AS country_id, c.name AS country,
              ST_Simplify(ST_Force2D(ST_GeomFromGeoJSON((r.boundary_geojson->'geometry')::text)), 0.05, true)::geography AS pt
       FROM (${PROVINCES_WITH_COUNTRY_SQL}) p JOIN regions r ON r.id = p.id JOIN regions c ON c.id = p.country_id
       WHERE r.boundary_geojson ? 'geometry'`,
    );
    await client.query(`CREATE INDEX ON esc_province USING gist (pt)`);
    await client.query(`ANALYZE esc_province`);
    // Every pair of provinces within NEAR_KM, edge to edge, worked out once: each check below is
    // then a lookup instead of an outline-to-outline distance.
    await client.query(
      `CREATE TEMP TABLE esc_near ON COMMIT DROP AS
       SELECT x.id AS a, y.id AS b, ST_Distance(x.pt, y.pt) / 1000 AS km
       FROM esc_province x JOIN esc_province y ON ST_DWithin(x.pt, y.pt, $1 * 1000)`,
      [NEAR_KM],
    );
    await client.query(`CREATE INDEX ON esc_near (a, km)`);
    await client.query(
      `CREATE TEMP TABLE esc_rows ON COMMIT DROP AS
       SELECT rs.region_id, rs.species_id,
              greatest(COALESCE(rs.local_frequency, 0), COALESCE(rs.inat_rg_count, 0)) AS n,
              ${EFFORT_GROUP_SQL} AS grp,
              EXISTS (SELECT 1 FROM regions c JOIN species_nonnative_countries snc ON snc.country_iso3 = ANY(c.external_codes)
                      WHERE c.id = p.country_id AND snc.species_id = rs.species_id) AS intro
       FROM region_species rs JOIN species s ON s.id = rs.species_id JOIN esc_province p ON p.id = rs.region_id
       WHERE s.taxon_class = ANY($1) AND NOT s.is_other_taxa
         AND COALESCE(s.taxon_order, '') <> ALL($2) AND COALESCE(s.family, '') <> ALL($3)
         AND split_part(s.scientific_name, ' ', 1) <> ALL($4)
         AND (s.taxon_class <> 'aves' OR s.taxon_order = ANY($5) OR s.scientific_name = ANY($6))`,
      [
        LAND_CLASSES,
        EXCLUDED_ORDERS,
        EXCLUDED_FAMILIES,
        SEA_SNAKE_GENERA,
        FLIGHTLESS_BIRD_ORDERS,
        captiveOriginSpecies(),
      ],
    );
    await client.query(`CREATE INDEX ON esc_rows (species_id, region_id)`);
    await client.query(`CREATE INDEX ON esc_rows (region_id)`);
    await client.query(
      `CREATE TEMP TABLE esc_group_total ON COMMIT DROP AS SELECT region_id, grp, sum(n) AS total FROM esc_rows GROUP BY 1, 2`,
    );
    await client.query(
      `CREATE TEMP TABLE esc_established ON COMMIT DROP AS
       SELECT r.species_id, r.region_id FROM esc_rows r JOIN esc_group_total t ON t.region_id = r.region_id AND t.grp = r.grp
       WHERE r.n >= $1 AND (NOT r.intro OR r.n >= $2 * t.total OR r.n >= $3)`,
      [ESTABLISHED_MIN_RECORDS, ESTABLISHED_MIN_SHARE, ESTABLISHED_SURE_RECORDS],
    );
    await client.query(`CREATE INDEX ON esc_established (species_id, region_id)`);
    await client.query(
      `CREATE TEMP TABLE esc_invaders ON COMMIT DROP AS
       SELECT s.species_id FROM esc_established s JOIN esc_rows r ON r.region_id = s.region_id AND r.species_id = s.species_id
       WHERE r.intro GROUP BY 1 HAVING count(*) >= $1`,
      [INVADER_MIN_PROVINCES],
    );
    await client.query(
      `ANALYZE esc_near; ANALYZE esc_rows; ANALYZE esc_established; ANALYZE esc_group_total; ANALYZE esc_invaders`,
    );
    // Judged only where iNaturalist's photo counts are in: without them a province can't tell a
    // sensitive species with hidden GBIF records from an escape.
    await client.query(
      `CREATE TEMP TABLE esc_candidates ON COMMIT DROP AS
       SELECT r.region_id, r.species_id
       FROM esc_rows r
       JOIN region_group_effort e ON e.region_id = r.region_id AND e.species_group = r.grp AND e.inat_rg_records IS NOT NULL
       JOIN esc_group_total t ON t.region_id = r.region_id AND t.grp = r.grp
       WHERE r.n < $1 AND (greatest(t.total, e.inat_rg_records) >= $2 OR (r.intro AND r.n <= $4 AND r.species_id NOT IN (SELECT species_id FROM esc_invaders)))
         AND EXISTS (SELECT 1 FROM esc_established s WHERE s.species_id = r.species_id)
         AND NOT EXISTS (SELECT 1 FROM esc_near nr JOIN esc_established s ON s.region_id = nr.b AND s.species_id = r.species_id
                         WHERE nr.a = r.region_id AND nr.km <= $3)`,
      [ESCAPE_MAX_RECORDS, ESCAPE_MIN_GROUP_RECORDS, ESCAPE_MIN_DISTANCE_KM, SPARSE_MAX_RECORDS],
    );
    await client.query(`CREATE INDEX ON esc_candidates (species_id, region_id)`);
    const keep = await knownFeral(client);
    const kept = <T extends { region_id: string; species_id: string }>(rows: T[]) =>
      rows.filter((r) => !keep.has(`${r.region_id}|${r.species_id}`));
    const found = kept(await unconnectedCandidates(client));
    // Deleted inside the transaction either way (a preview rolls back), so the country check
    // below sees the province lists as they'll be.
    await deleteListings(client, found);
    await client.query(
      `DELETE FROM esc_rows r USING unnest($1::uuid[], $2::uuid[]) AS v(region_id, species_id)
       WHERE r.region_id = v.region_id AND r.species_id = v.species_id`,
      [found.map((r) => r.region_id), found.map((r) => r.species_id)],
    );

    const countries = await client.query<{ species_id: string; region_id: string }>(
      `WITH candidates AS MATERIALIZED (
         SELECT rs.species_id, c.id AS country_id
         FROM region_species rs
         JOIN species s ON s.id = rs.species_id
         JOIN regions c ON c.id = rs.region_id
         JOIN regions cont ON cont.id = c.parent_id JOIN regions w ON w.id = cont.parent_id AND w.parent_id IS NULL
           AND c.home_country_id IS NULL
         JOIN region_group_effort g ON g.region_id = c.id AND g.inat_rg_records >= $4
           AND g.species_group = ${EFFORT_GROUP_SQL}
         WHERE s.taxon_class = ANY($1) AND NOT s.is_other_taxa
           AND COALESCE(s.taxon_order, '') <> ALL($2) AND COALESCE(s.family, '') <> ALL($3)
           AND split_part(s.scientific_name, ' ', 1) <> ALL($8)
           AND (s.taxon_class <> 'aves' OR s.taxon_order = ANY($9) OR s.scientific_name = ANY($10))
           AND greatest(COALESCE(rs.local_frequency, 0), COALESCE(rs.inat_rg_count, 0)) < $5
           AND EXISTS (SELECT 1 FROM esc_established e WHERE e.species_id = rs.species_id)
           AND NOT EXISTS (SELECT 1 FROM region_species ps JOIN regions pr ON pr.id = ps.region_id
                           WHERE pr.id IN (${provinceIdsSql("c.id")}) AND ps.species_id = rs.species_id)
       )
       SELECT k.species_id, k.country_id AS region_id
       FROM candidates k
       WHERE NOT EXISTS (SELECT 1 FROM esc_province p JOIN esc_near nr ON nr.a = p.id AND nr.km <= $6
                         JOIN esc_established e ON e.region_id = nr.b AND e.species_id = k.species_id
                         WHERE p.country_id = k.country_id)
         AND NOT EXISTS (SELECT 1 FROM esc_province p JOIN esc_near nr ON nr.a = p.id AND nr.km <= $7
                         JOIN esc_rows o ON o.region_id = nr.b AND o.species_id = k.species_id
                         WHERE p.country_id = k.country_id)`,
      [
        LAND_CLASSES,
        EXCLUDED_ORDERS,
        EXCLUDED_FAMILIES,
        ESCAPE_MIN_GROUP_RECORDS,
        ESCAPE_MAX_RECORDS,
        COUNTRY_ESCAPE_MIN_DISTANCE_KM,
        NEIGHBOUR_KM,
        SEA_SNAKE_GENERA,
        FLIGHTLESS_BIRD_ORDERS,
        captiveOriginSpecies(),
      ],
    );
    const countryListings = kept(countries.rows.length > 0 ? await describe(client, countries.rows, true) : []);
    await deleteListings(client, countryListings);
    // Farm and pet animals: provinces, then groups and countries none of whose provinces keep them.
    const thinDomestic = (where: string) =>
      client.query<{ species_id: string; region_id: string }>(
        `SELECT rs.species_id, rs.region_id FROM region_species rs JOIN species s ON s.id = rs.species_id
         WHERE s.scientific_name = ANY($1) AND greatest(COALESCE(rs.local_frequency, 0), COALESCE(rs.inat_rg_count, 0)) < $2 AND ${where}`,
        [DOMESTIC_SPECIES, ESTABLISHED_MIN_RECORDS],
      );
    const domestic = kept(
      await describe(client, (await thinDomestic(`rs.region_id IN (SELECT id FROM esc_province)`)).rows),
    );
    await deleteListings(client, domestic);
    const domesticAbove = (
      await thinDomestic(
        `rs.region_id NOT IN (SELECT id FROM esc_province)
         AND EXISTS (SELECT 1 FROM esc_province p JOIN regions pr ON pr.id = p.id WHERE p.country_id = rs.region_id OR pr.parent_id = rs.region_id)
         AND NOT EXISTS (SELECT 1 FROM region_species ps JOIN esc_province p ON p.id = ps.region_id JOIN regions pr ON pr.id = p.id
                         WHERE ps.species_id = rs.species_id AND (p.country_id = rs.region_id OR pr.parent_id = rs.region_id))`,
      )
    ).rows;
    const domesticAboveListed = kept(domesticAbove.length > 0 ? await describe(client, domesticAbove, true) : []);
    await deleteListings(client, domesticAboveListed);
    await client.query(apply ? "COMMIT" : "ROLLBACK");
    return [...found, ...countryListings, ...domestic, ...domesticAboveListed].map(
      ({ species, region, country, km }) => ({ species, region, country, km }),
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const apply = process.argv.includes("--apply");
  // Photo counts from the cached iNaturalist lists onto the checklists first (no network). Written
  // outside the transaction, so a preview leaves them out and reads the counts as they are.
  pool
    .query<{ id: string }>(`SELECT id FROM regions WHERE inat_place_id IS NOT NULL`)
    .then((r) => (apply ? refreshInatInputs(r.rows.map((x) => x.id)) : undefined))
    .then(() => removeEscapes(apply))
    .then(async (rows) => {
      for (const r of rows) console.log(`${r.country}\t${r.region}\t${r.species}\t${r.km} km`);
      console.log(`[escapes] ${apply ? "removed" : "would remove"} ${rows.length} province listings`);
      await pool.end();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
