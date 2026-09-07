// Recomputes region_species.local_tier from data ALREADY on disk (region_species +
// region_species_hotspots) — no GBIF re-download, no re-parsing a country's occurrence dump.
// Exists because compute-provinces-bulk.ts's rangeScore had a real flaw (fixed there too, this
// script just backfills provinces that were computed BEFORE the fix): it measured a species'
// "range" as the bbox of literally every point it was ever recorded at in a province, including
// tiny outlier/vagrant clusters far from its real stronghold. Confirmed live for Sage Thrasher in
// British Columbia — a genuine narrow-range specialty (its whole real population sits in a few
// dozen km² of the South Okanagan) scored as if it were spread across ~900km of the province,
// because a small (~7% of records) wandering cluster near the Fraser Valley dragged the naive
// whole-point bbox out that far. The fix: measure range across only the DOMINANT cluster(s) —
// whichever hotspot rows together hold >=80% of the species' records here — the same "go here to
// actually find it" question a photographer is really asking, not "where has this species EVER
// once been seen."
//
// Usage: npx tsx src/scripts/recalibrate-local-tiers.ts [--regions="British Columbia,Ontario"] [--apply]
import { pool } from "../db.js";
import { bboxDiagonalDegrees, ringBoundingBox, exteriorRingsFromGeometry, type Point } from "data-pipeline/src/geometry.js";
import {
  percentileRankScores,
  tierForScore,
  BIRD_ABSOLUTE_TIER_THRESHOLDS,
  MAMMAL_ABSOLUTE_TIER_THRESHOLDS,
  FISH_ABSOLUTE_TIER_THRESHOLDS,
} from "data-pipeline/src/build/compute-rarity-phase1.js";

const KM_PER_DEGREE = 111;
const TIER_ORDER = ["legendary", "epic", "rare", "uncommon", "common"];
const PROVINCE_RANGE_ABUNDANCE_WEIGHTS = { range: 0.5, abundance: 0.5 };

interface Cluster {
  centroidLat: number;
  centroidLon: number;
  pointCount: number;
  bboxDiagonalKm: number;
}

// Kept in sync with compute-provinces-bulk.ts's own coreRangeDiagonalKm — see its comment for
// why "small AND far from the rest" (not just "small") is the right outlier test.
const OUTLIER_MAX_SHARE = 0.1;
const OUTLIER_DISTANCE_STD_DEVS = 2.5;
function coreRangeDiagonalKm(clusters: Cluster[]): number {
  if (clusters.length <= 1) return clusters[0]?.bboxDiagonalKm ?? 0;
  const total = clusters.reduce((sum, cl) => sum + cl.pointCount, 0);
  const centroidLat = clusters.reduce((sum, cl) => sum + cl.centroidLat * cl.pointCount, 0) / total;
  const centroidLon = clusters.reduce((sum, cl) => sum + cl.centroidLon * cl.pointCount, 0) / total;
  const lonScale = Math.cos((centroidLat * Math.PI) / 180);
  const distanceKm = (cl: Cluster) =>
    Math.sqrt((cl.centroidLat - centroidLat) ** 2 + ((cl.centroidLon - centroidLon) * lonScale) ** 2) * KM_PER_DEGREE;
  const meanDistanceKm = clusters.reduce((sum, cl) => sum + distanceKm(cl) * cl.pointCount, 0) / total;
  const stdDevKm = Math.sqrt(clusters.reduce((sum, cl) => sum + (distanceKm(cl) - meanDistanceKm) ** 2 * cl.pointCount, 0) / total);

  const core = clusters.filter((cl) => {
    const isSmall = cl.pointCount / total <= OUTLIER_MAX_SHARE;
    const isFar = stdDevKm > 0 && distanceKm(cl) > meanDistanceKm + OUTLIER_DISTANCE_STD_DEVS * stdDevKm;
    return !(isSmall && isFar);
  });
  const effective = core.length > 0 ? core : clusters;
  if (effective.length === 1) return effective[0].bboxDiagonalKm;
  const centroidSpanKm =
    bboxDiagonalDegrees(ringBoundingBox(effective.map((cl) => [cl.centroidLon, cl.centroidLat] as Point))) * KM_PER_DEGREE;
  const maxClusterRadiusKm = Math.max(...effective.map((cl) => cl.bboxDiagonalKm / 2));
  return centroidSpanKm + maxClusterRadiusKm * 2;
}

