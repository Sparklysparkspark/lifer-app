// Puts back checklist rows the 2026-10-10 province rebuild deleted only because iNaturalist had
// no photo of the species there (mostly freshwater fish, which iNaturalist barely covers). The
// GBIF downloads those lists came from are gone, so the published packs are the one copy left.
// A row comes back flagged vagrant (kept, hidden by default), like any species iNaturalist lacks.
//
// Reads every published region pack that lists a species the catalog's region no longer has
// (cached in data/published-packs-cache, so a rerun reads nothing twice), and skips a row when:
//   - its species is gone from the catalog, hidden as extinct, never listed (NEVER_LISTED_SPECIES),
//     a farm animal or an escape-prone pet (captive-origin-species.json);
//   - a logged clean-up took it off on purpose (escapes-removed-*.tsv and the applied 6b TSVs);
//   - it's a bird the region's cached eBird list lacks (eBird lists every stray).
// The tiers stage afterwards still applies its own removal rules to what comes back.
// Every row is checked against sources independent of the pack: the country's or a neighbouring
// country's cached iNaturalist list, the species' endemic country, or a current listing elsewhere
// in the country or next door (--require-support restores only rows with at least one). A row
// they contradict is skipped: endemic to another country, or listed now only on other continents.
// Every decision goes to data/review/restore-published-rows.tsv.
//
// Usage (from packages/data-pipeline):
//   npx tsx src/scripts/restore-published-rows.ts                    (read packs, preview)
//   npx tsx src/scripts/restore-published-rows.ts --taxa=actinopterygii --countries=Colombia
//   npx tsx src/scripts/restore-published-rows.ts --require-support --apply
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { pool } from "@lifer/core/db.js";
import { httpFetch } from "@lifer/core/lib/http.js";
import { COUNTRIES_SQL, groupIdsSql, provinceIdsSql } from "@lifer/core/regions/regionTree.js";
import { fetchPublishedIndex } from "../pipeline/packIndex.js";
import { cachedPlaceCounts } from "../regions/inatChecklist.js";
import { cachedEbirdCodes } from "./add-new-species-to-checklists.js";
import { NEVER_LISTED_SPECIES } from "./compute-local-tiers.js";

const PIPELINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DATA_DIR = path.join(PIPELINE_DIR, "data");
const CACHE_DIR = path.join(DATA_DIR, "published-packs-cache");
const REVIEW_TSV = path.join(DATA_DIR, "review", "restore-published-rows.tsv");
export const EVIDENCE = "published-2026-10-08";
const NEIGHBOUR_KM = 300;

interface PackRow {
  name: string;
  frequency: number | null;
  weekly: number[] | null;
}
/** The parts of a published pack this needs: the country's list and each province's. */
export interface PackLists {
  region: string;
  country: PackRow[];
  provinces: Array<{ name: string; species: PackRow[] }>;
}

function trim(species: Array<Record<string, unknown>>): PackRow[] {
  return species.map((s) => ({
    name: String(s.scientificName),
    frequency: s.localFrequency == null ? null : Number(s.localFrequency),
    weekly: Array.isArray(s.weeklyFrequency) ? (s.weeklyFrequency as number[]) : null,
  }));
}

async function readPack(pack: { id: string; url: string; range?: [number, number] }): Promise<PackLists> {
  const file = path.join(CACHE_DIR, `${pack.id}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as PackLists;
  const [start, length] = pack.range ?? [0, 0];
  const res = await httpFetch(pack.url, {
    init: pack.range ? { headers: { Range: `bytes=${start}-${start + length - 1}` } } : undefined,
    timeoutMs: 300_000,
    maxRetries: 4,
    retryServerErrors: true,
    backoffBaseMs: 5000,
  });
  if (!res.ok) throw new Error(`${pack.id}: HTTP ${res.status}`);
  const { gunzipSync } = await import("node:zlib");
  const tar = gunzipSync(Buffer.from(await res.arrayBuffer()));
  const manifest = JSON.parse(untarFile(tar, "manifest.json")) as {
    region: string;
    species: Array<Record<string, unknown>>;
    children?: Array<{ name: string; species: Array<Record<string, unknown>> }>;
  };
  const lists: PackLists = {
    region: manifest.region,
    country: trim(manifest.species),
    provinces: (manifest.children ?? []).map((c) => ({ name: c.name, species: trim(c.species) })),
  };
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(lists));
  return lists;
}

/** One file out of a ustar archive. */
export function untarFile(tar: Buffer, wanted: string): string {
  for (let at = 0; at + 512 <= tar.length;) {
    const name = tar.toString("utf8", at, at + 100).replace(/\0.*$/s, "");
    if (!name) break;
    const size = parseInt(
      tar
        .toString("utf8", at + 124, at + 136)
        .replace(/\0.*$/s, "")
        .trim() || "0",
      8,
    );
    if (name.replace(/^\.\//, "") === wanted) return tar.toString("utf8", at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${wanted} not in the pack`);
}

