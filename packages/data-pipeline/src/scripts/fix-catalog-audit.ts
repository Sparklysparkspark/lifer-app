// Hand-checked catalog fixes from the data audits (docs/plans/belize-data-audit.md), as one
// idempotent command over data already in the database: no GBIF or other downloads. The reviewed
// decisions live in data/reference/catalog-audit-fixes.json; every change goes to
// data/review/catalog-audit-fixes.tsv. Changes nothing without --apply.
//
// Passes, always in this order, all in one transaction:
//   inat-ids         iNaturalist ids from the local taxa dump, by exact name, where no other
//                    species holds the id (first: after any other write to species in the same
//                    transaction, Postgres takes minutes over this bulk update instead of a second)
//   names            merges the fixes file names (rows of species-merges.tsv), renames, wrong
//                    common names, then species-corrections.json
//   bird-names       birds with no English name get eBird's for their eBird code
//   extinct          species on no list and in no one's photos that eBird calls extinct, that the
//                    cached GBIF profiles call fossil (check-fossil-status.ts's rule, offline), or
//                    birds eBird's taxonomy doesn't know that have no English name (fossils and
//                    retired names) are flagged fully_extinct: kept, but off lists, Collection and
//                    search
//   ranges          range exclusions, and old names a split replaced where the new one is listed
//   additions        species an open regional list names that no built list has (evidence "list")
//   unlisted-birds   bird listings with a handful of records that the region's cached eBird list
//                    (every species ever reported there, vagrants and escapes included) lacks,
//                    where that list is near complete, unless iNaturalist confirms it there
//   flags            vagrant and introduced overrides (region_species_manual_overrides)
//   resident-mammals native bats and rodents flagged vagrant from record counts alone, where the
//                    species lives within NEIGHBOUR_KM
//   classes          species filed under another class than the rest of their order
//   sea-basins       sea zone rows kept only across a land bridge, and strays from another ocean
//   shared-names     report only: common names two species share within one country's view
//
//   npm run fix-catalog-audit -w data-pipeline -- [--passes=names,sea-basins] [--apply]
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import type { PoolClient } from "pg";
import { lockReferenceData } from "@lifer/core/lib/referenceDataLock.js";
import { PROVINCES_WITH_COUNTRY_SQL } from "@lifer/core/regions/regionTree.js";
import { pool } from "../db.js";
import { loadIhoFeatures } from "../fetch/fetch-iho-sea-areas.js";
import { loadEezIhoFeatures } from "../fetch/fetch-eez-iho.js";
import { exteriorRingsOf, zoneNeighbours } from "../build/zone-neighbours.js";
import { assignBasins, decideBasinStrays, landBridges, type Basin } from "../build/sea-basins.js";
import { applySpeciesCorrections, loadSpeciesCorrections } from "../pipeline/speciesCorrections.js";
import { DEFAULT_LIST as MERGES_TSV, mergeListedSpecies, readList } from "./merge-duplicate-species.js";
import { NEIGHBOUR_KM, referenceListings } from "./remove-escapes.js";
import { requirePostgis } from "../pipeline/requirePostgis.js";
import { inatConfirmedListings } from "./apply-inat-membership.js";
import { toTitleCase } from "../fetch/fetch-gbif-vernacular.js";
import { loadEbird, type EbirdRow } from "./add-missing-species.js";
import { CACHE_DIR as GBIF_PROFILES_DIR, RECENT_OBS_CACHE_DIR, TAXONOMIC_SOURCES } from "./check-fossil-status.js";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
export const FIXES_FILE = path.join(DATA_DIR, "reference", "catalog-audit-fixes.json");
const REVIEW_TSV = path.join(DATA_DIR, "review", "catalog-audit-fixes.tsv");
const ZONE_COUNTS_TSV = path.join(DATA_DIR, "review", "catalog-audit-sea-zone-counts.tsv");
const SHARED_NAMES_TSV = path.join(DATA_DIR, "review", "shared-common-names.tsv");
const EBIRD_SPPLIST_DIR = path.join(DATA_DIR, "ebird-spplist-cache");
const INAT_TAXA_DUMP = path.join(DATA_DIR, "open-vectors", "inat", "taxa.csv.gz");
const SHARED_INAT_TSV = path.join(DATA_DIR, "review", "shared-inat-taxa.tsv");

// FishBase depth at which a fish counts as deep-sea for the stray review.
const DEEP_SEA_MIN_DEPTH_M = 200;
// GBIF records (eBird's included) or iNaturalist photos, whichever is more: a real resident or a
// recurring vagrant has more, and is on eBird's list anyway.
export const UNLISTED_BIRD_MAX_RECORDS = 5;
// eBird's absence only counts where its list already has nearly all the region's well-recorded
// birds; in little-birded places it misses real residents.
export const EBIRD_MIN_COVERAGE = 0.95;
const EBIRD_MIN_WELL_RECORDED = 20;
// Under-recorded rather than wandering: no record count says one of these is passing through.
const RESIDENT_ORDERS = ["Chiroptera", "Rodentia"];

export const PASSES = [
  "inat-ids",
  "names",
  "bird-names",
  "extinct",
  "ranges",
  "additions",
  "unlisted-birds",
  "flags",
  "resident-mammals",
  "classes",
  "sea-basins",
  "shared-names",
] as const;
type Pass = (typeof PASSES)[number];

export interface Fixes {
  merges: string[];
  renames: Array<{ from: string; to: string; reason: string }>;
  wrongCommonNames: Array<{ scientificName: string; commonName: string; reason: string }>;
  replacedNames: Array<{ scientificName: string; replacedBy: string; reason: string }>;
  rangeExclusions: Array<{
    scientificName: string;
    keepZones?: string[];
    dropZones?: string[];
    keepCountries?: string[];
    dropCountries?: string[];
    keepBasins?: Basin[];
    reason: string;
  }>;
  flagOverrides: Array<{
    scientificName: string;
    country: string;
    isVagrant?: boolean;
    isInvasive?: boolean;
    reason: string;
  }>;
  basinAllow: Array<{ scientificName: string; reason: string }>;
  seaLinks: Array<{ zones: [string, string]; reason: string }>;
  additions: Array<{ scientificName: string; country: string; source: string; reason: string }>;
}

