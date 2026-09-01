// Computes US state checklists from the bulk GBIF SQL download (species, decimalLatitude,
// decimalLongitude, class, year, record_count — see the "one country at a time, with
// coordinates" trial) instead of live per-species GBIF API calls, which hit hard rate
// limiting for a handful of US states (Illinois, Indiana, Iowa all failed with 429s during
// the earlier live compute-all-regions.ts run). Same core inclusion logic as
// gbif-bulk-ab-test.ts's computeLocalChecklist (validated there against live results for
// Portugal) — MIN_RECORDS/FISH_MIN_RECORDS + recent-window + recurrence-rescue — just grouped
// by STATE via point-in-polygon against each state's own boundary_geojson instead of by
// country code, since the bulk download has no state/province field of its own.
//
// Deliberately does NOT reproduce local_tier's percentile-rank-plus-trait-boost scoring (see
// regions/routes.ts's computeRegionOccurrences) — that's a separate, GBIF-independent pass
// (it only needs record counts + species_traits, both already local) that can run over
// whatever this script writes, later. Rows written here get local_tier = NULL, same as any
// other not-yet-tiered species.
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { pool } from "../db.js";
import {
  pointInAnyRing,
  exteriorRingsFromGeometry,
  ringBoundingBox,
  bboxesNear,
  type Point,
  type BoundingBox,
} from "data-pipeline/src/geometry.js";
import {
  MIN_RECORDS,
  FISH_MIN_RECORDS,
  RECENT_YEARS_WINDOW,
  RECURRENCE_ALLTIME_FLOOR,
  passesRecurrenceCheck,
} from "data-pipeline/src/build/build-region-species.js";

const FISH_VAGRANT_MIN_RECORDS = 3;
const FISH_CLASSES = new Set([
  "Myxini",
  "Petromyzonti",
  "Elasmobranchii",
  "Holocephali",
  "Coelacanthi",
  "Dipneusti",
  "Actinopterygii",
  "Teleostei",
  "Chondrostei",
  "Cladistii",
  "Holostei",
]);
const BIRD_MAMMAL_CLASSES = new Set(["Aves", "Mammalia"]);

interface StateRegion {
  id: string;
  name: string;
  rings: Point[][];
  bbox: BoundingBox;
}

// species -> year -> recordCount, kept separately per state.
type SpeciesYearCounts = Map<string, Map<number, number>>;

async function loadStates(names: string[] | null): Promise<StateRegion[]> {
  const countryRes = await pool.query<{ id: string }>(`SELECT id FROM regions WHERE name = $1`, [
    "United States of America",
  ]);
  const countryId = countryRes.rows[0]?.id;
  if (!countryId) throw new Error("Couldn't find the United States of America region row");

  const statesRes = await pool.query<{ id: string; name: string; boundary_geojson: { type: string; coordinates: unknown } }>(
    `SELECT id, name, boundary_geojson FROM regions WHERE parent_id = $1 AND boundary_geojson IS NOT NULL`,
    [countryId],
  );
  const filtered = names ? statesRes.rows.filter((r) => names.includes(r.name)) : statesRes.rows;
  return filtered.map((r) => {
    // Stored as a GeoJSON Feature wrapper ({type: "Feature", geometry: {...}}), not a raw
    // geometry — exteriorRingsFromGeometry expects the latter.
    const geometry = (r.boundary_geojson as { geometry?: unknown }).geometry ?? r.boundary_geojson;
    const rings = exteriorRingsFromGeometry(geometry as { type: string; coordinates: unknown });
    const allPoints = rings.flat();
    return { id: r.id, name: r.name, rings, bbox: ringBoundingBox(allPoints) };
  });
}

function findStates(point: Point, states: StateRegion[]): StateRegion[] {
  const pointBbox: BoundingBox = { minLon: point[0], minLat: point[1], maxLon: point[0], maxLat: point[1] };
  const matches: StateRegion[] = [];
  for (const state of states) {
    if (!bboxesNear(state.bbox, pointBbox, 0)) continue;
    if (pointInAnyRing(point, state.rings)) matches.push(state);
  }
  return matches;
}

