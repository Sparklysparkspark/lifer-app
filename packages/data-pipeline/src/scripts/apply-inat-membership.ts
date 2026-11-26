// Makes iNaturalist the source of truth for which species are on a region's list and which are
// vagrants there (rules and thresholds in ../regions/inatVagrancy.ts); GBIF stays as the
// occurrence statistics (local_frequency, weekly_frequency) of the species listed.
//
// Per province, then per country (its calls planned first, for the provinces), from the region's own iNaturalist place:
//   - a catalog species with research-grade observations there is listed (added if missing);
//   - a listed species iNaturalist has none of, where it covers the species' group, is flagged
//     vagrant rather than removed (GBIF and eBird know real strays iNaturalist lacks; the flag
//     hides it by default), unless a hand-checked override lists it, it's introduced or a farm
//     animal, or its iNaturalist taxon is unknown (no id, no cached answer): unknown is not absent;
//   - the vagrant flag follows inatVagrancy/decideIsVagrant; a province iNaturalist can't judge
//     takes its country's vagrant call.
// Vernacular groups are rebuilt from their provinces afterwards, as build-country-checklists.ts
// does. Regions without an iNaturalist place or cached counts (refresh-inat-counts.ts) are left
// alone. The yearly counts the vagrant rule needs are fetched once per place and cached in
// data/inat-year-counts-cache, so an interrupted run picks up where it stopped.
// With --apply, the escape, eBird exotics and introduced passes run again afterwards, since an
// iNaturalist observation can re-add an escaped pet (--no-followups skips them, for refresh.ts).
// Rerun the tiers stage after applying. Every change is listed in data/review/inat-membership-changes.tsv.
//
// Usage (from packages/data-pipeline):
//   npm run apply-inat-membership                                (fetch what's missing, preview)
//   npm run apply-inat-membership -- --countries=Canada,Belize   (some countries only)
//   npm run apply-inat-membership -- --apply
//   LIFER_INAT_OFFLINE=1 npm run apply-inat-membership           (cached iNaturalist data only)
import { execFileSync } from "node:child_process";
import { domesticSpeciesIn } from "../regions/domesticHere.js";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Pool, PoolClient } from "pg";
import { pool } from "@lifer/core/db.js";
import { COUNTRIES_SQL, provinceIdsSql } from "@lifer/core/regions/regionTree.js";
import {
  cachedPlaceCounts,
  cachedPlaceYearCounts,
  loadInatCurrentTaxonDiskCache,
  refreshPlaceYearCounts,
} from "../regions/inatChecklist.js";
import {
  VAGRANT_CANDIDATE_MAX_OBS,
  WELL_OBSERVED_GROUP_OBS,
  decideIsVagrant,
  iconicOfClass,
  inatVagrancy,
  vagrantWindowYears,
  yearsDecide,
  type InatVagrancy,
} from "../regions/inatVagrancy.js";
import { buildGroupChecklists } from "./build-country-checklists.js";

const PIPELINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REVIEW_TSV = path.join(PIPELINE_DIR, "data", "review", "inat-membership-changes.tsv");

/** How catalog species map to iNaturalist taxa, loaded once. */
export interface CatalogIndex {
  byTaxon: Map<number, Set<string>>;
  /** Scientific names of species with no iNaturalist id, and every synonym. */
  byName: Map<string, Set<string>>;
  /** Species whose iNaturalist taxon is known, so missing from a place means absent there. */
  known: Set<string>;
  taxonClass: Map<string, string | null>;
  label: Map<string, string>;
}