export function parseFixes(json: unknown): Fixes {
  const f = json as Partial<Fixes>;
  const lists = [
    "merges",
    "renames",
    "wrongCommonNames",
    "replacedNames",
    "rangeExclusions",
    "flagOverrides",
    "basinAllow",
    "seaLinks",
    "additions",
  ] as const;
  for (const k of lists) if (!Array.isArray(f[k])) throw new Error(`catalog audit fixes: ${k} must be a list`);
  for (const k of lists.slice(1)) {
    (f[k] as Array<{ reason?: unknown }>).forEach((e, i) => {
      if (typeof e?.reason !== "string" || !e.reason) throw new Error(`catalog audit fixes: ${k}[${i}] has no reason`);
    });
  }
  for (const e of [...f.flagOverrides!, ...f.additions!]) {
    if (!/^[A-Z]{3}$/.test(e.country)) throw new Error(`catalog audit fixes: bad country ${e.country}`);
  }
  for (const e of f.additions!)
    if (!e.source) throw new Error(`catalog audit fixes: ${e.scientificName} has no source`);
  for (const e of f.flagOverrides!) {
    if (e.isVagrant === undefined && e.isInvasive === undefined)
      throw new Error(`catalog audit fixes: ${e.scientificName} override sets nothing`);
  }
  return f as Fixes;
}

/** For each order whose species sit in more than one class, the class most of them have; the
 *  rest were filed under the wrong class (whales as fish). Orders with a tie are left out. */
export function majorityClassByOrder(rows: Array<{ order: string; cls: string; n: number }>): Map<string, string> {
  const byOrder = new Map<string, Array<{ cls: string; n: number }>>();
  for (const r of rows) byOrder.set(r.order, [...(byOrder.get(r.order) ?? []), r]);
  const out = new Map<string, string>();
  for (const [order, classes] of byOrder) {
    if (classes.length < 2) continue;
    const [first, second] = [...classes].sort((a, b) => b.n - a.n);
    if (first.n > second.n) out.set(order, first.cls);
  }
  return out;
}

export interface Decision {
  pass: Pass;
  action: string;
  speciesId: string;
  name: string;
  where: string;
  detail: string;
  reason: string;
}

const tsvCell = (v: string) => v.replace(/[\t\n]/g, " ");

// Region id to the country (three-letter code) it belongs to, walking up the parents.
const COUNTRY_OF_REGION = `
  WITH RECURSIVE up(rid, cur) AS (
    SELECT id, id FROM regions
    UNION ALL
    SELECT u.rid, r.parent_id FROM up u JOIN regions r ON r.id = u.cur
    WHERE r.parent_id IS NOT NULL AND NOT (r.external_codes[1] ~ '^[A-Z]{3}$')
  )
  SELECT u.rid AS region_id, r.external_codes[1] AS iso3
  FROM up u JOIN regions r ON r.id = u.cur WHERE r.external_codes[1] ~ '^[A-Z]{3}$'`;

export async function namesPass(client: PoolClient, fixes: Fixes, out: Decision[]): Promise<void> {
  for (const w of fixes.wrongCommonNames) {
    const res = await client.query<{ id: string }>(
      `UPDATE species SET common_name = NULL WHERE scientific_name = $1 AND common_name = $2 RETURNING id`,
      [w.scientificName, w.commonName],
    );
    for (const r of res.rows)
      out.push({
        pass: "names",
        action: "clear-common-name",
        speciesId: r.id,
        name: w.scientificName,
        where: "",
        detail: w.commonName,
        reason: w.reason,
      });
  }

  const mergeRows = readList(MERGES_TSV).filter((r) => fixes.merges.includes(r.oldName));
  const pending = await client.query<{ id: string; scientific_name: string }>(
    `SELECT id, scientific_name FROM species WHERE id = ANY($1)`,
    [mergeRows.map((r) => r.oldId)],
  );
  if (pending.rows.length > 0) {
    await mergeListedSpecies(client, mergeRows);
    for (const p of pending.rows) {
      const into = mergeRows.find((r) => r.oldId === p.id)!;
      out.push({
        pass: "names",
        action: "merge",
        speciesId: p.id,
        name: p.scientific_name,
        where: "",
        detail: `into ${into.newName}`,
        reason: "species-merges.tsv",
      });
    }
  }

  for (const r of fixes.renames) {
    const from = await client.query<{ id: string }>(`SELECT id FROM species WHERE scientific_name = $1`, [r.from]);
    if (from.rows.length === 0) continue;
    const id = from.rows[0].id;
    const clash = await client.query(`SELECT 1 FROM species WHERE scientific_name = $1`, [r.to]);
    if (clash.rows.length > 0) {
      out.push({
        pass: "names",
        action: "rename-skipped",
        speciesId: id,
        name: r.from,
        where: "",
        detail: `${r.to} already exists: list it in species-merges.tsv instead`,
        reason: r.reason,
      });
      continue;
    }
    await client.query(`DELETE FROM species_synonyms WHERE species_id = $1 AND lower(synonym_name) = lower($2)`, [
      id,
      r.to,
    ]);
    await client.query(`UPDATE species SET scientific_name = $2 WHERE id = $1`, [id, r.to]);
    // The old name stays searchable and matches keyword tags.
    await client.query(
      `INSERT INTO species_synonyms (species_id, synonym_name, source) VALUES ($1, $2, 'catalog-audit')
       ON CONFLICT (synonym_name) DO UPDATE SET species_id = EXCLUDED.species_id`,
      [id, r.from],
    );
    out.push({
      pass: "names",
      action: "rename",
      speciesId: id,
      name: r.from,
      where: "",
      detail: `to ${r.to}`,
      reason: r.reason,
    });
  }

  const corrections = loadSpeciesCorrections().filter((c) => c.commonName !== undefined);
  const before = await client.query<{ id: string; scientific_name: string; common_name: string | null }>(
    `SELECT id, scientific_name, common_name FROM species WHERE scientific_name = ANY($1) AND NOT is_other_taxa`,
    [corrections.map((c) => c.scientificName)],
  );
  await applySpeciesCorrections(client, loadSpeciesCorrections());
  for (const b of before.rows) {
    const c = corrections.find((x) => x.scientificName === b.scientific_name)!;
    if (b.common_name !== c.commonName)
      out.push({
        pass: "names",
        action: "common-name",
        speciesId: b.id,
        name: b.scientific_name,
        where: "",
        detail: `${b.common_name ?? "(none)"} to ${c.commonName}`,
        reason: c.reason,
      });
  }
}

export async function birdNamesPass(client: PoolClient, out: Decision[], ebird: EbirdRow[]) {
  const named = new Map(ebird.filter((r) => r.category === "species" && r.common).map((r) => [r.code, r.common]));
  const res = await client.query<{ id: string; scientific_name: string; ebird_code: string }>(
    `SELECT id, scientific_name, ebird_code FROM species
     WHERE taxon_class = 'aves' AND COALESCE(common_name, '') = '' AND ebird_code IS NOT NULL AND NOT is_other_taxa`,
  );
  const picked = res.rows.filter((r) => named.has(r.ebird_code));
  const names = picked.map((r) => toTitleCase(named.get(r.ebird_code)!));
  await client.query(
    `UPDATE species s SET common_name = v.name FROM unnest($1::uuid[], $2::text[]) AS v(id, name) WHERE s.id = v.id`,
    [picked.map((r) => r.id), names],
  );
  picked.forEach((r, i) =>
    out.push({
      pass: "bird-names",
      action: "common-name",
      speciesId: r.id,
      name: r.scientific_name,
      where: "",
      detail: `(none) to ${names[i]}`,
      reason: `eBird's name for ${r.ebird_code}`,
    }),
  );
}