async function main() {
  const statesArg = process.argv.find((a) => a.startsWith("--states="))?.split("=")[1];
  const stateNames = statesArg ? statesArg.split(",") : null;
  const csvPath = process.argv.find((a) => a.startsWith("--csv="))?.split("=")[1];
  const zipPath = process.argv.find((a) => a.startsWith("--zip="))?.split("=")[1];
  const dryRun = !process.argv.includes("--apply");

  if (!csvPath && !zipPath) {
    console.error("Usage: --zip=<gbif download .zip> or --csv=<already-extracted .csv> [--states=Illinois,Indiana,Iowa] [--apply]");
    process.exit(1);
  }

  const states = await loadStates(stateNames);
  console.log(`[compute-us-states-from-bulk] tracking ${states.length} state(s): ${states.map((s) => s.name).join(", ")}`);

  // stateId -> species -> class -> yearCounts (kept separate per class only to know
  // fish-vs-bird/mammal at aggregation time; a species is always one class in practice).
  const perState = new Map<string, Map<string, { class: string; years: Map<number, number> }>>();
  for (const s of states) perState.set(s.id, new Map());

  const input = zipPath
    ? spawn("unzip", ["-p", zipPath]).stdout
    : createReadStream(csvPath!);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  let header: string[] | null = null;
  let rowCount = 0;
  let matchedCount = 0;
  const startTime = Date.now();
  for await (const line of rl) {
    if (!line) continue;
    const cols = line.split("\t");
    if (!header) {
      header = cols;
      continue;
    }
    rowCount++;
    if (rowCount % 2_000_000 === 0) {
      console.log(`[compute-us-states-from-bulk] ${rowCount.toLocaleString()} rows scanned, ${matchedCount.toLocaleString()} matched a tracked state, ${Math.round((Date.now() - startTime) / 1000)}s elapsed`);
    }
    const rec: Record<string, string> = {};
    header.forEach((h, i) => (rec[h] = cols[i] ?? ""));
    const species = rec.species;
    const lat = Number(rec.decimallatitude);
    const lon = Number(rec.decimallongitude);
    const cls = rec.class;
    const year = rec.year ? Number(rec.year) : null;
    const recordCount = rec.record_count ? Number(rec.record_count) : 1;
    if (!species || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!BIRD_MAMMAL_CLASSES.has(cls) && !FISH_CLASSES.has(cls)) continue;

    const matchedStates = findStates([lon, lat], states);
    if (matchedStates.length === 0) continue;
    matchedCount++;

    for (const state of matchedStates) {
      const bySpecies = perState.get(state.id)!;
      let entry = bySpecies.get(species);
      if (!entry) {
        entry = { class: cls, years: new Map() };
        bySpecies.set(species, entry);
      }
      if (year != null) entry.years.set(year, (entry.years.get(year) ?? 0) + recordCount);
    }
  }
  console.log(`[compute-us-states-from-bulk] done scanning: ${rowCount.toLocaleString()} rows, ${matchedCount.toLocaleString()} matched a tracked state`);

  const currentYear = new Date().getFullYear();
  for (const state of states) {
    const bySpecies = perState.get(state.id)!;
    const included: Array<{ species: string; recordCount: number; isVagrant: boolean }> = [];

    for (const [species, { class: cls, years }] of bySpecies) {
      const yearCountArr = [...years.entries()].map(([year, count]) => ({ year, count }));
      const allTimeTotal = yearCountArr.reduce((sum, y) => sum + y.count, 0);

      if (FISH_CLASSES.has(cls)) {
        if (allTimeTotal < FISH_MIN_RECORDS) continue;
        included.push({ species, recordCount: allTimeTotal, isVagrant: allTimeTotal < FISH_VAGRANT_MIN_RECORDS });
        continue;
      }

      const recentTotal = yearCountArr
        .filter((y) => y.year >= currentYear - RECENT_YEARS_WINDOW)
        .reduce((sum, y) => sum + y.count, 0);
      if (recentTotal >= MIN_RECORDS) {
        included.push({ species, recordCount: recentTotal, isVagrant: !passesRecurrenceCheck(yearCountArr) });
        continue;
      }
      if (allTimeTotal >= RECURRENCE_ALLTIME_FLOOR && passesRecurrenceCheck(yearCountArr)) {
        included.push({ species, recordCount: allTimeTotal, isVagrant: false });
      }
    }

    const birdCount = included.filter((c) => !FISH_CLASSES.has(bySpecies.get(c.species)!.class) && bySpecies.get(c.species)!.class === "Aves").length;
    const mammalCount = included.filter((c) => bySpecies.get(c.species)!.class === "Mammalia").length;
    const fishCount = included.filter((c) => FISH_CLASSES.has(bySpecies.get(c.species)!.class)).length;
    console.log(
      `[compute-us-states-from-bulk] ${state.name}: ${included.length} species pass inclusion (of ${bySpecies.size} candidates seen) — birds=${birdCount}, mammals=${mammalCount}, fish=${fishCount}`,
    );
    if (dryRun) continue;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM region_species WHERE region_id = $1`, [state.id]);
      let written = 0;
      let unmatched = 0;
      for (const c of included) {
        const speciesRes = await client.query<{ id: string }>(`SELECT id FROM species WHERE scientific_name = $1`, [c.species]);
        const speciesId = speciesRes.rows[0]?.id;
        if (!speciesId) {
          unmatched++;
          continue;
        }
        await client.query(
          `INSERT INTO region_species (region_id, species_id, local_frequency, is_vagrant)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (region_id, species_id) DO UPDATE SET
             local_frequency = EXCLUDED.local_frequency, is_vagrant = EXCLUDED.is_vagrant`,
          [state.id, speciesId, c.recordCount, c.isVagrant],
        );
        written++;
      }
      await client.query(`UPDATE regions SET occurrence_computed_at = now() WHERE id = $1`, [state.id]);
      await client.query("COMMIT");
      console.log(`[compute-us-states-from-bulk] ${state.name}: wrote ${written} species (${unmatched} had no catalog match by scientific_name)`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