export async function loadCatalogIndex(db: Pool | PoolClient = pool): Promise<CatalogIndex> {
  const current = loadInatCurrentTaxonDiskCache();
  const index: CatalogIndex = {
    byTaxon: new Map(),
    byName: new Map(),
    known: new Set(),
    taxonClass: new Map(),
    label: new Map(),
  };
  const add = <K>(map: Map<K, Set<string>>, key: K, id: string) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key)!.add(id);
  };
  const species = await db.query<{
    id: string;
    scientific_name: string;
    common_name: string | null;
    inat_taxon_id: number | null;
    taxon_class: string | null;
  }>(
    `SELECT s.id, s.scientific_name, s.common_name, s.inat_taxon_id, s.taxon_class
     FROM species s WHERE NOT s.is_other_taxa`,
  );
  for (const s of species.rows) {
    index.label.set(s.id, s.common_name ? `${s.common_name} (${s.scientific_name})` : s.scientific_name);
    index.taxonClass.set(s.id, s.taxon_class);
    // iNaturalist's current taxon for the name catches a stored id left behind by a taxon change.
    const currentId = current[s.scientific_name] ?? null;
    if (s.inat_taxon_id != null) add(index.byTaxon, s.inat_taxon_id, s.id);
    else add(index.byName, s.scientific_name, s.id);
    if (currentId != null) add(index.byTaxon, currentId, s.id);
    if (s.inat_taxon_id != null || currentId != null) index.known.add(s.id);
  }
  const synonyms = await db.query<{ species_id: string; synonym_name: string }>(
    `SELECT ss.species_id, ss.synonym_name FROM species_synonyms ss JOIN species s ON s.id = ss.species_id WHERE NOT s.is_other_taxa`,
  );
  for (const r of synonyms.rows) add(index.byName, r.synonym_name, r.species_id);
  return index;
}

export interface PlaceSpecies {
  observations: number;
  taxonIds: number[];
  iconic: string | null;
}

/** Catalog species with research-grade observations in a place, with their counts summed over
 *  every taxon that maps to them. */
export function matchPlace(
  taxa: Map<number, { count: number; iconic: string | null; name: string }>,
  index: CatalogIndex,
): Map<string, PlaceSpecies> {
  const matched = new Map<string, PlaceSpecies>();
  for (const [taxonId, t] of taxa) {
    const ids = index.byTaxon.get(taxonId) ?? index.byName.get(t.name);
    for (const id of ids ?? []) {
      const m = matched.get(id) ?? { observations: 0, taxonIds: [], iconic: t.iconic };
      m.observations += t.count;
      m.taxonIds.push(taxonId);
      matched.set(id, m);
    }
  }
  return matched;
}

/** "region_id|species_id" of every listing iNaturalist confirms (a research-grade observation in
 *  the region's place, from the cached place lists, never fetched). A region is also confirmed
 *  through its child regions (a vernacular group, or a place whose list isn't cached). eBird's absence never
 *  removes these: iNaturalist decides membership. */
export async function inatConfirmedListings(
  db: Pool | PoolClient = pool,
  index?: CatalogIndex,
  regionIds?: string[],
): Promise<Set<string>> {
  index ??= await loadCatalogIndex(db);
  const regions = await db.query<{ id: string; parent_id: string | null; inat_place_id: number | null }>(
    `SELECT id, parent_id, inat_place_id FROM regions WHERE $1::uuid[] IS NULL OR id = ANY($1) OR parent_id = ANY($1)`,
    [regionIds ?? null],
  );
  const out = new Set<string>();
  for (const r of regions.rows) {
    const taxa = r.inat_place_id != null ? cachedPlaceCounts(r.inat_place_id) : null;
    if (!taxa) continue;
    for (const id of matchPlace(taxa, index).keys()) {
      out.add(`${r.id}|${id}`);
      if (r.parent_id) out.add(`${r.parent_id}|${id}`);
    }
  }
  return out;
}

/** Years in the window with an observation, or null when a year wasn't fetched for one of the
 *  species' taxa. */
export function yearsPresent(
  taxonIds: number[],
  window: number[],
  years: ReturnType<typeof cachedPlaceYearCounts>,
): number | null {
  let present = 0;
  for (const year of window) {
    const asked = years.asked.get(year);
    if (!asked || taxonIds.some((id) => !asked.has(id))) return null;
    if (taxonIds.some((id) => (years.counts.get(id)?.get(year) ?? 0) > 0)) present++;
  }
  return present;
}

export interface Change {
  region: string;
  speciesId: string;
  kind: "added" | "flagged" | "unflagged";
  observations: number;
  years: number | null;
  inat: InatVagrancy | null;
}