export interface ExtinctEvidence {
  ebirdByName: Map<string, EbirdRow>;
  /** Also by code: an old name eBird has moved (Porzana palmeri) still carries the code. */
  ebirdByCode: Map<string, EbirdRow>;
  /** Cached GBIF species profile votes, null when not cached. */
  profile: (gbifKey: string) => { extinct: string[]; extant: string[] } | null;
  /** Cached GBIF observations since 1990, null when not cached. */
  recent: (gbifKey: string) => number | null;
}

/** Why a species on no list and in no one's photos is not a living species, or null. */
export function extinctReason(
  s: {
    scientific_name: string;
    taxon_class: string;
    common_name: string | null;
    ebird_code: string | null;
    gbif_key: string;
  },
  ev: ExtinctEvidence,
): string | null {
  const eb = ev.ebirdByName.get(s.scientific_name) ?? (s.ebird_code ? ev.ebirdByCode.get(s.ebird_code) : undefined);
  if (eb?.extinct) return "eBird's taxonomy marks it extinct";
  const votes = ev.profile(s.gbif_key);
  if (
    votes &&
    votes.extant.length === 0 &&
    votes.extinct.some((src) => TAXONOMIC_SOURCES.has(src)) &&
    ev.recent(s.gbif_key) === 0
  )
    return `extinct per ${votes.extinct.join(", ")}, no observation since 1990 (cached GBIF profile)`;
  // eBird lists every living bird species, so a nameless bird it doesn't know is a fossil or a retired name.
  if (s.taxon_class === "aves" && !s.common_name && !s.ebird_code && !eb)
    return "a bird eBird's taxonomy doesn't know, with no English name: a fossil or a retired name";
  return null;
}