// Confirmed live: Alagoas, Brazil has ~86,000 total bird records across its whole checklist
// versus British Columbia's 22 MILLION — a ~250x difference in reporting volume. With that few
// total records, one species' own count is noisy enough that percentile rank alone can swing it
// toward a falsely extreme tier (Rock Pigeon reading "rare" there isn't a real fact, unlike a
// genuinely sparse population — it's small-sample noise). A thin-data region's composite is
// pulled toward a neutral anchor rather than trusted at full strength.
const CONFIDENCE_LOW_RECORDS = 10_000;
const CONFIDENCE_HIGH_RECORDS = 1_000_000;
// How confident an OTHER region needs to be in its own reading of a species before that reading
// is trusted as the neutral anchor here, instead of falling back to the generic per-taxon
// "uncommon" default.
const MIN_ANCHOR_CONFIDENCE = 0.85;

function confidenceFromTotalRecords(totalRecords: number): number {
  if (totalRecords <= CONFIDENCE_LOW_RECORDS) return 0;
  if (totalRecords >= CONFIDENCE_HIGH_RECORDS) return 1;
  return (
    (Math.log10(totalRecords) - Math.log10(CONFIDENCE_LOW_RECORDS)) /
    (Math.log10(CONFIDENCE_HIGH_RECORDS) - Math.log10(CONFIDENCE_LOW_RECORDS))
  );
}