export interface RegionPlan {
  regionId: string;
  region: string;
  before: number;
  added: Array<{ speciesId: string; isVagrant: boolean }>;
  flags: Array<{ speciesId: string; isVagrant: boolean }>;
  keptUnknown: number;
  keptOverride: number;
  /** Kept because iNaturalist observers barely cover the species' group there. */
  keptThin: number;
  yearsIncomplete: boolean;
  changes: Change[];
  /** iNaturalist's vagrant call per listed species, which a country hands its provinces. */
  calls: Map<string, InatVagrancy>;
}

/** What the rules make of one region's list. Fetches the place's missing yearly counts unless
 *  iNaturalist is off. Null when the region has no cached iNaturalist counts. */
export async function planRegion(
  region: { id: string; name: string; inat_place_id: number },
  index: CatalogIndex,
  window: number[],
  countryCalls?: Map<string, InatVagrancy>,
): Promise<RegionPlan | null> {
  const taxa = cachedPlaceCounts(region.inat_place_id);
  if (!taxa || taxa.size === 0) return null;
  const matched = matchPlace(taxa, index);

  // How well iNaturalist observers cover each group here.
  const groupObs = new Map<string | null, number>();
  for (const t of taxa.values()) groupObs.set(t.iconic, (groupObs.get(t.iconic) ?? 0) + t.count);

  // Only species the vagrant rule can call need their years.
  const candidates = new Set<number>();
  for (const m of matched.values())
    if (m.observations <= VAGRANT_CANDIDATE_MAX_OBS && yearsDecide(m.iconic, groupObs.get(m.iconic) ?? 0))
      for (const id of m.taxonIds) candidates.add(id);
  if (candidates.size > 0)
    await refreshPlaceYearCounts(
      region.inat_place_id,
      [...candidates].sort((a, b) => a - b),
      window,
    );
  const years = cachedPlaceYearCounts(region.inat_place_id);

  const rows = await pool.query<{
    species_id: string;
    is_vagrant: boolean;
    is_invasive: boolean;
    listed: boolean;
    override_vagrant: boolean | null;
  }>(
    // Listed rows plus trusted overrides for species not listed, so an added species gets its
    // override too. GBIF range checklists (gbif-distributions) aren't trusted over iNaturalist.
    `SELECT COALESCE(rs.species_id, o.species_id) AS species_id, COALESCE(rs.is_vagrant, false) AS is_vagrant,
            COALESCE(rs.is_invasive, false) AS is_invasive, rs.species_id IS NOT NULL AS listed,
            CASE WHEN o.source NOT LIKE 'gbif-distributions:%' THEN o.is_vagrant END AS override_vagrant
     FROM (SELECT rs.* FROM region_species rs JOIN species s ON s.id = rs.species_id
           WHERE rs.region_id = $1 AND NOT s.is_other_taxa) rs
     FULL JOIN (SELECT * FROM region_species_manual_overrides WHERE region_id = $1) o ON o.species_id = rs.species_id`,
    [region.id],
  );
  const plan: RegionPlan = {
    regionId: region.id,
    region: region.name,
    before: 0,
    added: [],
    flags: [],
    keptUnknown: 0,
    keptOverride: 0,
    keptThin: 0,
    yearsIncomplete: false,
    changes: [],
    calls: new Map(),
  };
  const existing = new Map(rows.rows.map((r) => [r.species_id, r]));
  // Farm animals, and domestic breeds where their wild species is introduced (regions/domesticHere.ts).
  const domesticHere = (await domesticSpeciesIn(pool, region.id)).ids;
  for (const r of rows.rows) {
    if (!r.listed) continue;
    plan.before++;
    if (matched.has(r.species_id)) continue;
    if (r.override_vagrant != null) plan.keptOverride++;
    else if (!index.known.has(r.species_id)) plan.keptUnknown++;
    else if ((groupObs.get(iconicOfClass(index.taxonClass.get(r.species_id) ?? null)) ?? 0) < WELL_OBSERVED_GROUP_OBS)
      plan.keptThin++;
    else if (!r.is_vagrant && !r.is_invasive && !domesticHere.has(r.species_id)) {
      plan.flags.push({ speciesId: r.species_id, isVagrant: true });
      plan.changes.push({
        region: region.name,
        speciesId: r.species_id,
        kind: "flagged",
        observations: 0,
        years: null,
        inat: null,
      });
    }
  }
  for (const [speciesId, m] of matched) {
    const row = existing.get(speciesId);
    const present = yearsPresent(m.taxonIds, window, years);
    if (present == null && m.taxonIds.some((id) => candidates.has(id))) plan.yearsIncomplete = true;
    const own = inatVagrancy({
      observations: m.observations,
      yearsPresent: present,
      iconic: m.iconic,
      groupObs: groupObs.get(m.iconic) ?? 0,
    });
    // A stray to the country is a stray to each of its provinces.
    const inat = own === "unsure" && countryCalls?.get(speciesId) === "vagrant" ? "vagrant" : own;
    plan.calls.set(speciesId, inat);
    const isVagrant = decideIsVagrant({
      inat,
      current: row?.listed ? row.is_vagrant : false,
      override: row?.override_vagrant ?? null,
      introduced: row?.listed ? row.is_invasive : false,
      domestic: domesticHere.has(speciesId),
    });
    const change = { region: region.name, speciesId, observations: m.observations, years: present, inat };
    if (!row?.listed) {
      plan.added.push({ speciesId, isVagrant });
      plan.changes.push({ ...change, kind: "added" });
    } else if (isVagrant !== row.is_vagrant) {
      plan.flags.push({ speciesId, isVagrant });
      plan.changes.push({ ...change, kind: isVagrant ? "flagged" : "unflagged" });
    }
  }
  return plan;
}