/** check-fossil-status.ts's cached GBIF answers, read without fetching. */
export function cachedGbifEvidence(): Pick<ExtinctEvidence, "profile" | "recent"> {
  const read = (dir: string, key: string) => {
    const file = path.join(dir, `${key}.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  };
  return {
    profile: (key) => {
      const data = read(GBIF_PROFILES_DIR, key) as { results?: Array<{ extinct?: boolean; source?: string }> } | null;
      if (!data) return null;
      const flagged = (data.results ?? []).filter((r) => typeof r.extinct === "boolean");
      return {
        extinct: [...new Set(flagged.filter((r) => r.extinct).map((r) => r.source ?? "unknown source"))],
        extant: [...new Set(flagged.filter((r) => !r.extinct).map((r) => r.source ?? "unknown source"))],
      };
    },
    recent: (key) => (read(RECENT_OBS_CACHE_DIR, key) as { count?: number } | null)?.count ?? null,
  };
}

export async function extinctPass(client: PoolClient, out: Decision[], ev: ExtinctEvidence) {
  // Never a species someone has listed, photographed or marked: those need a person to look.
  const res = await client.query<{
    id: string;
    scientific_name: string;
    taxon_class: string;
    common_name: string | null;
    ebird_code: string | null;
    gbif_key: string;
  }>(
    `SELECT s.id, s.scientific_name, s.taxon_class, NULLIF(s.common_name, '') AS common_name, s.ebird_code, s.gbif_key::text
     FROM species s JOIN species_traits t ON t.species_id = s.id
     WHERE NOT t.fully_extinct AND NOT s.is_other_taxa
       AND NOT EXISTS (SELECT 1 FROM region_species rs WHERE rs.species_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM sea_zone_species x WHERE x.species_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM captures_all c WHERE c.species_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM user_species u WHERE u.species_id = s.id)`,
  );
  const flagged = res.rows.flatMap((s) => {
    const reason = extinctReason(s, ev);
    return reason ? [{ s, reason }] : [];
  });
  await client.query(`UPDATE species_traits SET fully_extinct = true WHERE species_id = ANY($1)`, [
    flagged.map((f) => f.s.id),
  ]);
  for (const { s, reason } of flagged)
    out.push({
      pass: "extinct",
      action: "fully-extinct",
      speciesId: s.id,
      name: s.scientific_name,
      where: "",
      detail: s.common_name ?? "(no name)",
      reason,
    });
}

async function deleteRegionRows(
  client: PoolClient,
  speciesId: string,
  whereSql: string,
  params: unknown[],
): Promise<Array<{ region: string; rg: number | null }>> {
  const res = await client.query<{ region: string; rg: number | null }>(
    `WITH gone AS (DELETE FROM region_species rs WHERE rs.species_id = $1 AND ${whereSql} RETURNING rs.region_id, rs.inat_rg_count)
     SELECT r.name AS region, g.inat_rg_count AS rg FROM gone g JOIN regions r ON r.id = g.region_id ORDER BY 1`,
    [speciesId, ...params],
  );
  return res.rows;
}

async function deleteZoneRows(client: PoolClient, speciesId: string, whereSql: string, params: unknown[]) {
  const res = await client.query<{ zone: string; record_count: number }>(
    `WITH gone AS (DELETE FROM sea_zone_species x WHERE x.species_id = $1 AND ${whereSql} RETURNING x.sea_zone_id, x.record_count)
     SELECT z.name AS zone, g.record_count FROM gone g JOIN sea_zones z ON z.id = g.sea_zone_id ORDER BY 1`,
    [speciesId, ...params],
  );
  return res.rows;
}

export async function rangesPass(client: PoolClient, fixes: Fixes, out: Decision[], ensureBasins: () => Promise<void>) {
  for (const e of fixes.rangeExclusions) {
    const sp = await client.query<{ id: string }>(`SELECT id FROM species WHERE scientific_name = $1`, [
      e.scientificName,
    ]);
    const id = sp.rows[0]?.id;
    if (!id) continue;
    const push = (where: string, detail: string) =>
      out.push({
        pass: "ranges",
        action: "remove",
        speciesId: id,
        name: e.scientificName,
        where,
        detail,
        reason: e.reason,
      });
    const zoneIn = `x.sea_zone_id IN (SELECT id FROM sea_zones WHERE name = ANY($2))`;
    if (e.keepZones)
      for (const z of await deleteZoneRows(client, id, `NOT ${zoneIn}`, [e.keepZones]))
        push(z.zone, `${z.record_count} records`);
    if (e.dropZones)
      for (const z of await deleteZoneRows(client, id, zoneIn, [e.dropZones]))
        push(z.zone, `${z.record_count} records`);
    const countryIn = `rs.region_id IN (SELECT region_id FROM (${COUNTRY_OF_REGION}) c WHERE c.iso3 = ANY($2))`;
    if (e.keepCountries)
      for (const r of await deleteRegionRows(client, id, `NOT ${countryIn}`, [e.keepCountries]))
        push(r.region, `${r.rg ?? 0} iNaturalist records`);
    if (e.dropCountries)
      for (const r of await deleteRegionRows(client, id, countryIn, [e.dropCountries]))
        push(r.region, `${r.rg ?? 0} iNaturalist records`);
    if (e.keepBasins) {
      await ensureBasins();
      const keep = [...e.keepBasins, "polar"];
      for (const z of await deleteZoneRows(
        client,
        id,
        `x.sea_zone_id IN (SELECT sea_zone_id FROM catalog_audit_basins WHERE basin <> ALL($2))`,
        [keep],
      ))
        push(z.zone, `${z.record_count} records`);
      // A region's basins are its nearby sea zones', else its nearest parent's; inland lists stay.
      for (const r of await deleteRegionRows(
        client,
        id,
        `rs.region_id IN (
           WITH RECURSIVE up(rid, cur) AS (
             SELECT id, id FROM regions
             UNION ALL
             SELECT u.rid, r.parent_id FROM up u JOIN regions r ON r.id = u.cur
             WHERE r.parent_id IS NOT NULL AND COALESCE(cardinality(r.nearby_sea_zone_ids), 0) = 0)
           SELECT u.rid FROM up u JOIN regions r ON r.id = u.cur
           JOIN catalog_audit_basins b ON b.sea_zone_id = ANY(r.nearby_sea_zone_ids)
           GROUP BY u.rid HAVING bool_and(b.basin <> ALL($2)))`,
        [keep],
      ))
        push(r.region, `${r.rg ?? 0} iNaturalist records`);
    }
  }

  for (const e of fixes.replacedNames) {
    const sp = await client.query<{ old_id: string; new_id: string }>(
      `SELECT o.id AS old_id, n.id AS new_id FROM species o, species n WHERE o.scientific_name = $1 AND n.scientific_name = $2`,
      [e.scientificName, e.replacedBy],
    );
    const ids = sp.rows[0];
    if (!ids) continue;
    // Only where its successor is listed and the old name has no research-grade records of its own.
    for (const r of await deleteRegionRows(
      client,
      ids.old_id,
      `COALESCE(rs.inat_rg_count, 0) = 0 AND EXISTS (SELECT 1 FROM region_species n WHERE n.region_id = rs.region_id AND n.species_id = $2)`,
      [ids.new_id],
    ))
      out.push({
        pass: "ranges",
        action: "remove",
        speciesId: ids.old_id,
        name: e.scientificName,
        where: r.region,
        detail: `listed as ${e.replacedBy}`,
        reason: e.reason,
      });
  }
}

export async function flagsPass(client: PoolClient, fixes: Fixes, out: Decision[]) {
  for (const f of fixes.flagOverrides) {
    const res = await client.query<{
      region_id: string;
      species_id: string;
      region: string;
      is_vagrant: boolean;
      is_invasive: boolean;
    }>(
      `WITH RECURSIVE sub AS (
         SELECT id FROM regions WHERE external_codes[1] = $2
         UNION SELECT r.id FROM regions r JOIN sub ON r.parent_id = sub.id)
       SELECT rs.region_id, rs.species_id, r.name AS region, rs.is_vagrant, rs.is_invasive
       FROM region_species rs JOIN sub ON sub.id = rs.region_id JOIN regions r ON r.id = rs.region_id
       JOIN species s ON s.id = rs.species_id
       WHERE s.scientific_name = $1
         AND (($3::boolean IS NOT NULL AND rs.is_vagrant <> $3) OR ($4::boolean IS NOT NULL AND rs.is_invasive <> $4)
              OR NOT EXISTS (SELECT 1 FROM region_species_manual_overrides o WHERE o.region_id = rs.region_id AND o.species_id = rs.species_id))
       ORDER BY r.name`,
      [f.scientificName, f.country, f.isVagrant ?? null, f.isInvasive ?? null],
    );
    for (const r of res.rows) {
      const vagrant = f.isVagrant ?? r.is_vagrant;
      const invasive = f.isInvasive ?? r.is_invasive;
      // The override keeps a rebuilt list from flagging it again.
      await client.query(
        `INSERT INTO region_species_manual_overrides (region_id, species_id, is_vagrant, is_invasive, source)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (region_id, species_id) DO UPDATE SET is_vagrant = EXCLUDED.is_vagrant,
           is_invasive = EXCLUDED.is_invasive, source = EXCLUDED.source, verified_at = now()`,
        [r.region_id, r.species_id, vagrant, f.isInvasive ?? null, `catalog-audit-fixes.json: ${f.reason}`],
      );
      await client.query(
        `UPDATE region_species SET is_vagrant = $3, is_invasive = $4 WHERE region_id = $1 AND species_id = $2`,
        [r.region_id, r.species_id, vagrant, invasive],
      );
      out.push({
        pass: "flags",
        action: "override",
        speciesId: r.species_id,
        name: f.scientificName,
        where: r.region,
        detail: `vagrant ${r.is_vagrant} to ${vagrant}, introduced ${r.is_invasive} to ${invasive}`,
        reason: f.reason,
      });
    }
  }
}

export async function additionsPass(client: PoolClient, fixes: Fixes, out: Decision[]) {
  for (const a of fixes.additions) {
    // Country row only: the list names the country, not where in it.
    const res = await client.query<{ species_id: string; region: string; intro: boolean }>(
      `INSERT INTO region_species (region_id, species_id, is_vagrant, is_invasive, evidence_source)
       SELECT r.id, s.id, false,
              EXISTS (SELECT 1 FROM species_nonnative_countries n WHERE n.species_id = s.id AND n.country_iso3 = $2), 'list'
       FROM regions r, species s
       WHERE r.external_codes[1] = $2 AND s.scientific_name = $1 AND NOT s.is_other_taxa
       ON CONFLICT (region_id, species_id) DO NOTHING
       RETURNING species_id, (SELECT name FROM regions WHERE id = region_id) AS region, is_invasive AS intro`,
      [a.scientificName, a.country],
    );
    for (const r of res.rows)
      out.push({
        pass: "additions",
        action: "add",
        speciesId: r.species_id,
        name: a.scientificName,
        where: r.region,
        detail: `${a.source}${r.intro ? ", introduced" : ""}`,
        reason: a.reason,
      });
  }
}

/** A region's eBird list (cached species codes), or null when any part of it isn't cached:
 *  a province by its own code, a group or country as the union of its provinces'. */
export function regionEbirdLists(
  provinces: Array<{ id: string; code: string | null; parents: string[] }>,
  load: (code: string) => string[] | null,
): Map<string, Set<string> | null> {
  const out = new Map<string, Set<string> | null>();
  for (const p of provinces) {
    const codes = p.code ? load(p.code) : null;
    out.set(p.id, codes ? new Set(codes) : null);
    for (const parent of p.parents) {
      if (!out.has(parent)) out.set(parent, new Set());
      const acc = out.get(parent);
      if (!acc) continue;
      if (!codes) out.set(parent, null);
      else for (const c of codes) acc.add(c);
    }
  }
  return out;
}

/** Every cached eBird region list, by region code; empty lists are left out (eBird has no such
 *  region, so they say nothing). Null without the cache. */
export function loadEbirdLists(listDir = EBIRD_SPPLIST_DIR): Map<string, string[]> | null {
  if (!existsSync(listDir)) return null;
  const lists = new Map<string, string[]>();
  for (const f of readdirSync(listDir)) {
    if (!f.endsWith(".json")) continue;
    const codes = JSON.parse(readFileSync(path.join(listDir, f), "utf8")) as string[];
    if (codes.length > 0) lists.set(f.slice(0, -".json".length), codes);
  }
  return lists;
}

/** The thin bird listings to drop: in a region whose eBird list is near complete (it has
 *  EBIRD_MIN_COVERAGE of the region's well-recorded birds, at least minWell of them) and not on
 *  that list. A code on no eBird list anywhere may be stale, so it never counts. */
export function unlistedBirds<T extends { region_id: string; code: string }>(
  thin: T[],
  wellByRegion: Map<string, string[]>,
  lists: Map<string, Set<string> | null>,
  known: Set<string>,
  minWell = EBIRD_MIN_WELL_RECORDED,
): T[] {
  const trusted = new Set<string>();
  for (const [region, codes] of wellByRegion) {
    const list = lists.get(region);
    const well = codes.filter((c) => known.has(c));
    if (list && well.length >= minWell && well.filter((c) => list.has(c)).length >= EBIRD_MIN_COVERAGE * well.length)
      trusted.add(region);
  }
  return thin.filter((r) => trusted.has(r.region_id) && known.has(r.code) && !lists.get(r.region_id)!.has(r.code));
}

export async function unlistedBirdsPass(
  client: PoolClient,
  out: Decision[],
  ebird: Map<string, string[]>,
  keep: Set<string>,
  minWell = EBIRD_MIN_WELL_RECORDED,
) {
  const provinces = await client.query<{ id: string; code: string | null; parents: string[] }>(
    `SELECT p.id, r.ebird_region_code AS code, array_remove(ARRAY[p.country_id, g.id], NULL) AS parents
     FROM (${PROVINCES_WITH_COUNTRY_SQL}) p JOIN regions r ON r.id = p.id
     LEFT JOIN regions g ON g.id = r.parent_id AND g.parent_id = p.country_id`,
  );
  const lists = regionEbirdLists(provinces.rows, (code) => ebird.get(code) ?? null);
  const known = new Set([...ebird.values()].flat());
  const records = `greatest(COALESCE(rs.local_frequency, 0), COALESCE(rs.inat_rg_count, 0))`;
  const birds = `FROM region_species rs JOIN species s ON s.id = rs.species_id
     WHERE s.taxon_class = 'aves' AND s.ebird_code IS NOT NULL AND NOT s.is_other_taxa`;
  const well = await client.query<{ region_id: string; codes: string[] }>(
    `SELECT rs.region_id, array_agg(s.ebird_code) AS codes ${birds} AND ${records} > $1 GROUP BY 1`,
    [UNLISTED_BIRD_MAX_RECORDS],
  );
  const thin = await client.query<{
    region_id: string;
    species_id: string;
    name: string;
    code: string;
    region: string;
    n: number;
  }>(
    `SELECT rs.region_id, rs.species_id, s.scientific_name AS name, s.ebird_code AS code,
            r.name || COALESCE(' (' || r.ebird_region_code || ')', '') AS region, ${records}::int AS n
     ${birds.replace("WHERE", "JOIN regions r ON r.id = rs.region_id WHERE")} AND ${records} <= $1
       AND NOT EXISTS (SELECT 1 FROM region_species_manual_overrides o WHERE o.region_id = rs.region_id AND o.species_id = rs.species_id)`,
    [UNLISTED_BIRD_MAX_RECORDS],
  );
  const gone = unlistedBirds(
    thin.rows.filter((r) => !keep.has(`${r.region_id}|${r.species_id}`)),
    new Map(well.rows.map((r) => [r.region_id, r.codes])),
    lists,
    known,
    minWell,
  );
  await client.query(
    `DELETE FROM region_species rs USING unnest($1::uuid[], $2::uuid[]) AS v(region_id, species_id)
     WHERE rs.region_id = v.region_id AND rs.species_id = v.species_id`,
    [gone.map((r) => r.region_id), gone.map((r) => r.species_id)],
  );
  for (const r of gone)
    out.push({
      pass: "unlisted-birds",
      action: "remove",
      speciesId: r.species_id,
      name: r.name,
      where: r.region,
      detail: `${r.n} records, ${r.code} not on eBird's list`,
      reason: "a handful of records and never reported to eBird here: an escape or a misidentification",
    });
}

