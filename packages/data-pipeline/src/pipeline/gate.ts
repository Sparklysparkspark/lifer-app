// The publish gate (refresh.ts stage "gate"): checks the catalog and the pack index before anything
// is published, and refuses on any failure. The build scripts report success whether or not the
// data is right, so this is where bad data gets caught.
//
// Failures (publishing stops):
// - a known species missing from a region it must be on (data/reference/checklist-anchors.json),
//   or tiered differently from what the anchor says;
// - a rare or legendary row with no records behind it;
// - catalog species still missing that the catalog stage should have added (vertebrates, or
//   anything with 100+ iNaturalist observations);
// - a country with species in a taxon but no pack for it;
// - a pack depending on a sea zone pack that isn't in the index;
// - a user's own Other Taxa species inside any pack;
// - a pack whose species count moved more than 25% from the published one, unless accepted
//   (--accept-drift=<pack id>,... or --accept-all-drift after reviewing the list).
// Warnings (reported, publishing continues): species on lists with no photo yet.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../db.js";
import { findMissingSpecies } from "../scripts/add-missing-species.js";
import { checkIndex, fetchPublishedIndex, PACK_TAXA, type PackIndex } from "./packs.js";
import { packIdFromFileName, regionPackFileName } from "../build/pack-id.js";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const ANCHORS_PATH = path.join(DATA_DIR, "reference", "checklist-anchors.json");
export const DRIFT_LIMIT = 0.25;

export interface GateReport {
  at: string;
  ok: boolean;
  failures: Array<{ check: string; detail: string }>;
  warnings: Array<{ check: string; detail: string }>;
  drift: Array<{ pack: string; published: number; now: number }>;
}

async function checkAnchors(report: GateReport) {
  const anchors = JSON.parse(readFileSync(ANCHORS_PATH, "utf8")) as Array<{ region: string; name: string; tier?: string }>;
  for (const a of anchors) {
    // By catalog name or synonym, on the region's own list or any of its provinces'.
    const res = await pool.query<{ on_list: boolean; tier: string | null }>(
      `WITH target AS (
         SELECT s.id FROM species s WHERE s.scientific_name = $2
         UNION SELECT ss.species_id FROM species_synonyms ss WHERE ss.synonym_name = $2
       ), region AS (
         SELECT id FROM regions WHERE name = $1 AND external_codes <> '{}' ORDER BY (parent_id IS NULL), id LIMIT 1
       )
       SELECT EXISTS (
                SELECT 1 FROM region_species rs WHERE rs.species_id IN (SELECT id FROM target)
                  AND rs.region_id IN (SELECT id FROM region UNION SELECT r.id FROM regions r WHERE r.parent_id IN (SELECT id FROM region))
              ) AS on_list,
              (SELECT rs.local_tier FROM region_species rs WHERE rs.species_id IN (SELECT id FROM target) AND rs.region_id IN (SELECT id FROM region) LIMIT 1) AS tier`,
      [a.region, a.name],
    );
    const row = res.rows[0];
    if (!row.on_list) report.failures.push({ check: "anchor_missing", detail: `${a.name} is not on ${a.region}'s list` });
    // "rare/legendary" accepts either.
    else if (a.tier && !a.tier.split("/").includes(row.tier ?? "")) report.failures.push({ check: "anchor_tier", detail: `${a.name} in ${a.region} is ${row.tier ?? "unrated"}, expected ${a.tier}` });
  }
}

async function checkFakeRare(report: GateReport) {
  const res = await pool.query<{ n: string; sample: string[] }>(
    `SELECT count(*) AS n, (array_agg(r.name || ': ' || s.scientific_name))[1:5] AS sample
     FROM region_species rs JOIN species s ON s.id = rs.species_id JOIN regions r ON r.id = rs.region_id
     WHERE rs.local_tier IN ('rare', 'legendary') AND COALESCE(rs.live_recent_records, 0) = 0 AND COALESCE(rs.inat_rg_count, 0) = 0
       AND COALESCE(rs.local_frequency, 0) = 0
       AND COALESCE(rs.tier_reason, 'rated') NOT IN ('vagrant', 'inherited')`,
  );
  const n = Number(res.rows[0].n);
  if (n > 0) report.failures.push({ check: "rare_without_records", detail: `${n} rare/legendary rows have no records of any age and no photos behind them (e.g. ${res.rows[0].sample.join("; ")})` });
}

async function checkCatalogGaps(report: GateReport) {
  const { add } = await findMissingSpecies({ offline: true });
  const serious = add.filter((a) => ["aves", "mammalia", "actinopterygii", "squamata", "testudines", "amphibia"].includes(a.taxonClass) || a.inatObservations >= 100);
  if (serious.length > 0) {
    report.failures.push({
      check: "catalog_gaps",
      detail: `${serious.length} species on iNaturalist or eBird lists are missing from the catalog (e.g. ${serious.slice(0, 5).map((a) => a.scientificName).join(", ")}); run the catalog stage`,
    });
  }
}

