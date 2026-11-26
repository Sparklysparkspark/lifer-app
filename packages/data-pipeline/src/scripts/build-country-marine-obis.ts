// Country checklist rows for marine invertebrates (and sea turtles and sea snakes) from OBIS's
// country areas (docs/plans/marine-coverage.md, option B). The sea zones list a whole basin; these
// rows say a species was recorded in the country's own waters. Run after build-country-checklists
// (which rebuilds country rows and would drop these) and before apply-inat-membership, which flags
// one iNaturalist lacks as vagrant where it covers the group: flagged, never removed.
//
//   npm run build-country-marine-obis -w data-pipeline                    dry run: counts per country and class
//   npm run build-country-marine-obis -w data-pipeline -- --apply         writes
//   ... --countries=Belize,Honduras    only these countries
//   ... --offline                      cached OBIS answers only; uncached countries are skipped
//   ... --any-records                  keep a species with any OBIS record, not only 5+
//
// Keeps a catalog species (matched by name, synonym, or iNaturalist's current name for it) with 5
// or more OBIS records in the country's waters, or 1 or more and 3 research-grade iNaturalist
// photos in the country, as the sea zones do; and only when a sea zone next to the country lists
// it, so the zones' basin-stray check (sea-basins.ts) covers these rows too. Rows already listed
// are left alone. Each written row has evidence_source 'obis', so a Preen export can drop them.
// Answers are cached in data/obis-checklist-cache/areas/<area id>/ with each area's dataset
// licences (datasets.json); every row and the licence mix go to data/review/obis-country-*.tsv.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { pool } from "@lifer/core/db.js";
import { httpFetch } from "@lifer/core/lib/http.js";
import { lockReferenceData } from "@lifer/core/lib/referenceDataLock.js";
import { COUNTRIES_SQL, provinceIdsSql } from "@lifer/core/regions/regionTree.js";
import {
  INAT_CONFIRM_MIN_OBSERVATIONS,
  MARINE_EXTRA_CLASSES,
  MARINE_MIN_RECORDS,
  OBIS_GROUPS,
  tallyZone,
  type ObisChecklistRow,
} from "../build/sea-zone-marine.js";
import { cachedPlaceCounts, loadInatCurrentTaxonDiskCache } from "../regions/inatChecklist.js";
import { OBIS_CACHE_DIR, obisChecklist } from "./build-sea-zones-marine.js";

const AREAS_DIR = path.join(OBIS_CACHE_DIR, "areas");
const REVIEW_DIR = path.join(OBIS_CACHE_DIR, "..", "review");
const OBIS_API = "https://api.obis.org/v3";
export const OBIS_EVIDENCE = "obis";
const log = (m: string) => console.log(`[country-marine-obis] ${m}`);

export interface ObisArea {
  id: string;
  name: string;
  type: string;
}

// OBIS spells these countries and territories differently from the catalog (Natural Earth).
const OBIS_NAMES: Record<string, string> = {
  "Antigua and Barbuda": "Antigua and Barb.",
  "Bosnia and Herzegovina": "Bosnia and Herz.",
  "Cape Verde": "Cabo Verde",
  "Comoro Islands": "Comoros",
  "Dominican Republic": "Dominican Rep.",
  "East Timor": "Timor-Leste",
  "Equatorial Guinea": "Eq. Guinea",
  "Guinea Bissau": "Guinea-Bissau",
  "Ivory Coast": "Côte d'Ivoire",
  "Marshall Islands": "Marshall Is.",
  "Palestine, State of": "Palestine",
  "Republic of Korea": "South Korea",
  "République du Congo": "Congo",
  "Saint Kitts and Nevis": "St. Kitts and Nevis",
  "Saint Vincent and the Grenadines": "St. Vin. and Gren.",
  "Sao Tome and Principe": "São Tomé and Principe",
  "Solomon Islands": "Solomon Is.",
  Türkiye: "Turkey",
  "United States": "United States of America",
  "Faeroe Islands": "Faeroe Is.",
  "French Polynesia": "Fr. Polynesia",
  "Wallis and Futuna": "Wallis and Futuna Is.",
  "Saint Pierre and Miquelon": "St. Pierre and Miquelon",
  "Northern Saint-Martin": "St-Martin",
  "Clipperton Island": "Clipperton I.",
  "Heard and McDonald Islands": "Heard I. and McDonald Is.",
  "Cook Islands": "Cook Is.",
  "Sint-Maarten": "Sint Maarten",
  "British Indian Ocean Territory": "Br. Indian Ocean Ter.",
  "British Virgin Islands": "British Virgin Is.",
  "Cayman Islands": "Cayman Is.",
  Pitcairn: "Pitcairn Is.",
  "South Georgia and the South Sandwich Islands": "S. Geo. and the Is.",
  "Turks and Caicos Islands": "Turks and Caicos Is.",
};
// Islands that are provinces of the country itself, not overseas territories.
const HOME_ISLANDS = new Set([
  "Ecuador: Galapagos Islands",
  "India: Andaman and Nicobar",
  "Portugal: Azores",
  "Portugal: Madeira",
  "Spain: Canary Islands",
  "United States: Hawaii",
  "Australia: Macquarie Island",
  "Brazil: Trindade",
  "Chile: Easter Island",
]);
const SEA_PART = /Sea|Ocean|Atlantic|Pacific/;