export async function residentMammalsPass(client: PoolClient, out: Decision[]) {
  await requirePostgis(client, "fix-catalog-audit resident-mammals");
  // By distance, not country: a bat resident in Florida says nothing about Arizona.
  await client.query(
    `DROP TABLE IF EXISTS audit_rm_cand, audit_rm_res, audit_rm_geo;
     CREATE TEMP TABLE audit_rm_cand ON COMMIT DROP AS
       SELECT rs.region_id, rs.species_id FROM region_species rs JOIN species s ON s.id = rs.species_id
       WHERE rs.is_vagrant AND NOT rs.is_invasive AND s.taxon_order = ANY('{${RESIDENT_ORDERS.join(",")}}') AND NOT s.is_other_taxa
         AND NOT EXISTS (SELECT 1 FROM region_species_manual_overrides o WHERE o.region_id = rs.region_id AND o.species_id = rs.species_id);
     CREATE TEMP TABLE audit_rm_res ON COMMIT DROP AS
       SELECT x.region_id, x.species_id FROM region_species x
       WHERE NOT x.is_vagrant AND x.species_id IN (SELECT species_id FROM audit_rm_cand);
     CREATE TEMP TABLE audit_rm_geo ON COMMIT DROP AS
       SELECT r.id, ST_Simplify(ST_Force2D(ST_GeomFromGeoJSON((r.boundary_geojson->'geometry')::text)), 0.05, true)::geography AS g
       FROM regions r WHERE r.boundary_geojson ? 'geometry'
         AND r.id IN (SELECT region_id FROM audit_rm_cand UNION SELECT region_id FROM audit_rm_res);`,
  );
  // Repeated until nothing changes: a chain of listings each within reach of the next is one
  // population, as in remove-escapes.ts, and a rerun then finds nothing.
  const rows: Array<{ region_id: string; species_id: string; name: string; region: string }> = [];
  for (;;) {
    const res = await client.query<{ region_id: string; species_id: string; name: string; region: string }>(
      `WITH fix AS (
       SELECT c.region_id, c.species_id FROM audit_rm_cand c JOIN audit_rm_geo a ON a.id = c.region_id
       WHERE EXISTS (SELECT 1 FROM audit_rm_res x JOIN audit_rm_geo b ON b.id = x.region_id
                     WHERE x.species_id = c.species_id AND x.region_id <> c.region_id AND ST_DWithin(a.g, b.g, $1)))
     UPDATE region_species rs SET is_vagrant = false FROM fix
     WHERE rs.region_id = fix.region_id AND rs.species_id = fix.species_id AND rs.is_vagrant
     RETURNING rs.region_id, rs.species_id, (SELECT scientific_name FROM species WHERE id = rs.species_id) AS name,
               (SELECT name FROM regions WHERE id = rs.region_id) AS region`,
      [NEIGHBOUR_KM * 1000],
    );
    if (res.rows.length === 0) break;
    rows.push(...res.rows);
    await client.query(
      `INSERT INTO audit_rm_res SELECT region_id, species_id FROM unnest($1::uuid[], $2::uuid[]) AS v(region_id, species_id)`,
      [res.rows.map((r) => r.region_id), res.rows.map((r) => r.species_id)],
    );
  }
  for (const r of rows)
    out.push({
      pass: "resident-mammals",
      action: "not-vagrant",
      speciesId: r.species_id,
      name: r.name,
      where: r.region,
      detail: `resident within ${NEIGHBOUR_KM} km`,
      reason: "bats and rodents are under-recorded, not wanderers: few records here is no sign of vagrancy",
    });
}