async function recalibrateRegion(
  regionId: string,
  regionName: string,
  apply: boolean,
  regionConfidenceByKey: Map<string, number>,
): Promise<void> {
  const boundaryRes = await pool.query<{ boundary_geojson: { type: string; coordinates: unknown; geometry?: unknown } | null }>(
    `SELECT boundary_geojson FROM regions WHERE id = $1`,
    [regionId],
  );
  const boundary = boundaryRes.rows[0]?.boundary_geojson;
  if (!boundary) {
    console.log(`[recalibrate-local-tiers] ${regionName}: no boundary geometry, skipping`);
    return;
  }
  const geometry = (boundary as { geometry?: unknown }).geometry ?? boundary;
  const rings = exteriorRingsFromGeometry(geometry as { type: string; coordinates: unknown });
  const regionDiagonalKm = bboxDiagonalDegrees(ringBoundingBox(rings.flat())) * KM_PER_DEGREE;

  for (const [taxonClass, thresholds] of [
    ["aves", BIRD_ABSOLUTE_TIER_THRESHOLDS],
    ["mammalia", MAMMAL_ABSOLUTE_TIER_THRESHOLDS],
    ["actinopterygii", FISH_ABSOLUTE_TIER_THRESHOLDS],
  ] as const) {
    const speciesRes = await pool.query<{ species_id: string; scientific_name: string; local_frequency: string | null }>(
      `SELECT rs.species_id, s.scientific_name, rs.local_frequency
       FROM region_species rs JOIN species s ON s.id = rs.species_id
       WHERE rs.region_id = $1 AND s.taxon_class = $2`,
      [regionId, taxonClass],
    );
    if (speciesRes.rows.length === 0) continue;

    const hotspotsRes = await pool.query<{ species_id: string; centroid_lat: number; centroid_lon: number; point_count: number; bbox_diagonal_km: number }>(
      `SELECT species_id, centroid_lat, centroid_lon, point_count, bbox_diagonal_km
       FROM region_species_hotspots WHERE region_id = $1`,
      [regionId],
    );
    // A region computed by an older pipeline version (before hotspot clustering existed) has
    // region_species rows but ZERO region_species_hotspots rows for anything — confirmed live
    // for Texas and Nordrhein-Westfalen, both still awaiting the current world-scale recompute.
    // Recalibrating range off no cluster data at all isn't "no signal," it's actively wrong
    // data (see coreRangeDiagonalKm's own comment) — skip the whole region rather than silently
    // computing garbage; it'll get correct hotspot data (and this same fixed range logic) once
    // the ongoing recompute reaches it.
    if (hotspotsRes.rows.length === 0) {
      console.log(`[recalibrate-local-tiers] ${regionName} (${taxonClass}): no hotspot data yet, skipping`);
      continue;
    }
    const clustersBySpecies = new Map<string, Cluster[]>();
    for (const h of hotspotsRes.rows) {
      if (!clustersBySpecies.has(h.species_id)) clustersBySpecies.set(h.species_id, []);
      clustersBySpecies.get(h.species_id)!.push({
        centroidLat: h.centroid_lat,
        centroidLon: h.centroid_lon,
        pointCount: h.point_count,
        bboxDiagonalKm: h.bbox_diagonal_km,
      });
    }

    // A species with zero of its OWN clusters (rare within an otherwise-populated region — most
    // records had a basis_of_record outside what hotspot clustering tracks) is left OUT of the
    // ranking, not given a ratio of 0 — see compute-provinces-bulk.ts's identical comment on why
    // "no data" must never read as "perfectly concentrated."
    const spreadRatioEntries = speciesRes.rows.flatMap((s, idx) => {
      const clusters = clustersBySpecies.get(s.species_id) ?? [];
      if (clusters.length === 0) return [];
      return [{ idx, value: regionDiagonalKm > 0 ? coreRangeDiagonalKm(clusters) / regionDiagonalKm : 0 }];
    });
    const spreadScoreByIdx = percentileRankScores(spreadRatioEntries);
    const baseScoreByIdx = percentileRankScores(speciesRes.rows.map((s, idx) => ({ idx, value: Number(s.local_frequency ?? 0) })));

    const globalTierRes = await pool.query<{ scientific_name: string; tier: string }>(
      `SELECT scientific_name, tier FROM species s JOIN species_rarity r ON r.species_id = s.id WHERE s.scientific_name = ANY($1)`,
      [speciesRes.rows.map((s) => s.scientific_name)],
    );
    const globalTierBySpecies = new Map(globalTierRes.rows.map((r) => [r.scientific_name, r.tier]));

    const thisRegionConfidence = regionConfidenceByKey.get(`${regionId}:${taxonClass}`) ?? 0;
    const uncommonAnchor = thresholds.find((t) => t.tier === "uncommon")!.minScore;

    // Cross-referenced against every OTHER region's own reading of these same species — a
    // species that reads epic/legendary in a region with plenty of its own data is a real,
    // informative signal (not neutral "uncommon") to anchor toward when THIS region's own
    // reading is too thin to trust; only the single most-confident other reading per species is
    // used, not an average across many, so one strong signal isn't diluted by several weak ones.
    let anchorByIdx = new Map<number, number>();
    if (thisRegionConfidence < 1) {
      const otherRes = await pool.query<{ species_id: string; region_id: string; local_tier: string }>(
        `SELECT species_id, region_id, local_tier FROM region_species
         WHERE species_id = ANY($1) AND region_id != $2 AND local_tier IS NOT NULL`,
        [speciesRes.rows.map((s) => s.species_id), regionId],
      );
      const bestConfidenceBySpecies = new Map<string, { confidence: number; tier: string }>();
      for (const row of otherRes.rows) {
        const otherConfidence = regionConfidenceByKey.get(`${row.region_id}:${taxonClass}`) ?? 0;
        if (otherConfidence < MIN_ANCHOR_CONFIDENCE) continue;
        const existing = bestConfidenceBySpecies.get(row.species_id);
        if (!existing || otherConfidence > existing.confidence) {
          bestConfidenceBySpecies.set(row.species_id, { confidence: otherConfidence, tier: row.local_tier });
        }
      }
      anchorByIdx = new Map(
        speciesRes.rows.flatMap((s, idx) => {
          const best = bestConfidenceBySpecies.get(s.species_id);
          if (!best) return [];
          const anchorScore = thresholds.find((t) => t.tier === best.tier)?.minScore;
          return anchorScore != null ? [[idx, anchorScore] as [number, number]] : [];
        }),
      );
    }

    let changed = 0;
    for (const [idx, s] of speciesRes.rows.entries()) {
      const rangeScore = spreadScoreByIdx.get(idx) ?? 0.5;
      const abundanceScore = baseScoreByIdx.get(idx) ?? 0.5;
      const rawComposite = PROVINCE_RANGE_ABUNDANCE_WEIGHTS.range * rangeScore + PROVINCE_RANGE_ABUNDANCE_WEIGHTS.abundance * abundanceScore;
      const anchor = anchorByIdx.get(idx) ?? uncommonAnchor;
      const composite = thisRegionConfidence * rawComposite + (1 - thisRegionConfidence) * anchor;
      let newTier = tierForScore(composite, thresholds);

      const globalTier = globalTierBySpecies.get(s.scientific_name);
      if (globalTier && globalTier !== "unrated") {
        const globalRank = TIER_ORDER.indexOf(globalTier);
        const localRank = TIER_ORDER.indexOf(newTier);
        // Floor (max 1 step easier than global) AND ceiling (max 2 steps harder) — see
        // regions/routes.ts's LOCAL_TIER_GLOBAL_CEILING_STEPS comment for why a globally
        // common species (Mallard) needs the ceiling too, confirmed live in South Africa.
        const clampedRank = Math.min(Math.max(localRank, globalRank - 2), globalRank + 1);
        if (clampedRank !== localRank) newTier = TIER_ORDER[clampedRank] as typeof newTier;
      }

      const res = await pool.query(`SELECT local_tier FROM region_species WHERE region_id = $1 AND species_id = $2`, [regionId, s.species_id]);
      const oldTier = res.rows[0]?.local_tier;
      if (oldTier === newTier) continue;
      changed++;
      if (apply) {
        await pool.query(`UPDATE region_species SET local_tier = $1 WHERE region_id = $2 AND species_id = $3`, [newTier, regionId, s.species_id]);
      } else {
        console.log(`  ${s.scientific_name}: ${oldTier} -> ${newTier}`);
      }
    }
    console.log(`[recalibrate-local-tiers] ${regionName} (${taxonClass}): ${changed}/${speciesRes.rows.length} tiers changed${apply ? " (applied)" : " (dry run)"}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const regionsArg = args.find((a) => a.startsWith("--regions="));
  const regionNames = regionsArg ? regionsArg.slice("--regions=".length).split(",").map((s) => s.trim()) : null;

  // One pass over the whole table, not one query per region — every region+taxon's own
  // reporting-volume confidence, used both to dampen a thin region's own composite and to judge
  // whether some OTHER region's reading of a species is trustworthy enough to anchor toward.
  const confidenceRes = await pool.query<{ region_id: string; taxon_class: string; total: string }>(
    `SELECT rs.region_id, s.taxon_class, SUM(rs.local_frequency) AS total
     FROM region_species rs JOIN species s ON s.id = rs.species_id
     WHERE s.taxon_class IN ('aves', 'mammalia', 'actinopterygii')
     GROUP BY rs.region_id, s.taxon_class`,
  );
  const regionConfidenceByKey = new Map(
    confidenceRes.rows.map((r) => [`${r.region_id}:${r.taxon_class}`, confidenceFromTotalRecords(Number(r.total))]),
  );

  const regionsRes = regionNames
    ? await pool.query<{ id: string; name: string }>(`SELECT id, name FROM regions WHERE name = ANY($1)`, [regionNames])
    : await pool.query<{ id: string; name: string }>(
        `SELECT DISTINCT r.id, r.name FROM regions r JOIN region_species rs ON rs.region_id = r.id`,
      );

  for (const region of regionsRes.rows) {
    await recalibrateRegion(region.id, region.name, apply, regionConfidenceByKey);
  }
  await pool.end();
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