/** OBIS country areas per catalog country: the area named after it, its coast parts ("Canada:
 *  North Atlantic", "Israel: Red Sea") and its home islands. Parts never overlap, so their
 *  records add up. "X: all" is never used: it holds
 *  overseas territories too (France's takes in French Polynesia). A territory area named after a
 *  catalog country ("United Kingdom: Bermuda") goes to that country. Joint regimes go nowhere. */
export function countryAreas(areas: ObisArea[], countryNames: Set<string>): Map<string, ObisArea[]> {
  const out = new Map<string, ObisArea[]>();
  const add = (country: string, a: ObisArea) => out.set(country, [...(out.get(country) ?? []), a]);
  const catalogName = (n: string) => {
    const name = OBIS_NAMES[n] ?? n;
    return countryNames.has(name) ? name : null;
  };
  for (const a of areas.filter((x) => x.type === "obis")) {
    const [head, ...rest] = a.name.split(":").map((s) => s.trim());
    if (rest.length === 0) {
      const c = catalogName(head);
      if (c) add(c, a);
      continue;
    }
    const tail = rest.join(": ");
    if (tail === "all") continue;
    const territory = catalogName(tail);
    const country = catalogName(head);
    if (territory && territory !== country) add(territory, a);
    else if (country && (HOME_ISLANDS.has(a.name) || SEA_PART.test(tail))) add(country, a);
  }
  return out;
}

/** "CC0", "CC BY", "CC BY-NC" or "other" from an OBIS dataset's rights statement. */
export function licenceOf(rights: string | null | undefined): string {
  const r = rights ?? "";
  if (/CC0|Public Domain|waived all rights/i.test(r)) return "CC0";
  if (/Non ?Commercial|BY-NC/i.test(r)) return "CC BY-NC";
  if (/CC[- ]BY|Attribution/i.test(r)) return "CC BY";
  return "other";
}

/** The rows a country keeps: well recorded there, or recorded and photographed there, and listed
 *  by a sea zone next to it. */
export function keepCountryRows(
  tally: Map<string, number>,
  opts: { minRecords: number; photographed: (id: string) => boolean; onNearbyZone: (id: string) => boolean },
): Array<{ speciesId: string; records: number }> {
  const out: Array<{ speciesId: string; records: number }> = [];
  for (const [speciesId, records] of tally)
    if ((records >= opts.minRecords || (records >= 1 && opts.photographed(speciesId))) && opts.onNearbyZone(speciesId))
      out.push({ speciesId, records });
  return out;
}