/** Name to id of every active animal species iNaturalist has exactly one taxon for; names with
 *  several are left out. */
export function pickInatIds(
  taxa: Iterable<{ id: number; ancestry: string; rank: string; name: string; active: boolean }>,
): Map<string, number> {
  const found = new Map<string, number | null>();
  for (const t of taxa) {
    if (t.rank !== "species" || !t.active || !t.ancestry.startsWith("48460/1/")) continue;
    found.set(t.name, found.has(t.name) ? null : t.id);
  }
  return new Map([...found].filter((e): e is [string, number] => e[1] !== null));
}

/** pickInatIds over the local iNaturalist taxa dump; null without the dump. */
export async function loadInatSpeciesIds(dump = INAT_TAXA_DUMP): Promise<Map<string, number> | null> {
  if (!existsSync(dump)) return null;
  const taxa = [];
  let header = true;
  for await (const line of readline.createInterface({ input: createReadStream(dump).pipe(createGunzip()) })) {
    if (header) {
      header = false;
      continue;
    }
    const [id, ancestry, , rank, name, active] = line.split("\t");
    if (rank === "species") taxa.push({ id: Number(id), ancestry, rank, name, active: active === "true" });
  }
  return pickInatIds(taxa);
}

export async function inatIdsPass(client: PoolClient, out: Decision[], inatIds: Map<string, number>) {
  // Species the shared-taxon review unlinked on purpose stay unlinked.
  const unlinked = new Set(
    readFileSync(SHARED_INAT_TSV, "utf8")
      .split("\n")
      .map((l) => l.split("\t"))
      .filter((f) => f[4] === "unlink" || f[4] === "merge")
      .map((f) => f[2]),
  );
  const res = await client.query<{ id: string; scientific_name: string }>(
    `SELECT id, scientific_name FROM species s WHERE inat_taxon_id IS NULL AND NOT is_other_taxa
       AND NOT EXISTS (SELECT 1 FROM species d WHERE d.scientific_name = s.scientific_name AND d.id <> s.id AND NOT d.is_other_taxa)`,
  );
  // Same rule as the pipeline's name fallback: never an id another species holds.
  const held = await client.query<{ id: number }>(
    `SELECT DISTINCT inat_taxon_id AS id FROM species WHERE inat_taxon_id IS NOT NULL AND NOT is_other_taxa`,
  );
  const taken = new Set(held.rows.map((r) => r.id));
  const picked = res.rows.filter(
    (r) => !unlinked.has(r.id) && inatIds.has(r.scientific_name) && !taken.has(inatIds.get(r.scientific_name)!),
  );
  const linked = await client.query<{ id: string; scientific_name: string; inat_taxon_id: number }>(
    `UPDATE species s SET inat_taxon_id = v.tid FROM unnest($1::uuid[], $2::int[]) AS v(id, tid)
     WHERE s.id = v.id AND s.inat_taxon_id IS NULL
     RETURNING s.id, s.scientific_name, s.inat_taxon_id`,
    [picked.map((r) => r.id), picked.map((r) => inatIds.get(r.scientific_name))],
  );
  for (const r of linked.rows)
    out.push({
      pass: "inat-ids",
      action: "link",
      speciesId: r.id,
      name: r.scientific_name,
      where: "",
      detail: `iNaturalist ${r.inat_taxon_id}`,
      reason: "the one active iNaturalist species of that exact name, held by no other species",
    });
}

export async function classesPass(client: PoolClient, out: Decision[]) {
  const res = await client.query<{ order: string; cls: string; n: number }>(
    `SELECT taxon_order AS "order", taxon_class AS cls, count(*)::int AS n FROM species
     WHERE taxon_order IS NOT NULL AND taxon_class IS NOT NULL AND NOT is_other_taxa GROUP BY 1, 2`,
  );
  for (const [order, cls] of majorityClassByOrder(res.rows)) {
    const fixed = await client.query<{ id: string; scientific_name: string; old: string }>(
      `UPDATE species s SET taxon_class = $2 FROM species o
       WHERE s.id = o.id AND s.taxon_order = $1 AND s.taxon_class <> $2 AND NOT s.is_other_taxa
       RETURNING s.id, s.scientific_name, o.taxon_class AS old`,
      [order, cls],
    );
    for (const r of fixed.rows)
      out.push({
        pass: "classes",
        action: "class",
        speciesId: r.id,
        name: r.scientific_name,
        where: "",
        detail: `${r.old} to ${cls}`,
        reason: `the rest of ${order} is ${cls}`,
      });
  }
}