async function checkCoverage(report: GateReport, index: PackIndex) {
  const ids = new Set(index.packs.map((p) => p.id));
  const res = await pool.query<{ name: string; taxa: string[] }>(
    `SELECT c.name, array_agg(DISTINCT s.taxon_class) AS taxa
     FROM regions c JOIN regions cont ON cont.id = c.parent_id JOIN regions w ON w.id = cont.parent_id AND w.parent_id IS NULL
     JOIN regions r ON r.id = c.id OR r.parent_id = c.id
     JOIN region_species rs ON rs.region_id = r.id JOIN species s ON s.id = rs.species_id
     WHERE NOT s.is_other_taxa GROUP BY c.name`,
  );
  const packId = (country: string, taxon: string) => packIdFromFileName(regionPackFileName(country, taxon, "full"));
  for (const row of res.rows) {
    for (const taxon of row.taxa) {
      if (!PACK_TAXA.includes(taxon as never)) continue;
      const id = packId(row.name, taxon);
      // One pack each: "small" is the same pack installed without gallery photos.
      if (!ids.has(id)) report.failures.push({ check: "pack_missing", detail: `${row.name} has ${taxon} species but no ${id} pack` });
    }
  }
  for (const problem of checkIndex(index)) report.failures.push({ check: "index", detail: problem });
}

async function checkOtherTaxa(report: GateReport, index: PackIndex) {
  const names = new Set(index.packs.flatMap((p) => p.scientificNames));
  const res = await pool.query<{ scientific_name: string }>(`SELECT scientific_name FROM species WHERE is_other_taxa AND scientific_name = ANY($1)`, [[...names]]);
  // An Other Taxa species can share a name with a catalog one; only a name with no catalog
  // species is certainly a personal addition leaking into a pack.
  const catalogToo = await pool.query<{ scientific_name: string }>(
    `SELECT scientific_name FROM species WHERE NOT is_other_taxa AND scientific_name = ANY($1)`,
    [res.rows.map((r) => r.scientific_name)],
  );
  const shared = new Set(catalogToo.rows.map((r) => r.scientific_name));
  const leaked = res.rows.map((r) => r.scientific_name).filter((n) => !shared.has(n));
  if (leaked.length > 0) report.failures.push({ check: "other_taxa_in_pack", detail: `${leaked.length} Other Taxa species are in packs (e.g. ${leaked.slice(0, 5).join(", ")})` });
}

async function checkDrift(report: GateReport, index: PackIndex, accepted: Set<string> | "all") {
  const published = await fetchPublishedIndex();
  const before = new Map(published.packs.map((p) => [p.id, p.speciesCount]));
  for (const p of index.packs) {
    const was = before.get(p.id);
    if (was == null || was === 0) continue;
    const change = Math.abs(p.speciesCount - was) / was;
    if (change <= DRIFT_LIMIT) continue;
    report.drift.push({ pack: p.id, published: was, now: p.speciesCount });
    if (accepted !== "all" && !accepted.has(p.id)) {
      report.failures.push({ check: "drift", detail: `${p.id}: ${was} species published, ${p.speciesCount} now (${Math.round(change * 100)}%)` });
    }
  }
}

async function checkPhotos(report: GateReport) {
  const res = await pool.query<{ n: string }>(
    `SELECT count(DISTINCT s.id) AS n FROM region_species rs JOIN species s ON s.id = rs.species_id
     WHERE NOT s.is_other_taxa AND s.reference_photo IS NULL`,
  );
  const n = Number(res.rows[0].n);
  if (n > 0) report.warnings.push({ check: "no_photo", detail: `${n} listed species have no reference photo yet` });
}

export async function runGate(opts: { index: PackIndex | null; acceptDrift?: string[] | "all"; out?: string }): Promise<GateReport> {
  const report: GateReport = { at: new Date().toISOString(), ok: false, failures: [], warnings: [], drift: [] };
  await checkAnchors(report);
  await checkFakeRare(report);
  await checkCatalogGaps(report);
  await checkPhotos(report);
  if (opts.index) {
    await checkCoverage(report, opts.index);
    await checkOtherTaxa(report, opts.index);
    await checkDrift(report, opts.index, opts.acceptDrift === "all" ? "all" : new Set(opts.acceptDrift ?? []));
  }
  report.ok = report.failures.length === 0;
  const out = opts.out ?? path.join(DATA_DIR, "build", `gate-${report.at.slice(0, 10)}.json`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2));
  return report;
}

export function summarizeGate(report: GateReport): string {
  const lines = [`Gate ${report.ok ? "passed" : "FAILED"}: ${report.failures.length} failure(s), ${report.warnings.length} warning(s), ${report.drift.length} pack(s) with a big species-count change.`];
  const byCheck = new Map<string, string[]>();
  for (const f of report.failures) byCheck.set(f.check, [...(byCheck.get(f.check) ?? []), f.detail]);
  for (const [check, details] of byCheck) {
    lines.push(`  ${check} (${details.length}):`);
    for (const d of details.slice(0, 8)) lines.push(`    ${d}`);
    if (details.length > 8) lines.push(`    ...and ${details.length - 8} more`);
  }
  for (const w of report.warnings) lines.push(`  warning ${w.check}: ${w.detail}`);
  return lines.join("\n");
}
