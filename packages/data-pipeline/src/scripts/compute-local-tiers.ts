// Absolute local rarity tiers for every checklist row (packages/data-pipeline/src/build/
// local-tier-model.ts), computed offline from data already on disk and in the database: no GBIF,
// iNaturalist or eBird calls, so a full pass takes minutes and can be rerun freely.
//
// Two steps per country:
// 1. inputs (--inputs, or automatically for a country with no effort rows yet): reads the
//    province partitions the province build already wrote (province-aggregate-cache/
//    {iso2}-{Country}__{provinceId}.tsv) and stores, per checklist row, the species' recent live
//    records and the years they fall in, and per region the recent live records of each species
//    group (region_group_effort). Countries get the sum of their provinces.
// 2. tiers: every row of the country and its provinces through the model. Countries first, so a
//    province with too few records of a group can use the country's tier (tier_reason
//    'inherited') instead of guessing. Each row stores its tier, the reason and the explanation
//    the app shows when the tier is tapped.
//
// Usage (from packages/data-pipeline):
//   npx tsx src/scripts/compute-local-tiers.ts --countries="Costa Rica" --calibrate     (preview + anchor table)
//   npx tsx src/scripts/compute-local-tiers.ts --countries="Costa Rica,Canada" --apply
//   npx tsx src/scripts/compute-local-tiers.ts --apply                                   (every country)
// Options: --inputs forces re-reading the partitions; --strict exits non-zero when an anchor misses.
import { createReadStream, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { pool } from "@lifer/core/db.js";
import { cachedPlaceCounts } from "@lifer/core/regions/inatChecklist.js";
import { cachedEbirdCodes } from "./add-new-species-to-checklists.js";
import { bboxDiagonalDegrees, exteriorRingsFromGeometry, ringBoundingBox } from "@lifer/core/lib/geometry.js";
import {
  coreRangeDiagonalKm,
  tierFromInputs,
  tierGroupForGbifClass,
  tierGroupForTaxonClass,
  type HotspotCluster,
  type TierResult,
} from "../build/local-tier-model.js";
import { TIER_ORDER, type TierExplain, type TierGroup } from "@lifer/shared";
import { requirePostgis } from "../pipeline/requirePostgis.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const PARTITION_DIR = path.join(REPO_ROOT, "packages/data-pipeline/data/province-aggregate-cache");
const ANCHORS_PATH = path.join(REPO_ROOT, "packages/data-pipeline/data/reference/checklist-anchors.json");
const LIVE_BASIS = new Set(["HUMAN_OBSERVATION", "OBSERVATION", "MACHINE_OBSERVATION"]);
const RECENT_YEARS = 15;
const KM_PER_DEGREE = 111;

interface Country {
  id: string;
  name: string;
  provinces: Array<{ id: string; name: string }>;
}

export async function loadCountries(names: string[] | null): Promise<Country[]> {
  const res = await pool.query<{ id: string; name: string }>(
    `SELECT c.id, c.name FROM regions c
     JOIN regions cont ON cont.id = c.parent_id
     WHERE COALESCE(array_length(cont.external_codes, 1), 0) = 0 AND cont.parent_id IS NOT NULL
       AND ($1::text[] IS NULL OR c.name = ANY($1))
     ORDER BY c.name`,
    [names],
  );
  const out: Country[] = [];
  for (const c of res.rows) {
    const provinces = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM regions WHERE parent_id = $1 ORDER BY name`,
      [c.id],
    );
    out.push({ ...c, provinces: provinces.rows });
  }
  return out;
}

// ---------- step 1: inputs ----------

let partitionIndex: Map<string, string> | null = null;
function partitionFor(provinceId: string): string | null {
  if (!partitionIndex) {
    partitionIndex = new Map();
    if (existsSync(PARTITION_DIR)) {
      for (const f of readdirSync(PARTITION_DIR)) {
        const m = f.match(/__([0-9a-f-]{36})\.tsv$/);
        if (m) partitionIndex.set(m[1], path.join(PARTITION_DIR, f));
      }
    }
  }
  return partitionIndex.get(provinceId) ?? null;
}

let catalogNames: Map<string, { id: string; taxonClass: string | null }> | null = null;
async function loadCatalogNames() {
  if (catalogNames) return catalogNames;
  const res = await pool.query<{ name: string; id: string; taxon_class: string | null }>(
    `SELECT scientific_name AS name, id, taxon_class FROM species WHERE NOT is_other_taxa
     UNION ALL
     SELECT ss.synonym_name, s.id, s.taxon_class FROM species_synonyms ss JOIN species s ON s.id = ss.species_id WHERE NOT s.is_other_taxa`,
  );
  catalogNames = new Map();
  // Real names win over synonyms when both exist.
  for (const r of res.rows)
    if (!catalogNames.has(r.name)) catalogNames.set(r.name, { id: r.id, taxonClass: r.taxon_class });
  return catalogNames;
}

interface RegionInputs {
  species: Map<string, { records: number; years: Set<number> }>;
  effort: Map<TierGroup, { live: number; all: number }>;
}

function groupOfPartitionClass(cls: string): TierGroup | null {
  // Birds, mammals and fish carry GBIF's class; other groups were written under the catalog's own
  // taxon_class when the province build admitted them.
  return tierGroupForGbifClass(cls) ?? tierGroupForTaxonClass(cls);
}

async function readPartition(
  file: string,
  names: Map<string, { id: string }>,
  currentYear: number,
): Promise<RegionInputs> {
  const species = new Map<string, { records: number; years: Set<number> }>();
  const effort = new Map<TierGroup, { live: number; all: number }>();
  const rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    const f = line.split("\t");
    if (f.length < 8) continue;
    const [name, cls, , , yearStr, , countStr, basis] = f;
    const count = Number(countStr) || 1;
    const group = groupOfPartitionClass(cls);
    const year = Number(yearStr);
    const live = LIVE_BASIS.has(basis) && year >= currentYear - RECENT_YEARS;
    if (group) {
      const e = effort.get(group) ?? { live: 0, all: 0 };
      e.all += count;
      if (live) e.live += count;
      effort.set(group, e);
    }
    if (!live) continue;
    const hit = names.get(name);
    if (!hit) continue;
    const s = species.get(hit.id) ?? { records: 0, years: new Set<number>() };
    s.records += count;
    s.years.add(year);
    species.set(hit.id, s);
  }
  return { species, effort };
}

async function writeInputs(regionId: string, inputs: RegionInputs) {
  const ids = [...inputs.species.keys()];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE region_species SET live_recent_records = NULL, recent_distinct_years = NULL WHERE region_id = $1`,
      [regionId],
    );
    await client.query(
      `UPDATE region_species rs SET live_recent_records = v.records, recent_distinct_years = v.years
       FROM unnest($2::uuid[], $3::int[], $4::int[]) AS v(species_id, records, years)
       WHERE rs.region_id = $1 AND rs.species_id = v.species_id`,
      [
        regionId,
        ids,
        ids.map((id) => inputs.species.get(id)!.records),
        ids.map((id) => inputs.species.get(id)!.years.size),
      ],
    );
    await client.query(`DELETE FROM region_group_effort WHERE region_id = $1`, [regionId]);
    const groups = [...inputs.effort.keys()];
    await client.query(
      `INSERT INTO region_group_effort (region_id, species_group, live_recent_records, all_records)
       SELECT $1, g, l, a FROM unnest($2::text[], $3::bigint[], $4::bigint[]) AS v(g, l, a)`,
      [regionId, groups, groups.map((g) => inputs.effort.get(g)!.live), groups.map((g) => inputs.effort.get(g)!.all)],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Reads the country's province partitions and stores tier inputs for each province and the
 *  country. Returns false when no partitions exist (the province build hasn't run for it). */
export async function refreshTierInputs(country: Country): Promise<boolean> {
  const names = await loadCatalogNames();
  const currentYear = new Date().getFullYear();
  const total: RegionInputs = { species: new Map(), effort: new Map() };
  let found = 0;
  for (const p of country.provinces) {
    const file = partitionFor(p.id);
    if (!file) continue;
    found++;
    const inputs = await readPartition(file, names, currentYear);
    await writeInputs(p.id, inputs);
    for (const [id, s] of inputs.species) {
      const t = total.species.get(id) ?? { records: 0, years: new Set<number>() };
      t.records += s.records;
      for (const y of s.years) t.years.add(y);
      total.species.set(id, t);
    }
    for (const [g, e] of inputs.effort) {
      const t = total.effort.get(g) ?? { live: 0, all: 0 };
      t.live += e.live;
      t.all += e.all;
      total.effort.set(g, t);
    }
  }
  if (found === 0) return false;
  await writeInputs(country.id, total);
  return true;
}

// iNaturalist's iconic groups mapped to tier groups, for each place's photo totals.
const ICONIC_GROUP: Record<string, TierGroup> = {
  Aves: "birds",
  Mammalia: "mammals",
  Reptilia: "herps",
  Amphibia: "herps",
  Actinopterygii: "fish",
};

/** Research-grade photo counts from the cached iNaturalist lists (no network): per checklist row,
 *  and per region and group. A region whose list has no counts cached yet is left as it was. */
export async function refreshInatInputs(regionIds: string[]): Promise<number> {
  const regions = await pool.query<{ id: string; inat_place_id: number }>(
    `SELECT id, inat_place_id FROM regions WHERE id = ANY($1) AND inat_place_id IS NOT NULL`,
    [regionIds],
  );
  let updated = 0;
  for (const r of regions.rows) {
    const counts = cachedPlaceCounts(r.inat_place_id);
    if (!counts) continue;
    const effort = new Map<TierGroup, number>();
    for (const t of counts.values()) {
      const g = t.iconic ? ICONIC_GROUP[t.iconic] : undefined;
      if (g) effort.set(g, (effort.get(g) ?? 0) + t.count);
    }
    const byName = new Map([...counts.values()].map((t) => [t.name, t.count]));
    const rows = await pool.query<{ species_id: string; inat_taxon_id: number | null; names: string[] }>(
      `SELECT rs.species_id, s.inat_taxon_id,
              array_prepend(s.scientific_name, COALESCE((SELECT array_agg(synonym_name) FROM species_synonyms WHERE species_id = s.id), '{}')) AS names
       FROM region_species rs JOIN species s ON s.id = rs.species_id WHERE rs.region_id = $1`,
      [r.id],
    );
    const ids: string[] = [];
    const values: Array<number | null> = [];
    for (const row of rows.rows) {
      const byId = row.inat_taxon_id != null ? counts.get(row.inat_taxon_id)?.count : undefined;
      const byAnyName = row.names.map((n) => byName.get(n)).find((c) => c != null);
      ids.push(row.species_id);
      // No photos here counts as 0 only for a species iNaturalist is known to have (an id): one
      // it may simply know under another name is unknown instead, and rated on GBIF records.
      values.push(byId ?? byAnyName ?? (row.inat_taxon_id != null ? 0 : null));
    }
    await pool.query(
      `UPDATE region_species rs SET inat_rg_count = v.n FROM unnest($2::uuid[], $3::int[]) AS v(id, n)
       WHERE rs.region_id = $1 AND rs.species_id = v.id`,
      [r.id, ids, values],
    );
    const groups = [...effort.keys()];
    await pool.query(
      `INSERT INTO region_group_effort (region_id, species_group, live_recent_records, all_records, inat_rg_records)
       SELECT $1, g, 0, 0, n FROM unnest($2::text[], $3::bigint[]) AS v(g, n)
       ON CONFLICT (region_id, species_group) DO UPDATE SET inat_rg_records = EXCLUDED.inat_rg_records`,
      [r.id, groups, groups.map((g) => effort.get(g)!)],
    );
    updated++;
  }
  return updated;
}

/** A well-known species that nobody has photographed in a place where its group is photographed
 *  a lot would be photographed if it were there: its listing is an old name for a split species,
 *  a misidentification, or a captive record. Removed unless GBIF has solid recent evidence. Fish
 *  (often offshore, rarely photographed) and bats are left alone. */
// Country lists only: a province can have too few photos of a group for absence to mean anything.
export const UNCONFIRMED_MIN_GROUP_PHOTOS = 5000;
export const UNCONFIRMED_MIN_INTEREST = 50_000;
export const UNCONFIRMED_KEEP_RECORDS = 50;

export async function removeUnconfirmed(
  regionIds: string[],
  apply: boolean,
): Promise<Array<{ region: string; species: string }>> {
  const res = await pool.query<{
    region_id: string;
    species_id: string;
    region: string;
    species: string;
    inat_taxon_id: number | null;
    names: string[];
  }>(
    `SELECT rs.region_id, rs.species_id, r.name AS region, COALESCE(s.common_name, s.scientific_name) AS species, s.inat_taxon_id,
            array_prepend(s.scientific_name, COALESCE((SELECT array_agg(synonym_name) FROM species_synonyms WHERE species_id = s.id), '{}')) AS names
     FROM region_species rs
     JOIN species s ON s.id = rs.species_id
     JOIN species_traits t ON t.species_id = s.id
     JOIN regions r ON r.id = rs.region_id
     JOIN region_group_effort g ON g.region_id = rs.region_id
       AND g.species_group = CASE WHEN s.taxon_class = 'mammalia' THEN 'mammals' WHEN s.taxon_class IN ('amphibia', 'squamata', 'testudines') THEN 'herps' END
     WHERE rs.region_id = ANY($1) AND NOT s.is_other_taxa
       AND g.inat_rg_records >= $2 AND rs.inat_rg_count = 0 AND t.wiki_pageviews_12mo >= $3
       AND COALESCE(rs.live_recent_records, 0) < $4
       -- Bats are genuinely hard to photograph and identify: no photos isn't evidence against them.
       AND COALESCE(s.taxon_order, '') <> 'Chiroptera'
       AND NOT EXISTS (SELECT 1 FROM region_species_manual_overrides o WHERE o.region_id = rs.region_id AND o.species_id = rs.species_id)`,
    [regionIds, UNCONFIRMED_MIN_GROUP_PHOTOS, UNCONFIRMED_MIN_INTEREST, UNCONFIRMED_KEEP_RECORDS],
  );
  // Photographed next door means it may well be here too: iNaturalist hides sensitive species from
  // place searches, and some species are simply never photographed.
  const rows = [];
  for (const r of res.rows) {
    if (!(await photographedInNeighbours(r.region_id, r.inat_taxon_id, r.names))) rows.push(r);
  }
  res.rows.length = 0;
  res.rows.push(...rows);
  if (apply && res.rows.length > 0) {
    await pool.query(
      `DELETE FROM region_species rs USING unnest($1::uuid[], $2::uuid[]) AS v(region_id, species_id)
       WHERE rs.region_id = v.region_id AND rs.species_id = v.species_id`,
      [res.rows.map((r) => r.region_id), res.rows.map((r) => r.species_id)],
    );
    await pool.query(
      `DELETE FROM region_species_hotspots h USING unnest($1::uuid[], $2::uuid[]) AS v(region_id, species_id)
       WHERE h.region_id = v.region_id AND h.species_id = v.species_id`,
      [res.rows.map((r) => r.region_id), res.rows.map((r) => r.species_id)],
    );
  }
  return res.rows.map((r) => ({ region: r.region, species: r.species }));
}

// ---------- step 2: tiers ----------

function regionDiagonalKm(geojson: unknown): number | null {
  if (!geojson) return null;
  // Stored as a GeoJSON Feature; older rows may hold the bare geometry.
  const feature = geojson as { geometry?: { type: string; coordinates: unknown } };
  const rings = exteriorRingsFromGeometry(feature.geometry ?? (geojson as { type: string; coordinates: unknown }));
  if (rings.length === 0) return null;
  const bbox = ringBoundingBox(rings.flat());
  return bboxDiagonalDegrees(bbox) * KM_PER_DEGREE;
}

interface TierRow {
  region_id: string;
  species_id: string;
  scientific_name: string;
  common_name: string | null;
  taxon_class: string | null;
  live_recent_records: number | null;
  recent_distinct_years: number | null;
  weekly_frequency: number[] | null;
  local_frequency: number | string | null;
  is_vagrant: boolean;
  inat_rg_count: number | null;
  nocturnal: boolean | null;
  habitat_density: number | null;
  density_per_km2: string | null;
  home_range_km2: string | null;
  depth_min_m: string | null;
  iucn_status: string | null;
  domestic: boolean | null;
  wiki_pageviews_12mo: number | null;
}

export interface ComputedTier extends TierResult {
  regionId: string;
  speciesId: string;
  name: string;
  commonName: string | null;
}

const num = (v: string | number | null) => (v == null ? null : Number(v));

export const EASIEST_MIN_EFFORT_SHARE = 0.1;
export const EASIEST_PROVEN_RECORDS = 1000;

export async function computeCountryTiers(country: Country): Promise<ComputedTier[]> {
  const regionIds = [country.id, ...country.provinces.map((p) => p.id)];
  const [rowsRes, effortRes, hotspotRes, geoRes] = await Promise.all([
    pool.query<TierRow>(
      `SELECT rs.region_id, rs.species_id, s.scientific_name, s.common_name, s.taxon_class, rs.live_recent_records,
              rs.recent_distinct_years, rs.weekly_frequency, rs.is_vagrant, rs.inat_rg_count, rs.local_frequency,
              t.nocturnal, t.habitat_density, t.density_per_km2, t.home_range_km2, t.depth_min_m, t.iucn_status, t.domestic,
              t.wiki_pageviews_12mo
       FROM region_species rs JOIN species s ON s.id = rs.species_id
       LEFT JOIN species_traits t ON t.species_id = s.id
       WHERE rs.region_id = ANY($1) AND NOT s.is_other_taxa`,
      [regionIds],
    ),
    pool.query<{
      region_id: string;
      species_group: TierGroup;
      live_recent_records: string;
      inat_rg_records: string | null;
    }>(
      `SELECT region_id, species_group, live_recent_records, inat_rg_records FROM region_group_effort WHERE region_id = ANY($1)`,
      [regionIds],
    ),
    pool.query<{
      region_id: string;
      species_id: string;
      centroid_lat: number;
      centroid_lon: number;
      point_count: number;
      bbox_diagonal_km: number;
    }>(
      `SELECT region_id, species_id, centroid_lat, centroid_lon, point_count, bbox_diagonal_km FROM region_species_hotspots WHERE region_id = ANY($1)`,
      [regionIds],
    ),
    pool.query<{ id: string; boundary_geojson: unknown }>(
      `SELECT id, boundary_geojson FROM regions WHERE id = ANY($1)`,
      [regionIds],
    ),
  ]);

  const effort = new Map<string, number>();
  const inatEffort = new Map<string, number>();
  for (const e of effortRes.rows) {
    effort.set(`${e.region_id}:${e.species_group}`, Number(e.live_recent_records));
    if (e.inat_rg_records != null) inatEffort.set(`${e.region_id}:${e.species_group}`, Number(e.inat_rg_records));
  }
  const diagonal = new Map(geoRes.rows.map((r) => [r.id, regionDiagonalKm(r.boundary_geojson)]));
  // Clusters per region and species; the country's are all of its provinces' together.
  const clusters = new Map<string, HotspotCluster[]>();
  for (const h of hotspotRes.rows) {
    const cl = {
      centroidLat: Number(h.centroid_lat),
      centroidLon: Number(h.centroid_lon),
      pointCount: Number(h.point_count),
      bboxDiagonalKm: Number(h.bbox_diagonal_km),
    };
    for (const key of [`${h.region_id}:${h.species_id}`, `${country.id}:${h.species_id}`]) {
      const list = clusters.get(key) ?? [];
      list.push(cl);
      clusters.set(key, list);
    }
  }

  // Each place's reference for birds: the average records of its five most-reported birds.
  const birdRecords = new Map<string, number[]>();
  for (const r of rowsRes.rows) {
    if (tierGroupForTaxonClass(r.taxon_class) !== "birds" || r.live_recent_records == null) continue;
    const list = birdRecords.get(r.region_id) ?? [];
    list.push(Number(r.live_recent_records));
    birdRecords.set(r.region_id, list);
  }
  const birdReference = new Map<string, number>();
  for (const [regionId, list] of birdRecords) {
    const top = list.sort((a, b) => b - a).slice(0, 5);
    if (top.length > 0) birdReference.set(regionId, top.reduce((a, b) => a + b, 0) / top.length);
  }

  // And for photo-rated groups: the five most-photographed species' average photos, and their
  // typical interest (geometric mean of Wikipedia views), per place and group.
  const photoRows = new Map<string, Array<{ n: number; interest: number }>>();
  for (const r of rowsRes.rows) {
    const g = tierGroupForTaxonClass(r.taxon_class);
    if (!g || g === "birds" || r.inat_rg_count == null || Number(r.inat_rg_count) <= 0) continue;
    const key = `${r.region_id}:${g}`;
    const list = photoRows.get(key) ?? [];
    list.push({ n: Number(r.inat_rg_count), interest: Math.max(1000, Number(r.wiki_pageviews_12mo ?? 0)) });
    photoRows.set(key, list);
  }
  const photoReference = new Map<string, { photos: number; interest: number }>();
  for (const [key, list] of photoRows) {
    const top = list.sort((a, b) => b.n - a.n).slice(0, 5);
    photoReference.set(key, {
      photos: top.reduce((a, b) => a + b.n, 0) / top.length,
      interest: Math.exp(top.reduce((a, b) => a + Math.log(b.interest), 0) / top.length),
    });
  }

  const compute = (r: TierRow): ComputedTier => {
    const group = tierGroupForTaxonClass(r.taxon_class);
    const diag = diagonal.get(r.region_id);
    const cl = clusters.get(`${r.region_id}:${r.species_id}`);
    const concentrationRatio = diag && cl && cl.length > 0 ? coreRangeDiagonalKm(cl) / diag : null;
    const result = tierFromInputs({
      taxonClass: r.taxon_class,
      records: r.live_recent_records,
      effort: group ? (effort.get(`${r.region_id}:${group}`) ?? null) : null,
      inatRecords: r.inat_rg_count,
      inatEffort: group ? (inatEffort.get(`${r.region_id}:${group}`) ?? null) : null,
      referenceRecords: group === "birds" ? (birdReference.get(r.region_id) ?? null) : null,
      referencePhotos:
        group && group !== "birds" ? (photoReference.get(`${r.region_id}:${group}`)?.photos ?? null) : null,
      referenceInterest:
        group && group !== "birds" ? (photoReference.get(`${r.region_id}:${group}`)?.interest ?? null) : null,
      concentrationRatio,
      recentDistinctYears: r.recent_distinct_years,
      weeklyFrequency: r.weekly_frequency,
      isVagrant: r.is_vagrant,
      interest: r.wiki_pageviews_12mo,
      traits: {
        nocturnal: r.nocturnal,
        habitatDensity: r.habitat_density,
        densityPerKm2: num(r.density_per_km2),
        homeRangeKm2: num(r.home_range_km2),
        depthMinM: num(r.depth_min_m),
        iucnStatus: r.iucn_status,
        domestic: r.domestic,
      },
    });
    // Nothing at all behind the listing (no records of any age, no photos): not enough to rate,
    // rather than Legendary by default.
    const noEvidence =
      !r.is_vagrant && !Number(r.live_recent_records) && !Number(r.inat_rg_count) && !Number(r.local_frequency);
    const rated =
      noEvidence && result.reason === "rated" ? { ...result, tier: null, reason: "no_data" as const } : result;
    return {
      ...rated,
      regionId: r.region_id,
      speciesId: r.species_id,
      name: r.scientific_name,
      commonName: r.common_name,
    };
  };

  // Provinces first, on their own data. A country's tier is its easiest province's tier, the
  // same way the worldwide tier is the easiest native country; rating across the whole country
  // would make every regional species Legendary.
  // Only provinces surveyed well enough for the group count (group effort at least
  // EASIEST_MIN_EFFORT_SHARE of the best-surveyed province), since in a lightly surveyed place
  // any photographed species looks like a big share.
  const provinceNames = new Map(country.provinces.map((p) => [p.id, p.name]));
  const groupEffort = (regionId: string, group: TierGroup) =>
    inatEffort.get(`${regionId}:${group}`) ?? effort.get(`${regionId}:${group}`) ?? 0;
  const bestEffort = new Map<TierGroup, number>();
  for (const p of country.provinces) {
    for (const g of ["birds", "mammals", "herps", "fish"] as TierGroup[]) {
      bestEffort.set(g, Math.max(bestEffort.get(g) ?? 0, groupEffort(p.id, g)));
    }
  }
  const provinceTiers = rowsRes.rows.filter((r) => r.region_id !== country.id).map((r) => ({ row: r, t: compute(r) }));
  // A province also counts when the species itself has EASIEST_PROVEN_RECORDS there: that many
  // sightings proves it's easy to find. A species found only in lightly surveyed provinces takes
  // the easiest of those instead.
  const easiest = new Map<string, { t: ComputedTier; province: string; surveyed: boolean }>();
  for (const { row, t } of provinceTiers) {
    if (!t.tier || row.is_vagrant || t.reason !== "rated") continue;
    const group = tierGroupForTaxonClass(row.taxon_class);
    // Only photo-rated tiers need it: eBird's full checklists record common species too, so their
    // rates hold however few birders visit.
    const surveyed =
      !group ||
      t.explain?.source !== "inat" ||
      groupEffort(row.region_id, group) >= EASIEST_MIN_EFFORT_SHARE * (bestEffort.get(group) ?? 0) ||
      (t.explain?.records ?? 0) >= EASIEST_PROVEN_RECORDS;
    const best = easiest.get(row.species_id);
    const better =
      !best ||
      (surveyed && !best.surveyed) ||
      (surveyed === best.surveyed && TIER_ORDER.indexOf(t.tier) < TIER_ORDER.indexOf(best.t.tier!));
    if (better) easiest.set(row.species_id, { t, province: provinceNames.get(row.region_id) ?? "", surveyed });
  }
  // Where no province can rate it and one says it's too little photographed to tell, the country
  // says so too, rather than rating it across the whole country.
  const fewPhotos = new Map<string, ComputedTier>();
  for (const { row, t } of provinceTiers)
    if (t.reason === "few_photos" && !fewPhotos.has(row.species_id)) fewPhotos.set(row.species_id, t);
  const countryRows = rowsRes.rows.filter((r) => r.region_id === country.id);
  const countryTiers = new Map(
    countryRows.map((r): [string, ComputedTier] => {
      const best = easiest.get(r.species_id);
      const unknown = fewPhotos.get(r.species_id);
      if (!best && unknown) return [r.species_id, { ...unknown, regionId: country.id }];
      if (!best) return [r.species_id, compute(r)];
      const explain: TierExplain | null = best.t.explain
        ? { ...best.t.explain, base: best.t.tier, steps: [], guard: false, easiestIn: best.province }
        : null;
      return [r.species_id, { ...best.t, regionId: country.id, reason: "rated", explain }];
    }),
  );
  const out: ComputedTier[] = [...countryTiers.values()];
  for (const { row: r, t } of provinceTiers) {
    // Too few records of the group in this province: the country's tier for the species is a
    // better answer than a guess or nothing.
    const fromCountry = countryTiers.get(r.species_id);
    if ((t.reason === "thin_data" || t.reason === "no_data") && fromCountry?.tier) {
      out.push({ ...t, tier: fromCountry.tier, reason: "inherited", explain: fromCountry.explain });
    } else {
      out.push(t);
    }
  }
  return out;
}

async function writeTiers(tiers: ComputedTier[]) {
  const BATCH = 5000;
  for (let i = 0; i < tiers.length; i += BATCH) {
    const b = tiers.slice(i, i + BATCH);
    await pool.query(
      `UPDATE region_species rs SET local_tier = v.tier, tier_reason = v.reason, tier_explain = v.explain::jsonb
       FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::text[]) AS v(region_id, species_id, tier, reason, explain)
       WHERE rs.region_id = v.region_id AND rs.species_id = v.species_id`,
      [
        b.map((t) => t.regionId),
        b.map((t) => t.speciesId),
        b.map((t) => t.tier),
        b.map((t) => t.reason),
        b.map((t) => (t.explain ? JSON.stringify(t.explain) : null)),
      ],
    );
  }
}

// ---------- calibration ----------

// packages/data-pipeline/data/reference/checklist-anchors.json: species that must be on a
// region's list, some with the tier they must have.
interface Anchor {
  name: string;
  region: string;
  /** Expected tier, or "rare/legendary" when either is right. */
  tier?: string;
}

function printCalibration(tiers: ComputedTier[], regionNames: Map<string, string>, anchors: Anchor[]): number {
  let misses = 0;
  const rows: string[][] = [["species", "region", "rate/1000", "base", "steps", "tier", "expected", ""]];
  for (const a of anchors) {
    if (!a.tier) continue;
    const hit = tiers.find((t) => t.name === a.name && regionNames.get(t.regionId) === a.region);
    if (!hit) {
      if ([...regionNames.values()].includes(a.region)) {
        rows.push([a.name, a.region, "-", "-", "not on the list", "-", a.tier, "MISSING"]);
        misses++;
      }
      continue;
    }
    const e = hit.explain;
    const ok = !!hit.tier && a.tier.split("/").includes(hit.tier);
    if (!ok) misses++;
    rows.push([
      `${hit.commonName ?? a.name}`,
      a.region,
      e?.rate != null ? e.rate.toFixed(3) : "-",
      e?.base ?? "-",
      e?.guard ? "guard" : (e?.steps ?? []).map((s) => s.kind).join(",") || "-",
      hit.tier ?? `none (${hit.reason})`,
      a.tier,
      ok ? "" : "MISS",
    ]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  for (const r of rows) console.log(r.map((c, i) => c.padEnd(widths[i])).join("  "));
  return misses;
}

function printDistribution(tiers: ComputedTier[], label: string) {
  const byGroup = new Map<string, Map<string, number>>();
  for (const t of tiers) {
    const g = t.explain?.group ?? "other";
    const m = byGroup.get(g) ?? new Map();
    const key = t.tier ?? `(${t.reason})`;
    m.set(key, (m.get(key) ?? 0) + 1);
    byGroup.set(g, m);
  }
  console.log(`[tiers] ${label}`);
  for (const [g, m] of byGroup) {
    console.log(
      `  ${g.padEnd(8)} ${[...m.entries()]
        .sort()
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}`,
    );
  }
}

/** Research-grade photos per iNaturalist taxon id, summed over every country's cached list: how
 *  much a species is photographed where it lives. Loaded once a run. */
let photosByCountryPlace: Map<number, Map<number, number>> | null = null;
async function countryPhotoLists(): Promise<Map<number, Map<number, number>>> {
  if (photosByCountryPlace) return photosByCountryPlace;
  const places = await pool.query<{ inat_place_id: number }>(
    `SELECT DISTINCT c.inat_place_id FROM regions c JOIN regions cont ON cont.id = c.parent_id
     WHERE COALESCE(array_length(cont.external_codes, 1), 0) = 0 AND cont.parent_id IS NOT NULL AND c.inat_place_id IS NOT NULL`,
  );
  photosByCountryPlace = new Map();
  for (const p of places.rows) {
    const counts = cachedPlaceCounts(p.inat_place_id);
    if (counts) photosByCountryPlace.set(p.inat_place_id, new Map([...counts].map(([id, t]) => [id, t.count])));
  }
  return photosByCountryPlace;
}

/** Countries this close count as neighbours: a species photographed there may well be here too. */
export const NEVER_HERE_NEIGHBOUR_KM = 300;

/** iNaturalist place ids of the country's neighbours (within NEVER_HERE_NEIGHBOUR_KM, edge to edge). */
const neighbourCache = new Map<string, Set<number>>();
async function neighbourPlaces(countryId: string): Promise<Set<number>> {
  const cached = neighbourCache.get(countryId);
  if (cached) return cached;
  const places = await queryNeighbourPlaces(countryId);
  neighbourCache.set(countryId, places);
  return places;
}

async function queryNeighbourPlaces(countryId: string): Promise<Set<number>> {
  const res = await pool.query<{ inat_place_id: number }>(
    `WITH shapes AS (
       SELECT c.id, c.inat_place_id,
              ST_Simplify(ST_Force2D(ST_GeomFromGeoJSON((c.boundary_geojson->'geometry')::text)), 0.05, true)::geography AS g
       FROM regions c JOIN regions cont ON cont.id = c.parent_id
       WHERE COALESCE(array_length(cont.external_codes, 1), 0) = 0 AND cont.parent_id IS NOT NULL
         AND c.boundary_geojson ? 'geometry' AND c.inat_place_id IS NOT NULL
     )
     SELECT o.inat_place_id FROM shapes me JOIN shapes o ON o.id <> me.id AND ST_DWithin(me.g, o.g, $2 * 1000)
     WHERE me.id = $1`,
    [countryId, NEVER_HERE_NEIGHBOUR_KM],
  );
  return new Set(res.rows.map((r) => r.inat_place_id));
}

export const NEVER_HERE_MIN_GROUP_PHOTOS = 5000;
export const NEVER_HERE_MIN_PHOTOS_ELSEWHERE = 20;

/** Whether any country within NEVER_HERE_NEIGHBOUR_KM has research-grade photos of the species,
 *  by its iNaturalist id or any of its names. */
async function photographedInNeighbours(
  countryId: string,
  inatTaxonId: number | null,
  names: string[],
): Promise<boolean> {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  for (const place of await neighbourPlaces(countryId)) {
    const counts = cachedPlaceCounts(place);
    if (!counts) continue;
    if (inatTaxonId != null && (counts.get(inatTaxonId)?.count ?? 0) > 0) return true;
    for (const t of counts.values()) if (t.count > 0 && wanted.has(t.name.toLowerCase())) return true;
  }
  return false;
}

/** A mammal, reptile or amphibian listed in a country with no field observations there in 15
 *  years and not one photo in the country or any neighbour, though the country is heavily
 *  photographed for its group and the species is photographed plenty elsewhere, isn't there.
 *  Neighbours count because iNaturalist hides some sensitive species from place searches. Such
 *  listings usually come from museum specimens filed under the museum's location, old or mistaken
 *  records, or old names for split species. Natives known only from specimens (no photos
 *  anywhere) and bats are kept. Removed from the country and its provinces. */
export async function removeNeverPhotographedHere(
  country: Country,
  apply: boolean,
): Promise<Array<{ region: string; species: string }>> {
  const place = (
    await pool.query<{ inat_place_id: number | null }>(`SELECT inat_place_id FROM regions WHERE id = $1`, [country.id])
  ).rows[0]?.inat_place_id;
  const lists = await countryPhotoLists();
  const here = place != null ? lists.get(place) : undefined;
  if (!here) return []; // no photo counts for the country yet: nothing to judge by
  const hereByName = new Map([...(cachedPlaceCounts(place!) ?? new Map())].map(([, t]) => [t.name, t.count]));
  const regionIds = [country.id, ...country.provinces.map((p) => p.id)];
  const rows = await pool.query<{
    region_id: string;
    species_id: string;
    region: string;
    species: string;
    inat_taxon_id: number | null;
    names: string[];
  }>(
    `SELECT rs.region_id, rs.species_id, r.name AS region, COALESCE(s.common_name, s.scientific_name) AS species, s.inat_taxon_id,
            array_prepend(s.scientific_name, COALESCE((SELECT array_agg(synonym_name) FROM species_synonyms WHERE species_id = s.id), '{}')) AS names
     FROM region_species rs
     JOIN species s ON s.id = rs.species_id
     JOIN regions r ON r.id = rs.region_id
     JOIN region_group_effort g ON g.region_id = $2
       AND g.species_group = CASE WHEN s.taxon_class = 'mammalia' THEN 'mammals' WHEN s.taxon_class IN ('amphibia', 'squamata', 'testudines') THEN 'herps' END
     WHERE rs.region_id = ANY($1) AND NOT s.is_other_taxa AND s.inat_taxon_id IS NOT NULL
       AND g.inat_rg_records >= $3
       AND COALESCE(rs.live_recent_records, 0) = 0
       -- Bats go unphotographed where they really are (the Greater Long-nosed Bat in Big Bend).
       AND COALESCE(s.taxon_order, '') <> 'Chiroptera'
       AND NOT EXISTS (SELECT 1 FROM region_species_manual_overrides o WHERE o.region_id = rs.region_id AND o.species_id = rs.species_id)`,
    [regionIds, country.id, NEVER_HERE_MIN_GROUP_PHOTOS],
  );
  const neighbours = rows.rows.length > 0 ? await neighbourPlaces(country.id) : new Set<number>();
  const found = rows.rows.filter((r) => {
    if ((here.get(r.inat_taxon_id!) ?? 0) > 0 || r.names.some((n) => (hereByName.get(n) ?? 0) > 0)) return false;
    let elsewhere = 0;
    for (const [p, counts] of lists) {
      if (p === place) continue;
      const n = counts.get(r.inat_taxon_id!) ?? 0;
      if (neighbours.has(p) && n > 0) return false;
      elsewhere += n;
    }
    return elsewhere >= NEVER_HERE_MIN_PHOTOS_ELSEWHERE;
  });
  if (apply && found.length > 0) {
    const args = [found.map((r) => r.region_id), found.map((r) => r.species_id)];
    await pool.query(
      `DELETE FROM region_species rs USING unnest($1::uuid[], $2::uuid[]) AS v(region_id, species_id)
       WHERE rs.region_id = v.region_id AND rs.species_id = v.species_id`,
      args,
    );
    await pool.query(
      `DELETE FROM region_species_hotspots h USING unnest($1::uuid[], $2::uuid[]) AS v(region_id, species_id)
       WHERE h.region_id = v.region_id AND h.species_id = v.species_id`,
      args,
    );
  }
  return found.map((r) => ({ region: r.region, species: r.species }));
}

async function deleteRows(rows: Array<{ region_id: string; species_id: string }>): Promise<void> {
  if (rows.length === 0) return;
  const args = [rows.map((r) => r.region_id), rows.map((r) => r.species_id)];
  await pool.query(
    `DELETE FROM region_species rs USING unnest($1::uuid[], $2::uuid[]) AS v(region_id, species_id)
     WHERE rs.region_id = v.region_id AND rs.species_id = v.species_id`,
    args,
  );
  await pool.query(
    `DELETE FROM region_species_hotspots h USING unnest($1::uuid[], $2::uuid[]) AS v(region_id, species_id)
     WHERE h.region_id = v.region_id AND h.species_id = v.species_id`,
    args,
  );
}

/** Birds eBird has never had reported in the country and nobody has recorded there in 15 years,
 *  usually museum and zoo records filed under the institution's location. eBird's lists include
 *  rare strays, so real vagrants stay. The country's list is its provinces' cached eBird lists
 *  together; a province with its own list is judged against it. A country with no eBird lists
 *  cached is left alone. */
export async function removeBirdsEbirdNeverHad(
  country: Country,
  apply: boolean,
): Promise<Array<{ region: string; species: string }>> {
  const regions = await pool.query<{ id: string; name: string; ebird_region_code: string | null }>(
    `SELECT id, name, ebird_region_code FROM regions WHERE id = ANY($1)`,
    [[country.id, ...country.provinces.map((p) => p.id)]],
  );
  const lists = new Map<string, Set<string>>();
  const countryList = new Set<string>();
  for (const r of regions.rows) {
    const codes = r.ebird_region_code ? cachedEbirdCodes(r.ebird_region_code) : null;
    if (!codes || codes.size === 0) continue;
    lists.set(r.id, codes);
    for (const c of codes) countryList.add(c);
  }
  if (countryList.size === 0) return [];
  const names = new Map(regions.rows.map((r) => [r.id, r.name]));
  const rows = await pool.query<{ region_id: string; species_id: string; species: string; ebird_code: string | null }>(
    `SELECT rs.region_id, rs.species_id, COALESCE(s.common_name, s.scientific_name) AS species, s.ebird_code
     FROM region_species rs JOIN species s ON s.id = rs.species_id
     WHERE rs.region_id = ANY($1) AND s.taxon_class = 'aves' AND NOT s.is_other_taxa
       AND COALESCE(rs.live_recent_records, 0) = 0
       -- Only where the record inputs are in: before they are, every bird reads as unrecorded.
       AND EXISTS (SELECT 1 FROM region_group_effort g WHERE g.region_id = rs.region_id AND g.species_group = 'birds' AND g.live_recent_records > 0)
       AND NOT EXISTS (SELECT 1 FROM region_species_manual_overrides o WHERE o.region_id = rs.region_id AND o.species_id = rs.species_id)`,
    [[...names.keys()]],
  );
  const found = rows.rows.filter((r) => !r.ebird_code || !(lists.get(r.region_id) ?? countryList).has(r.ebird_code));
  if (apply) await deleteRows(found);
  return found.map((r) => ({ region: names.get(r.region_id) ?? "", species: r.species }));
}

/** Removes extinct species from the checklists. The app hides them, but on a list they would
 *  still count toward tiers, totals and packs. */
export async function removeExtinct(
  country: Country,
  apply: boolean,
): Promise<Array<{ region: string; species: string }>> {
  const res = await pool.query<{ region_id: string; species_id: string; region: string; species: string }>(
    `SELECT rs.region_id, rs.species_id, r.name AS region, COALESCE(s.common_name, s.scientific_name) AS species
     FROM region_species rs JOIN species s ON s.id = rs.species_id JOIN species_traits t ON t.species_id = s.id
     JOIN regions r ON r.id = rs.region_id
     WHERE rs.region_id = ANY($1) AND t.fully_extinct`,
    [[country.id, ...country.provinces.map((p) => p.id)]],
  );
  if (apply) await deleteRows(res.rows);
  return res.rows.map(({ region, species }) => ({ region, species }));
}

async function main() {
  await requirePostgis(pool, "compute-local-tiers.ts");
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const forceInputs = args.includes("--inputs");
  const strict = args.includes("--strict");
  const calibrateArg = args.find((a) => a.startsWith("--calibrate"));
  const countriesArg = args.find((a) => a.startsWith("--countries="))?.slice("--countries=".length);
  const names = countriesArg
    ? countriesArg
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;
  const anchors: Anchor[] = calibrateArg
    ? JSON.parse(readFileSync(calibrateArg.includes("=") ? calibrateArg.split("=")[1] : ANCHORS_PATH, "utf8"))
    : [];

  const countries = await loadCountries(names);
  console.log(`[tiers] ${countries.length} countries`);
  let misses = 0;
  for (const country of countries) {
    const hasEffort = (await pool.query(`SELECT 1 FROM region_group_effort WHERE region_id = $1 LIMIT 1`, [country.id]))
      .rowCount;
    if (forceInputs || !hasEffort) {
      const ok = await refreshTierInputs(country);
      if (!ok) {
        console.log(`[tiers] ${country.name}: no province partitions on disk yet, skipped`);
        continue;
      }
    }
    // Photo counts are read from the cached iNaturalist lists every run: cheap, and they're
    // what the tiers are rated on first.
    await refreshInatInputs([country.id, ...country.provinces.map((p) => p.id)]);
    const unconfirmed = await removeUnconfirmed([country.id], apply);
    if (unconfirmed.length > 0) {
      console.log(
        `[tiers] ${country.name}: ${apply ? "removed" : "would remove"} ${unconfirmed.length} well-known species nobody has photographed there (e.g. ${[...new Set(unconfirmed.map((u) => u.species))].slice(0, 6).join(", ")})`,
      );
    }
    for (const [label, rows] of [
      ["extinct species", await removeExtinct(country, apply)],
      ["birds eBird has never had reported there", await removeBirdsEbirdNeverHad(country, apply)],
    ] as const) {
      if (rows.length === 0) continue;
      const onCountry = rows.filter((u) => u.region === country.name).map((u) => u.species);
      console.log(
        `[tiers] ${country.name}: ${apply ? "removed" : "would remove"} ${rows.length} listings of ${label}` +
          (onCountry.length > 0
            ? ` (on the country list: ${onCountry.slice(0, 12).join(", ")}${onCountry.length > 12 ? ", ..." : ""})`
            : ""),
      );
    }
    const neverHere = await removeNeverPhotographedHere(country, apply);
    if (neverHere.length > 0) {
      console.log(
        `[tiers] ${country.name}: ${apply ? "removed" : "would remove"} ${neverHere.length} listings of species photographed elsewhere but never there (e.g. ${[...new Set(neverHere.map((u) => u.species))].slice(0, 8).join(", ")})`,
      );
    }
    const tiers = await computeCountryTiers(country);
    printDistribution(
      tiers.filter((t) => t.regionId === country.id),
      `${country.name} (country list)`,
    );
    if (anchors.length > 0) {
      const regionNames = new Map([
        [country.id, country.name],
        ...country.provinces.map((p) => [p.id, p.name] as [string, string]),
      ]);
      misses += printCalibration(tiers, regionNames, anchors);
    }
    if (apply) await writeTiers(tiers);
  }
  console.log(apply ? "[tiers] applied" : "[tiers] preview only, nothing written (pass --apply)");
  await pool.end();
  if (strict && misses > 0) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