export interface ZoneBasins {
  zones: Array<{ id: string; name: string }>;
  basins: Array<Basin | undefined>;
  neighbours: Map<number, Set<number>>;
  bridges: Set<string>;
}

/** Each zone's basin and neighbours from the cached zone outlines, as the sea zone builder reads
 *  them; also kept in a temp table for the SQL that needs them. */
export async function loadZoneBasins(client: PoolClient, fixes: Fixes): Promise<ZoneBasins> {
  const res = await client.query<{ id: string; name: string; minLat: number; maxLat: number }>(
    `SELECT id, name, bbox_min_lat AS "minLat", bbox_max_lat AS "maxLat" FROM sea_zones ORDER BY name`,
  );
  const geometries = new Map<string, { type: string; coordinates: unknown } | null>();
  for (const f of await loadIhoFeatures()) if (f.properties.name) geometries.set(f.properties.name.trim(), f.geometry);
  for (const f of await loadEezIhoFeatures())
    if (f.properties.marregion) geometries.set(f.properties.marregion.trim(), f.geometry);
  const missing = res.rows.filter((z) => !geometries.has(z.name));
  if (missing.length > 0)
    console.warn(`[fix-catalog-audit] no outline for ${missing.map((z) => z.name).join(", ")}: no neighbours`);
  const rings = res.rows.map((z) => exteriorRingsOf(geometries.get(z.name) ?? null));
  const neighbours = zoneNeighbours(rings);
  const basins = assignBasins(res.rows, neighbours);
  const at = new Map(res.rows.map((z, i) => [z.name, i]));
  const links = new Set(
    fixes.seaLinks.flatMap(({ zones: [a, b] }) => (at.has(a) && at.has(b) ? [`${at.get(a)}|${at.get(b)}`] : [])),
  );
  const bridges = landBridges(rings, basins, neighbours, links);
  for (const key of bridges) {
    const [i, j] = key.split("|").map(Number);
    if (i < j) console.log(`[fix-catalog-audit] land bridge: ${res.rows[i].name} / ${res.rows[j].name}`);
  }
  await client.query(
    `CREATE TEMP TABLE IF NOT EXISTS catalog_audit_basins (sea_zone_id uuid PRIMARY KEY, basin text) ON COMMIT DROP`,
  );
  await client.query(`TRUNCATE catalog_audit_basins`);
  await client.query(`INSERT INTO catalog_audit_basins SELECT unnest($1::uuid[]), unnest($2::text[])`, [
    res.rows.map((z) => z.id),
    basins.map((b) => b ?? null),
  ]);
  return { zones: res.rows, basins, neighbours, bridges };
}

async function seaBasinsPass(client: PoolClient, fixes: Fixes, zb: ZoneBasins, out: Decision[]) {
  const zoneIndex = new Map(zb.zones.map((z, i) => [z.id, i]));
  const rowsRes = await client.query<{ sea_zone_id: string; species_id: string; record_count: number }>(
    `SELECT sea_zone_id, species_id, record_count FROM sea_zone_species`,
  );
  const rows = rowsRes.rows.map((r) => ({
    zone: zoneIndex.get(r.sea_zone_id)!,
    speciesId: r.species_id,
    recordCount: r.record_count,
  }));
  const traits = await client.query<{
    species_id: string;
    occurrence_count: string | null;
    marine: boolean;
    deep: boolean;
  }>(
    `SELECT species_id, occurrence_count, COALESCE(worms_is_marine, false) OR COALESCE(worms_is_brackish, false) AS marine,
            COALESCE(depth_min_m >= $1, false) AS deep
     FROM species_traits`,
    [DEEP_SEA_MIN_DEPTH_M],
  );
  const allow = await client.query<{ id: string }>(`SELECT id FROM species WHERE scientific_name = ANY($1)`, [
    fixes.basinAllow.map((a) => a.scientificName),
  ]);
  const decisions = decideBasinStrays(rows, {
    basins: zb.basins,
    neighbours: zb.neighbours,
    bridges: zb.bridges,
    zoneNames: zb.zones.map((z) => z.name),
    globalCount: new Map(
      traits.rows.filter((t) => t.occurrence_count != null).map((t) => [t.species_id, Number(t.occurrence_count)]),
    ),
    marineOrBrackish: new Set(traits.rows.filter((t) => t.marine).map((t) => t.species_id)),
    allow: new Set(allow.rows.map((a) => a.id)),
    deep: new Set(traits.rows.filter((t) => t.deep).map((t) => t.species_id)),
  });
  const removed = decisions.filter((d) => d.rule !== "deep-sea-review");

  const names = await client.query<{ id: string; scientific_name: string }>(
    `SELECT id, scientific_name FROM species WHERE id = ANY($1)`,
    [[...new Set(decisions.map((d) => d.speciesId))]],
  );
  const nameOf = new Map(names.rows.map((n) => [n.id, n.scientific_name]));
  await client.query(
    `DELETE FROM sea_zone_species x USING unnest($1::uuid[], $2::uuid[]) AS d(zone_id, species_id)
     WHERE x.sea_zone_id = d.zone_id AND x.species_id = d.species_id`,
    [removed.map((d) => zb.zones[d.zone].id), removed.map((d) => d.speciesId)],
  );
  for (const d of decisions)
    out.push({
      pass: "sea-basins",
      action: d.rule,
      speciesId: d.speciesId,
      name: nameOf.get(d.speciesId) ?? d.speciesId,
      where: zb.zones[d.zone].name,
      detail: `${d.recordCount} records here`,
      reason: d.reason,
    });

  const perZone = new Map<number, { before: number; edge: number; stray: number; review: number }>();
  for (const r of rows) {
    const z = perZone.get(r.zone) ?? { before: 0, edge: 0, stray: 0, review: 0 };
    z.before++;
    perZone.set(r.zone, z);
  }
  const column = { "basin-stray": "stray", "edge-across-basin": "edge", "deep-sea-review": "review" } as const;
  for (const d of decisions) perZone.get(d.zone)![column[d.rule]]++;
  writeFileSync(
    ZONE_COUNTS_TSV,
    [
      "zone\tbasin\tspecies_before\tremoved_edge_across_basin\tremoved_basin_stray\tspecies_after\tdeep_sea_for_review",
      ...[...perZone]
        .sort((a, b) => b[1].edge + b[1].stray - (a[1].edge + a[1].stray))
        .map(([zi, z]) =>
          [
            zb.zones[zi].name,
            zb.basins[zi] ?? "",
            z.before,
            z.edge,
            z.stray,
            z.before - z.edge - z.stray,
            z.review,
          ].join("\t"),
        ),
    ].join("\n") + "\n",
  );
}