/** "region name|scientific name" of every listing a logged clean-up removed on purpose. */
function loggedRemovals(): Set<string> {
  const out = new Set<string>();
  const dir = path.join(DATA_DIR, "review");
  for (const f of readdirSync(dir)) {
    const lines = readFileSync(path.join(dir, f), "utf8").split("\n");
    if (f.startsWith("escapes-removed-"))
      for (const l of lines) {
        const [, region, species] = l.split("\t");
        if (region && species) out.add(`${region}|${species}`);
      }
    if (f.startsWith("catalog-audit-fixes-applied-"))
      for (const l of lines) {
        const [, action, , name, where] = l.split("\t");
        if (action === "remove" && where) out.add(`${where.replace(/ \([A-Z0-9-]+\)$/, "")}|${name}`);
      }
  }
  return out;
}

async function main() {
  const { values } = parseArgs({
    options: {
      apply: { type: "boolean", default: false },
      taxa: { type: "string" },
      countries: { type: "string" },
      "require-support": { type: "boolean", default: false },
    },
  });
  const taxa = values.taxa?.split(",").map((s) => s.trim());
  const only = values.countries?.split(",").map((s) => s.trim());

  // The catalog's names: current ones, then merged-away and synonym names pointing at them.
  const species = await pool.query<{
    id: string;
    name: string;
    common: string | null;
    taxon_class: string | null;
    ebird_code: string | null;
    inat_taxon_id: number | null;
    gone: boolean;
    domestic: boolean;
    endemic: string | null;
  }>(
    `SELECT s.id, s.scientific_name AS name, s.common_name AS common, s.taxon_class, s.ebird_code, s.inat_taxon_id,
            s.is_other_taxa OR COALESCE(t.fully_extinct, false) AS gone, COALESCE(t.domestic, false) AS domestic,
            t.endemic_country_iso3 AS endemic
     FROM species s LEFT JOIN species_traits t ON t.species_id = s.id`,
  );
  const byId = new Map(species.rows.map((s) => [s.id, s]));
  const idByName = new Map(species.rows.map((s) => [s.name, s.id]));
  for (const r of (
    await pool.query<{ name: string; id: string }>(
      `SELECT old_scientific_name AS name, new_species_id AS id FROM species_merges
       UNION ALL SELECT synonym_name, species_id FROM species_synonyms`,
    )
  ).rows)
    if (!idByName.has(r.name)) idByName.set(r.name, r.id);
  const captive = new Set(
    (
      JSON.parse(readFileSync(path.join(DATA_DIR, "reference", "captive-origin-species.json"), "utf8")) as Array<{
        species: string;
      }>
    ).map((c) => c.species),
  );
  const removed = loggedRemovals();

  const published = await fetchPublishedIndex();
  const packs = published.packs.filter(
    (p) => p.type === "region" && (!taxa || taxa.includes(p.taxon ?? "")) && (!only || only.includes(p.region ?? "")),
  ) as Array<{ id: string; url: string; range?: [number, number]; region: string; taxon: string }>;
  const countries = new Map(
    (
      await pool.query<{
        id: string;
        name: string;
        inat_place_id: number | null;
        codes: string[] | null;
        continent: string;
      }>(
        `SELECT c.id, c.name, r.inat_place_id, r.external_codes AS codes, r.parent_id AS continent
         FROM (${COUNTRIES_SQL}) c JOIN regions r ON r.id = c.id`,
      )
    ).rows.map((c) => [c.name, c]),
  );

  // The continents each species is listed in now, by its country rows.
  const continentsOf = new Map(
    (
      await pool.query<{ species_id: string; continents: string[] }>(
        `SELECT rs.species_id, array_agg(DISTINCT r.parent_id) AS continents
         FROM region_species rs JOIN (${COUNTRIES_SQL}) c ON c.id = rs.region_id JOIN regions r ON r.id = c.id
         GROUP BY rs.species_id`,
      )
    ).rows.map((r) => [r.species_id, new Set(r.continents)]),
  );

  const tsv = ["country\tregion\tspecies\tclass\tdecision\tsupport"];
  const totals = new Map<string, number>();
  const count = (k: string) => totals.set(k, (totals.get(k) ?? 0) + 1);
  const inserts: Array<{ regionId: string; speciesId: string; frequency: number | null; weekly: number[] | null }> = [];
  const seen = new Set<string>();
  for (const [i, pack] of packs.entries()) {
    const country = countries.get(pack.region);
    if (!country) continue;
    const lists = await readPack(pack);
    if ((i + 1) % 100 === 0) console.log(`[restore] ${i + 1}/${packs.length} packs read`);
    const regions = await pool.query<{ id: string; name: string; ebird_region_code: string | null }>(
      `SELECT id, name, ebird_region_code FROM regions WHERE id = $1 OR id IN (${provinceIdsSql("$1")}) OR id IN (${groupIdsSql("$1")})`,
      [country.id],
    );
    // Provinces and vernacular groups by name; a name two of them share can't be placed.
    const byName = new Map<string, (typeof regions.rows)[number] | null>();
    for (const r of regions.rows) if (r.id !== country.id) byName.set(r.name, byName.has(r.name) ? null : r);
    const listed = new Set(
      (
        await pool.query<{ k: string }>(
          `SELECT region_id || '|' || species_id AS k FROM region_species WHERE region_id = ANY($1)`,
          [regions.rows.map((r) => r.id)],
        )
      ).rows.map((r) => r.k),
    );
    // Independent support: the country's or a neighbour's iNaturalist list, a current listing in
    // the country or next door, or the species' endemic country.
    const neighbours = await pool.query<{ id: string; inat_place_id: number | null }>(
      `WITH shapes AS (SELECT c.id, r.inat_place_id,
                              ST_Simplify(ST_Force2D(ST_GeomFromGeoJSON((r.boundary_geojson->'geometry')::text)), 0.05, true)::geography AS g
                       FROM (${COUNTRIES_SQL}) c JOIN regions r ON r.id = c.id WHERE r.boundary_geojson ? 'geometry')
       SELECT o.id, o.inat_place_id FROM shapes me JOIN shapes o ON ST_DWithin(me.g, o.g, $2 * 1000) WHERE me.id = $1`,
      [country.id, NEIGHBOUR_KM],
    );
    const inatTaxa = new Set<number>();
    const inatNames = new Set<string>();
    for (const n of neighbours.rows) {
      const counts = n.inat_place_id != null ? cachedPlaceCounts(n.inat_place_id) : null;
      for (const [id, t] of counts ?? []) {
        inatTaxa.add(id);
        inatNames.add(t.name);
      }
    }
    const nearbyListed = new Set(
      (
        await pool.query<{ species_id: string }>(
          `SELECT DISTINCT species_id FROM region_species WHERE region_id = ANY($1)
             OR region_id IN (SELECT p.id FROM regions p WHERE p.parent_id = ANY($1) OR p.home_country_id = ANY($1))`,
          [neighbours.rows.map((n) => n.id)],
        )
      ).rows.map((r) => r.species_id),
    );

    const lists2: Array<{ region: (typeof regions.rows)[number] | null | undefined; rows: PackRow[] }> = [
      { region: regions.rows.find((r) => r.id === country.id), rows: lists.country },
      ...lists.provinces.map((p) => ({ region: byName.get(p.name), rows: p.species })),
    ];
    for (const { region, rows } of lists2) {
      for (const row of rows) {
        const id = idByName.get(row.name);
        const s = id ? byId.get(id) : undefined;
        if (region && s && listed.has(`${region.id}|${s.id}`)) continue;
        const key = `${region?.id}|${s?.id ?? row.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let decision = "restore";
        if (!region) decision = "skip: region not found";
        else if (!s) decision = "skip: species gone from the catalog";
        else if (s.gone) decision = "skip: extinct or hidden";
        else if (NEVER_LISTED_SPECIES.includes(s.name)) decision = "skip: never listed";
        else if (s.domestic) decision = "skip: farm animal";
        else if (captive.has(s.name)) decision = "skip: escape-prone pet";
        else if (removed.has(`${region.name}|${s.name}`) || removed.has(`${region.name}|${s.common}`))
          decision = "skip: removed on purpose by a clean-up";
        else if (s.taxon_class === "aves") {
          const codes = region.ebird_region_code ? cachedEbirdCodes(region.ebird_region_code) : null;
          if (codes && codes.size > 0 && (!s.ebird_code || !codes.has(s.ebird_code)))
            decision = "skip: bird not on eBird's list there";
        }
        const support = !s
          ? ""
          : [
              (s.inat_taxon_id != null && inatTaxa.has(s.inat_taxon_id)) || inatNames.has(s.name) ? "inat" : "",
              nearbyListed.has(s.id) ? "listed nearby" : "",
              s.endemic && (country.codes ?? []).includes(s.endemic) ? "endemic" : "",
            ]
              .filter(Boolean)
              .join("+");
        // Contradicted by an independent source: endemic to another country, or listed now only on
        // other continents (an aquarium escape or a misidentification).
        const continents = s ? continentsOf.get(s.id) : undefined;
        if (decision === "restore" && s?.endemic && !(country.codes ?? []).includes(s.endemic))
          decision = "skip: endemic to another country";
        else if (decision === "restore" && continents && !continents.has(country.continent))
          decision = "skip: listed only on other continents";
        if (decision === "restore" && values["require-support"] && !support) decision = "skip: no independent support";
        count(decision);
        if (decision === "restore") count(support ? "restore, supported" : "restore, unsupported");
        tsv.push([country.name, region?.name ?? "", row.name, s?.taxon_class ?? "", decision, support].join("\t"));
        if (decision === "restore")
          inserts.push({ regionId: region!.id, speciesId: s!.id, frequency: row.frequency, weekly: row.weekly });
      }
    }
  }
  writeFileSync(REVIEW_TSV, tsv.join("\n") + "\n");
  for (const [k, v] of [...totals].sort()) console.log(`[restore] ${k}: ${v}`);
  console.log(`[restore] every decision in ${path.relative(PIPELINE_DIR, REVIEW_TSV)}`);
  if (values.apply && inserts.length > 0) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (let i = 0; i < inserts.length; i += 5000) {
        const b = inserts.slice(i, i + 5000);
        await client.query(
          `INSERT INTO region_species (region_id, species_id, local_frequency, weekly_frequency, is_vagrant, is_invasive, evidence_source)
           SELECT v.r, v.s, v.f, CASE WHEN v.w = '' THEN NULL ELSE v.w::int[] END, true, false, $5
           FROM unnest($1::uuid[], $2::uuid[], $3::numeric[], $4::text[]) AS v(r, s, f, w)
           ON CONFLICT (region_id, species_id) DO NOTHING`,
          [
            b.map((x) => x.regionId),
            b.map((x) => x.speciesId),
            b.map((x) => x.frequency),
            b.map((x) => (x.weekly ? `{${x.weekly.join(",")}}` : "")),
            EVIDENCE,
          ],
        );
      }
      // A group or country lists whatever its provinces list.
      await client.query(
        `INSERT INTO region_species (region_id, species_id, is_vagrant, is_invasive, evidence_source)
         SELECT DISTINCT p.parent_id, rs.species_id, true, false, $1
         FROM region_species rs JOIN regions p ON p.id = rs.region_id
         WHERE rs.evidence_source = $1 AND p.parent_id IN (SELECT id FROM (${COUNTRIES_SQL}) c
                 UNION SELECT g.id FROM regions g JOIN (${COUNTRIES_SQL}) c ON g.parent_id = c.id)
         ON CONFLICT (region_id, species_id) DO NOTHING`,
        [EVIDENCE],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    console.log(`[restore] restored ${inserts.length} rows, flagged vagrant; rerun the tiers stage next`);
  } else console.log("[restore] preview only (pass --apply)");
  await pool.end();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