async function obisJson<T>(url: string): Promise<T> {
  // One request at a time, a second apart: OBIS is a public service.
  const res = await httpFetch(url, { maxRetries: 5, retryServerErrors: true, paceMs: 1000, timeoutMs: 180_000 });
  if (!res.ok) throw new Error(`OBIS answered HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

async function areaList(offline: boolean): Promise<ObisArea[] | null> {
  const file = path.join(AREAS_DIR, "area-list.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as ObisArea[];
  if (offline) return null;
  const body = await obisJson<{ results: ObisArea[] }>(`${OBIS_API}/area`);
  const areas = body.results.map(({ id, name, type }) => ({ id: String(id), name, type }));
  mkdirSync(AREAS_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(areas));
  return areas;
}

interface DatasetLicence {
  id: string;
  title: string;
  licence: string;
  records: number;
}

/** Every dataset with records in an area, with its licence; cached. */
async function areaDatasets(areaId: string, offline: boolean): Promise<DatasetLicence[] | null> {
  const file = path.join(AREAS_DIR, areaId, "datasets.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as DatasetLicence[];
  if (offline) return null;
  const out: DatasetLicence[] = [];
  let total = 0;
  for (let skip = 0; skip === 0 || skip < total; skip += 1000) {
    const body = await obisJson<{
      total: number;
      results: Array<{ id: string; title: string; intellectualrights?: string; records?: number }>;
    }>(`${OBIS_API}/dataset?${new URLSearchParams({ areaid: areaId, size: "1000", skip: String(skip) })}`);
    total = body.total;
    for (const d of body.results)
      out.push({ id: d.id, title: d.title, licence: licenceOf(d.intellectualrights), records: d.records ?? 0 });
    if (body.results.length === 0) break;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out));
  return out;
}

/** Catalog marine species by every name OBIS might use: scientific name, synonym, and names
 *  iNaturalist has moved to a catalog species' taxon (the name-drift cache). */
async function marineNameIndex(): Promise<Map<string, string>> {
  const res = await pool.query<{ name: string; id: string; inat_taxon_id: number | null }>(
    `SELECT DISTINCT ON (n.name) n.name, n.id, n.inat_taxon_id FROM (
       SELECT scientific_name AS name, id, inat_taxon_id, 0 AS pref FROM species
        WHERE NOT is_other_taxa AND taxon_class = ANY($1)
       UNION ALL
       SELECT ss.synonym_name, s.id, s.inat_taxon_id, 1 FROM species_synonyms ss JOIN species s ON s.id = ss.species_id
        WHERE NOT s.is_other_taxa AND s.taxon_class = ANY($1)
     ) n ORDER BY n.name, n.pref`,
    [MARINE_EXTRA_CLASSES],
  );
  const byName = new Map(res.rows.map((r) => [r.name, r.id]));
  const byInat = new Map(res.rows.filter((r) => r.inat_taxon_id != null).map((r) => [Number(r.inat_taxon_id), r.id]));
  for (const [name, taxon] of Object.entries(loadInatCurrentTaxonDiskCache()))
    if (taxon != null && !byName.has(name) && byInat.has(taxon)) byName.set(name, byInat.get(taxon)!);
  return byName;
}

/** Replaces each country's 'obis' rows with `keep`, leaving rows from other sources alone, in one
 *  transaction under the catalog lock. Flags a species the catalog marks non-native there. */
export async function writeCountryRows(
  plans: Array<{ id: string; keep: Array<{ speciesId: string }> }>,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockReferenceData(client);
    let written = 0;
    for (const p of plans) {
      await client.query(`DELETE FROM region_species WHERE region_id = $1 AND evidence_source = $2`, [
        p.id,
        OBIS_EVIDENCE,
      ]);
      written +=
        (
          await client.query(
            `INSERT INTO region_species (region_id, species_id, is_vagrant, is_invasive, evidence_source)
             SELECT $1, v.id, EXISTS (SELECT 1 FROM species_nonnative_countries snc, regions r
                                       WHERE r.id = $1 AND snc.species_id = v.id AND snc.country_iso3 = ANY(r.external_codes)),
                    false, $3
             FROM unnest($2::uuid[]) AS v(id)
             ON CONFLICT (region_id, species_id) DO NOTHING`,
            [p.id, p.keep.map((k) => k.speciesId), OBIS_EVIDENCE],
          )
        ).rowCount ?? 0;
    }
    await client.query("COMMIT");
    return written;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      apply: { type: "boolean", default: false },
      offline: { type: "boolean", default: false },
      "any-records": { type: "boolean", default: false },
      countries: { type: "string" },
    },
  });
  const only = values.countries
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const minRecords = values["any-records"] ? 1 : MARINE_MIN_RECORDS;
  try {
    const countries = (
      await pool.query<{ id: string; name: string; inat_place_id: number | null; zone_ids: string[] }>(
        `SELECT c.id, c.name, r.inat_place_id,
                ARRAY(SELECT DISTINCT z FROM regions p, unnest(p.nearby_sea_zone_ids) z
                      WHERE p.id = c.id OR p.id IN (${provinceIdsSql("c.id")})) AS zone_ids
         FROM (${COUNTRIES_SQL}) c JOIN regions r ON r.id = c.id ORDER BY c.name`,
      )
    ).rows;
    if (only) {
      const missing = only.filter((n) => !countries.some((c) => c.name === n));
      if (missing.length > 0) throw new Error(`No country named ${missing.join(", ")}`);
    }
    const areas = await areaList(values.offline);
    if (!areas) {
      log("no cached OBIS area list (--offline): nothing to do");
      return;
    }
    const byCountry = countryAreas(areas, new Set(countries.map((c) => c.name)));
    const names = await marineNameIndex();
    const classOf = new Map(
      (
        await pool.query<{ id: string; taxon_class: string }>(
          `SELECT id, taxon_class FROM species WHERE taxon_class = ANY($1) AND NOT is_other_taxa`,
          [MARINE_EXTRA_CLASSES],
        )
      ).rows.map((r) => [r.id, r.taxon_class]),
    );
    const speciesByInat = new Map(
      (
        await pool.query<{ id: string; inat_taxon_id: number }>(
          `SELECT id, inat_taxon_id FROM species WHERE inat_taxon_id IS NOT NULL AND taxon_class = ANY($1)`,
          [MARINE_EXTRA_CLASSES],
        )
      ).rows.map((r) => [Number(r.inat_taxon_id), r.id]),
    );

    const rowsOut = ["country\tclass\tspecies_id\trecords"];
    const licencesOut = ["country\tarea\tdatasets\tCC0\tCC BY\tCC BY-NC\tother\tCC BY-NC records share"];
    const plans: Array<{ id: string; name: string; keep: Array<{ speciesId: string; records: number }> }> = [];
    const todo = countries.filter((c) => byCountry.has(c.name) && (!only || only.includes(c.name)));
    for (const [i, c] of todo.entries()) {
      const rows: ObisChecklistRow[] = [];
      let complete = true;
      for (const a of byCountry.get(c.name)!) {
        for (const group of OBIS_GROUPS) {
          const got = await obisChecklist(
            path.join(AREAS_DIR, a.id, `${group}.json`),
            { areaid: a.id },
            group,
            values.offline,
          );
          if (got) rows.push(...got);
          else complete = false;
        }
        const ds = await areaDatasets(a.id, values.offline);
        if (ds) {
          const n = (l: string) => ds.filter((d) => d.licence === l).length;
          const all = ds.reduce((s, d) => s + d.records, 0);
          const nc = ds.filter((d) => d.licence === "CC BY-NC").reduce((s, d) => s + d.records, 0);
          licencesOut.push(
            [
              c.name,
              a.name,
              ds.length,
              n("CC0"),
              n("CC BY"),
              n("CC BY-NC"),
              n("other"),
              all ? (nc / all).toFixed(2) : "",
            ].join("\t"),
          );
        }
      }
      if ((i + 1) % 20 === 0) log(`${i + 1}/${todo.length} countries read`);
      if (!complete) {
        log(`${c.name}: not cached, skipped (--offline)`);
        continue;
      }
      const zoneSpecies = new Set(
        (
          await pool.query<{ species_id: string }>(
            `SELECT DISTINCT species_id FROM sea_zone_species WHERE sea_zone_id = ANY($1)`,
            [c.zone_ids],
          )
        ).rows.map((r) => r.species_id),
      );
      const photographed = new Set<string>();
      for (const [taxon, t] of (c.inat_place_id != null ? cachedPlaceCounts(c.inat_place_id) : null) ?? [])
        if (t.count >= INAT_CONFIRM_MIN_OBSERVATIONS && speciesByInat.has(taxon))
          photographed.add(speciesByInat.get(taxon)!);
      const keep = keepCountryRows(tallyZone(rows, names), {
        minRecords,
        photographed: (id) => photographed.has(id),
        onNearbyZone: (id) => zoneSpecies.has(id),
      });
      plans.push({ id: c.id, name: c.name, keep });
    }

    let added = 0;
    for (const p of plans) {
      // Rows from another source stay as they are; this step's own earlier rows are replaced.
      const listed = new Set(
        (
          await pool.query<{ species_id: string }>(
            `SELECT species_id FROM region_species WHERE region_id = $1 AND evidence_source IS DISTINCT FROM $2`,
            [p.id, OBIS_EVIDENCE],
          )
        ).rows.map((r) => r.species_id),
      );
      const fresh = p.keep.filter((k) => !listed.has(k.speciesId));
      added += fresh.length;
      const counts = new Map<string, number>();
      for (const k of fresh) {
        const cls = classOf.get(k.speciesId) ?? "?";
        counts.set(cls, (counts.get(cls) ?? 0) + 1);
        rowsOut.push([p.name, cls, k.speciesId, k.records].join("\t"));
      }
      if (fresh.length > 0) log(`${p.name}: +${fresh.length} (${[...counts].map(([k, v]) => `${k} ${v}`).join(", ")})`);
      p.keep = fresh;
    }
    log(
      `${plans.length} countries: ${added} rows ${values.apply ? "to write" : "would be written"} ` +
        `(${minRecords === 1 ? "any record" : `${minRecords}+ records, or 1+ and photographed`}, on a nearby sea zone)`,
    );
    if (values.apply) log(`${await writeCountryRows(plans)} rows written`);
    else log("dry run, nothing written; rerun with --apply");
    mkdirSync(REVIEW_DIR, { recursive: true });
    writeFileSync(path.join(REVIEW_DIR, "obis-country-rows.tsv"), rowsOut.join("\n") + "\n");
    writeFileSync(path.join(REVIEW_DIR, "obis-country-licences.tsv"), licencesOut.join("\n") + "\n");
    log("rows and dataset licences in data/review/obis-country-rows.tsv and obis-country-licences.tsv");
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