export async function applyPlan(plan: RegionPlan): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (plan.added.length > 0)
      await client.query(
        `INSERT INTO region_species (region_id, species_id, is_vagrant, is_invasive, evidence_source)
         SELECT $1, v.id, v.vagrant, false, 'inat' FROM unnest($2::uuid[], $3::boolean[]) AS v(id, vagrant)
         ON CONFLICT (region_id, species_id) DO NOTHING`,
        [plan.regionId, plan.added.map((a) => a.speciesId), plan.added.map((a) => a.isVagrant)],
      );
    if (plan.flags.length > 0)
      await client.query(
        `UPDATE region_species rs SET is_vagrant = v.vagrant FROM unnest($2::uuid[], $3::boolean[]) AS v(id, vagrant)
         WHERE rs.region_id = $1 AND rs.species_id = v.id`,
        [plan.regionId, plan.flags.map((f) => f.speciesId), plan.flags.map((f) => f.isVagrant)],
      );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function describe(plan: RegionPlan): string {
  const flagged = plan.changes.filter((c) => c.kind === "flagged");
  const absent = flagged.filter((c) => c.inat == null).length;
  return (
    `${plan.region}: ${plan.before} -> ${plan.before + plan.added.length} (+${plan.added.length} added, ` +
    `${flagged.length} newly vagrant of which ${absent} not on iNaturalist, ${plan.flags.length - flagged.length} no longer vagrant)` +
    (plan.keptUnknown + plan.keptOverride + plan.keptThin > 0
      ? `; kept without iNaturalist: ${plan.keptOverride} by override, ${plan.keptUnknown} with no iNaturalist id, ${plan.keptThin} in groups it barely covers here`
      : "") +
    (plan.yearsIncomplete ? "; some yearly counts missing, those flags left to GBIF" : "")
  );
}