async function sharedNamesReport(client: PoolClient, touched: Set<string>) {
  const res = await client.query<{ region: string; common_name: string; names: string[]; ids: string[] }>(
    `WITH c AS (SELECT id, name, nearby_sea_zone_ids FROM regions WHERE external_codes[1] ~ '^[A-Z]{3}$'),
     v AS (
       SELECT c.name, rs.species_id FROM c JOIN region_species rs ON rs.region_id = c.id
       UNION
       SELECT c.name, x.species_id FROM c JOIN sea_zone_species x ON x.sea_zone_id = ANY(c.nearby_sea_zone_ids))
     SELECT v.name AS region, min(s.common_name) AS common_name,
            array_agg(s.scientific_name ORDER BY s.scientific_name) AS names, array_agg(s.id) AS ids
     FROM v JOIN species s ON s.id = v.species_id
     WHERE s.common_name <> '' AND NOT s.is_other_taxa
     GROUP BY v.name, lower(s.common_name) HAVING count(*) > 1
     ORDER BY 1, 2`,
  );
  writeFileSync(
    SHARED_NAMES_TSV,
    [
      "country_view\tcommon_name\tspecies\ttouched_by_audit_fix",
      ...res.rows.map((r) =>
        [r.region, tsvCell(r.common_name), r.names.join(", "), r.ids.some((id) => touched.has(id)) ? "yes" : ""].join(
          "\t",
        ),
      ),
    ].join("\n") + "\n",
  );
  const names = new Set(res.rows.map((r) => r.common_name.toLowerCase()));
  console.log(
    `[fix-catalog-audit] shared-names: ${res.rows.length} shared names in country views (${names.size} distinct), in ${path.relative(DATA_DIR, SHARED_NAMES_TSV)}`,
  );
}

export function parsePasses(argv: string[]): Pass[] {
  const raw = argv.find((a) => a.startsWith("--passes="))?.slice("--passes=".length);
  if (!raw) return [...PASSES];
  const wanted = raw.split(",").map((s) => s.trim());
  const unknown = wanted.filter((p) => !(PASSES as readonly string[]).includes(p));
  if (unknown.length > 0) throw new Error(`Unknown pass ${unknown.join(", ")}; passes are ${PASSES.join(", ")}`);
  return PASSES.filter((p) => wanted.includes(p));
}

async function main() {
  const apply = process.argv.includes("--apply");
  const passes = parsePasses(process.argv.slice(2));
  const fixes = parseFixes(JSON.parse(readFileSync(FIXES_FILE, "utf8")));
  const db = new URL(process.env.DATABASE_URL ?? "postgres://localhost/").pathname.slice(1);
  console.log(`[fix-catalog-audit] database ${db}, passes ${passes.join(", ")}${apply ? "" : " (dry run)"}`);
  mkdirSync(path.dirname(REVIEW_TSV), { recursive: true });

  // Files are read before the transaction, so it stays short.
  const ebird = passes.includes("unlisted-birds") ? loadEbirdLists() : null;
  const inatIds = passes.includes("inat-ids") ? await loadInatSpeciesIds() : null;
  const ebirdTaxonomy = passes.includes("bird-names") || passes.includes("extinct") ? loadEbird() : [];
  // Listings known feral or reintroduced populations keep, "region_id|species_id".
  const keepListed = new Set(
    ebird
      ? [
          ...(await referenceListings(pool, "known-feral-populations.json")),
          ...(await referenceListings(pool, "reintroduced-natives.json")),
        ]
      : [],
  );
  const out: Decision[] = [];
  const client = await pool.connect();
  const started = Date.now();
  try {
    await client.query("BEGIN");
    await lockReferenceData(client);
    let zb: ZoneBasins | undefined;
    const ensureBasins = async () => {
      zb ??= await loadZoneBasins(client, fixes);
    };
    for (const pass of passes) {
      const n = out.length;
      if (pass === "names") await namesPass(client, fixes, out);
      if (pass === "bird-names") await birdNamesPass(client, out, ebirdTaxonomy);
      if (pass === "extinct") {
        const species = ebirdTaxonomy.filter((r) => r.category === "species");
        await extinctPass(client, out, {
          ebirdByName: new Map(species.map((r) => [r.sci, r])),
          ebirdByCode: new Map(species.map((r) => [r.code, r])),
          ...cachedGbifEvidence(),
        });
      }
      if (pass === "ranges") await rangesPass(client, fixes, out, ensureBasins);
      if (pass === "additions") await additionsPass(client, fixes, out);
      if (pass === "unlisted-birds") {
        // iNaturalist decides membership: eBird's absence never removes a bird it confirms there.
        if (ebird)
          await unlistedBirdsPass(
            client,
            out,
            ebird,
            new Set([...keepListed, ...(await inatConfirmedListings(client))]),
          );
        else console.warn(`[fix-catalog-audit] unlisted-birds: no eBird list cache, skipped`);
      }
      if (pass === "flags") await flagsPass(client, fixes, out);
      if (pass === "resident-mammals") await residentMammalsPass(client, out);
      if (pass === "inat-ids") {
        if (inatIds) await inatIdsPass(client, out, inatIds);
        else console.warn(`[fix-catalog-audit] inat-ids: no iNaturalist taxa dump, skipped`);
      }
      if (pass === "classes") await classesPass(client, out);
      if (pass === "sea-basins") {
        await ensureBasins();
        await seaBasinsPass(client, fixes, zb!, out);
      }
      if (pass === "shared-names") await sharedNamesReport(client, new Set(out.map((d) => d.speciesId)));
      else
        console.log(
          `[fix-catalog-audit] ${pass}: ${out.length - n} decisions (${Math.round((Date.now() - started) / 1000)}s)`,
        );
    }
    await client.query(apply ? "COMMIT" : "ROLLBACK");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // An applied run keeps its own record, so it never replaces the list that was reviewed.
  const tsv = apply
    ? REVIEW_TSV.replace(/\.tsv$/, `-applied-${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.tsv`)
    : REVIEW_TSV;
  writeFileSync(
    tsv,
    [
      "pass\taction\tspecies_id\tscientific_name\twhere\tdetail\treason",
      ...out.map((d) => [d.pass, d.action, d.speciesId, d.name, d.where, d.detail, d.reason].map(tsvCell).join("\t")),
    ].join("\n") + "\n",
  );
  console.log(
    `[fix-catalog-audit] ${out.length} decisions in ${path.relative(DATA_DIR, tsv)}; ${apply ? "applied" : "dry run, nothing changed (pass --apply to keep it)"}`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main()
    .then(() => pool.end())
    .catch(async (err) => {
      console.error(err);
      await pool.end().catch(() => {});
      process.exit(1);
    });
}