// Spread over the kinds of change and picked by a fixed hash, so reruns show the same rows.
function spotChecks(changes: Change[], n: number): Change[] {
  const hash = (c: Change) => [...(c.region + c.speciesId)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const kinds = ["added", "flagged", "unflagged"] as const;
  const byKind = kinds.map((k) => changes.filter((c) => c.kind === k).sort((a, b) => hash(a) - hash(b)));
  const picked: Change[] = [];
  for (let i = 0; picked.length < n && byKind.some((list) => i < list.length); i++)
    for (const list of byKind) if (i < list.length && picked.length < n) picked.push(list[i]);
  return picked;
}

async function main() {
  const { values } = parseArgs({
    options: {
      apply: { type: "boolean", default: false },
      countries: { type: "string" },
      "no-followups": { type: "boolean", default: false },
      "spot-checks": { type: "string", default: "30" },
    },
  });
  const names = values.countries
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const countries = await pool.query<{ id: string; name: string; inat_place_id: number | null }>(
    `SELECT c.id, c.name, r.inat_place_id FROM (${COUNTRIES_SQL}) c JOIN regions r ON r.id = c.id
     WHERE ($1::text[] IS NULL OR c.name = ANY($1)) ORDER BY c.name`,
    [names ?? null],
  );
  const index = await loadCatalogIndex();
  const window = vagrantWindowYears();
  console.log(`[inat-membership] vagrant window ${window[0]}-${window[window.length - 1]}`);
  const all: Change[] = [];
  const totals = {
    regions: 0,
    added: 0,
    flagged: 0,
    unflagged: 0,
    keptUnknown: 0,
    keptOverride: 0,
    keptThin: 0,
  };
  const rows: string[] = ["country\tregion\tchange\tspecies\tclass\tobservations\tyears\tinat_call"];
  const run = async (country: string, plan: RegionPlan | null) => {
    if (!plan) return;
    for (const c of plan.changes)
      rows.push(
        [
          country,
          c.region,
          c.kind,
          index.label.get(c.speciesId),
          index.taxonClass.get(c.speciesId) ?? "",
          c.observations,
          c.years ?? "",
          c.inat ?? "",
        ].join("\t"),
      );
    totals.regions++;
    totals.added += plan.added.length;
    for (const c of plan.changes) if (c.kind === "flagged" || c.kind === "unflagged") totals[c.kind]++;
    totals.keptUnknown += plan.keptUnknown;
    totals.keptOverride += plan.keptOverride;
    totals.keptThin += plan.keptThin;
    all.push(...plan.changes);
    if (plan.changes.length > 0) console.log(`[inat-membership] ${describe(plan)}`);
    if (values.apply && plan.changes.length > 0) await applyPlan(plan);
  };
  for (const country of countries.rows) {
    const provinces = await pool.query<{ id: string; name: string; inat_place_id: number }>(
      `SELECT id, name, inat_place_id FROM regions WHERE id IN (${provinceIdsSql("$1")}) AND inat_place_id IS NOT NULL ORDER BY name`,
      [country.id],
    );
    // The country's list is its own place's, so it's planned before the provinces change anything.
    const countryPlan =
      country.inat_place_id != null
        ? await planRegion({ ...country, inat_place_id: country.inat_place_id }, index, window)
        : null;
    for (const province of provinces.rows)
      await run(country.name, await planRegion(province, index, window, countryPlan?.calls));
    // Groups are their provinces' lists together, so they're rebuilt once those are done.
    if (values.apply) await buildGroupChecklists(country.id, true);
    await run(country.name, countryPlan);
  }
  console.log(
    `[inat-membership] ${totals.regions} regions: +${totals.added} added, ` +
      `${totals.flagged} newly vagrant, ${totals.unflagged} no longer vagrant; kept without iNaturalist: ` +
      `${totals.keptOverride} by override, ${totals.keptUnknown} with no iNaturalist id, ${totals.keptThin} in groups it barely covers there`,
  );
  console.log(`[inat-membership] spot checks (observations, years seen of ${window.length}, iNaturalist's call):`);
  for (const c of spotChecks(all, Number(values["spot-checks"])))
    console.log(
      `  ${c.kind.padEnd(9)} ${c.region}: ${index.label.get(c.speciesId)}` +
        ` (${c.observations} obs, ${c.years ?? "?"} yrs, ${c.inat ?? "not on iNaturalist here"})`,
    );
  await pool.end();
  writeFileSync(REVIEW_TSV, rows.join("\n") + "\n");
  console.log(`[inat-membership] every change in ${path.relative(PIPELINE_DIR, REVIEW_TSV)}`);
  if (!values.apply) {
    console.log("[inat-membership] preview only (pass --apply), then rerun the tiers stage");
    return;
  }
  if (!values["no-followups"])
    for (const script of ["remove-escapes.ts", "apply-ebird-exotics.ts", "apply-introduced-flags.ts"])
      execFileSync("npx", ["tsx", `src/scripts/${script}`, "--apply"], { cwd: PIPELINE_DIR, stdio: "inherit" });
  console.log("[inat-membership] applied; rerun the tiers stage next");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
