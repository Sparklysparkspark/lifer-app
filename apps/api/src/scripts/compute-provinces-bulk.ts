// Fully-automated province/state-level checklist computation: for each country in
// PRIORITY_COUNTRIES (in order), submits a GBIF SQL Download scoped to that single country
// (species/lat/lon/class/year/record_count — WITH coordinates, unlike the world-scale
// aggregated download compute-all-regions-bulk.ts used, which has no lat/lon and so can never
// answer a province-level question), polls until it's ready, downloads it, point-in-polygon
// matches every occurrence against that country's own province boundaries (same core logic as
// compute-us-states-from-bulk.ts, generalized to any country instead of hardcoded to the US),
// writes region_species + occurrence_computed_at per province, deletes the downloaded file, and
// moves on to the next country — no manual per-country download/extract/run cycle needed. This
// is the "download country data, parse it, compute it" path the live per-region GBIF API calls
// in compute-all-regions.ts were too rate-limited for (150/156 regions failed on 429 in that
// run — see its own comment).
//
// Requires GBIF_USER and GBIF_PWD env vars (a registered GBIF.org account — SQL downloads need
// authenticated requests, unlike simple occurrence search).
//
// Usage: npx tsx src/scripts/compute-provinces-bulk.ts [--countries=France,Germany] [--apply]
import { createWriteStream, createReadStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { pool } from "../db.js";
import { fetchAllCountries } from "data-pipeline/src/fetch/fetch-region-boundary.js";
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
import { drillDownAllCountries } from "./compute-all-regions.js";

// Same order as build-and-publish-all-packs.ts's own priority list — personally-relevant
// countries first, then a couple of continent representatives, so provinces for the countries
// that matter most get filled in before working through everyone else.
const PRIORITY_COUNTRIES = [
  "France",
  "Germany",
  "United Kingdom",
  "Belgium",
  "Netherlands",
  "Switzerland",
  "Austria",
  "Italy",
  "Spain",
  "Luxembourg",
  "Denmark",
  "Ireland",
  "Poland",
  "Czechia",
  "Brazil",
  "Colombia",
  "Kenya",
  "South Africa",
  "India",
  "Japan",
  "Australia",
  "New Zealand",
];

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

const GBIF_API = "https://api.gbif.org/v1";

function authHeader(): string {
  const user = process.env.GBIF_USER;
  const pwd = process.env.GBIF_PWD;
  if (!user || !pwd) throw new Error("GBIF_USER and GBIF_PWD env vars are required to submit a download");
  return `Basic ${Buffer.from(`${user}:${pwd}`).toString("base64")}`;
}

// One row per (species, lat, lon, class, year) with a pre-aggregated record_count — grouping by
// raw coordinates barely compresses (near one row per unique point) but keeps the query itself
// well-formed SQL; scoped to a SINGLE country's occurrences this stays a tractable size (already
// proven for the US — see compute-us-states-from-bulk.ts's own comment on where this pattern
// came from), unlike the world-scale unaggregated attempt that hit 1.5 billion rows/42GB.
async function submitDownload(iso2: string): Promise<string> {
  const sql =
    `SELECT species, decimallatitude, decimallongitude, "class", "year", count(*) AS record_count ` +
    `FROM occurrence WHERE countrycode = '${iso2}' AND decimallatitude IS NOT NULL AND decimallongitude IS NOT NULL ` +
    `AND taxonrank = 'SPECIES' AND occurrencestatus = 'PRESENT' ` +
    `GROUP BY species, decimallatitude, decimallongitude, "class", "year"`;
  const res = await fetch(`${GBIF_API}/occurrence/download/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader() },
    body: JSON.stringify({ sendNotification: false, format: "SQL_TSV_ZIP", sql }),
  });
  if (!res.ok) throw new Error(`GBIF download request failed: ${res.status} ${await res.text()}`);
  return (await res.text()).trim();
}

async function pollUntilReady(downloadKey: string): Promise<void> {
  for (;;) {
    const res = await fetch(`${GBIF_API}/occurrence/download/${downloadKey}`);
    const body = (await res.json()) as { status: string };
    if (body.status === "SUCCEEDED") return;
    if (body.status === "KILLED" || body.status === "FAILED" || body.status === "CANCELLED") {
      throw new Error(`GBIF download ${downloadKey} ended with status ${body.status}`);
    }
    console.log(`[compute-provinces-bulk]   download ${downloadKey}: ${body.status}, waiting...`);
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
}

async function downloadZip(downloadKey: string, destPath: string): Promise<void> {
  const res = await fetch(`${GBIF_API}/occurrence/download/request/${downloadKey}.zip`);
  if (!res.ok || !res.body) throw new Error(`GBIF zip fetch failed: ${res.status}`);
  const file = createWriteStream(destPath);
  await new Promise<void>((resolve, reject) => {
    // @ts-expect-error Node's fetch Response.body is a web ReadableStream, not a Node stream —
    // pipe manually below instead of assuming .pipe() exists on it.
    const reader = res.body.getReader();
    async function pump(): Promise<void> {
      const { done, value } = await reader.read();
      if (done) {
        file.end();
        return resolve();
      }
      file.write(value);
      return pump();
    }
    pump().catch(reject);
  });
}

interface ProvinceRegion {
  id: string;
  name: string;
  rings: Point[][];
  bbox: BoundingBox;
}

async function loadProvinces(countryId: string): Promise<ProvinceRegion[]> {
  const res = await pool.query<{ id: string; name: string; boundary_geojson: { type: string; coordinates: unknown } }>(
    `SELECT id, name, boundary_geojson FROM regions WHERE parent_id = $1 AND boundary_geojson IS NOT NULL`,
    [countryId],
  );
  return res.rows.map((r) => {
    const geometry = (r.boundary_geojson as { geometry?: unknown }).geometry ?? r.boundary_geojson;
    const rings = exteriorRingsFromGeometry(geometry as { type: string; coordinates: unknown });
    const allPoints = rings.flat();
    return { id: r.id, name: r.name, rings, bbox: ringBoundingBox(allPoints) };
  });
}

function findProvinces(point: Point, provinces: ProvinceRegion[]): ProvinceRegion[] {
  const pointBbox: BoundingBox = { minLon: point[0], minLat: point[1], maxLon: point[0], maxLat: point[1] };
  const matches: ProvinceRegion[] = [];
  for (const province of provinces) {
    if (!bboxesNear(province.bbox, pointBbox, 0)) continue;
    if (pointInAnyRing(point, province.rings)) matches.push(province);
  }
  return matches;
}

async function computeCountryProvinces(countryName: string, iso2: string, countryId: string, apply: boolean): Promise<void> {
  const provinces = await loadProvinces(countryId);
  if (provinces.length === 0) {
    console.log(`[compute-provinces-bulk] ${countryName}: no province rows found (drill-down produced none) — skipping`);
    return;
  }
  console.log(`[compute-provinces-bulk] ${countryName}: tracking ${provinces.length} province(s), submitting GBIF download for country=${iso2}...`);

  const workDir = mkdtempSync(path.join(tmpdir(), "gbif-provinces-"));
  const zipPath = path.join(workDir, "download.zip");
  try {
    const downloadKey = await submitDownload(iso2);
    console.log(`[compute-provinces-bulk] ${countryName}: download key ${downloadKey}, polling...`);
    await pollUntilReady(downloadKey);
    console.log(`[compute-provinces-bulk] ${countryName}: download ready, fetching zip...`);
    await downloadZip(downloadKey, zipPath);

    const perProvince = new Map<string, Map<string, { class: string; years: Map<number, number> }>>();
    for (const p of provinces) perProvince.set(p.id, new Map());

    const input = spawn("unzip", ["-p", zipPath]).stdout;
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    let header: string[] | null = null;
    let rowCount = 0;
    let matchedCount = 0;
    for await (const line of rl) {
      if (!line) continue;
      const cols = line.split("\t");
      if (!header) {
        header = cols;
        continue;
      }
      rowCount++;
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

      const matched = findProvinces([lon, lat], provinces);
      if (matched.length === 0) continue;
      matchedCount++;

      for (const province of matched) {
        const bySpecies = perProvince.get(province.id)!;
        let entry = bySpecies.get(species);
        if (!entry) {
          entry = { class: cls, years: new Map() };
          bySpecies.set(species, entry);
        }
        if (year != null) entry.years.set(year, (entry.years.get(year) ?? 0) + recordCount);
      }
    }
    console.log(`[compute-provinces-bulk] ${countryName}: scanned ${rowCount.toLocaleString()} rows, ${matchedCount.toLocaleString()} matched a province`);

    const currentYear = new Date().getFullYear();
    for (const province of provinces) {
      const bySpecies = perProvince.get(province.id)!;
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

      console.log(`[compute-provinces-bulk]   ${province.name}: ${included.length} species pass inclusion (of ${bySpecies.size} candidates)`);
      if (!apply) continue;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`DELETE FROM region_species WHERE region_id = $1`, [province.id]);
        let written = 0;
        for (const c of included) {
          const speciesRes = await client.query<{ id: string }>(`SELECT id FROM species WHERE scientific_name = $1`, [c.species]);
          const speciesId = speciesRes.rows[0]?.id;
          if (!speciesId) continue;
          await client.query(
            `INSERT INTO region_species (region_id, species_id, local_frequency, is_vagrant)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (region_id, species_id) DO UPDATE SET
               local_frequency = EXCLUDED.local_frequency, is_vagrant = EXCLUDED.is_vagrant`,
            [province.id, speciesId, c.recordCount, c.isVagrant],
          );
          written++;
        }
        await client.query(`UPDATE regions SET occurrence_computed_at = now() WHERE id = $1`, [province.id]);
        await client.query("COMMIT");
        console.log(`[compute-provinces-bulk]   ${province.name}: wrote ${written} species`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }
  } finally {
    // Always clean up the downloaded file, whether this country succeeded or failed, so a run
    // over 20+ countries never accumulates gigabytes of already-processed downloads.
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function main() {
  const countriesArg = process.argv.find((a) => a.startsWith("--countries="));
  const countryNames = countriesArg ? countriesArg.split("=")[1].split(",") : PRIORITY_COUNTRIES;
  const apply = process.argv.includes("--apply");
  if (!apply) console.log(`[compute-provinces-bulk] DRY RUN — pass --apply to actually write region_species`);

  console.log(`[compute-provinces-bulk] ensuring provinces are drilled down for ${countryNames.length} countries...`);
  await drillDownAllCountries(countryNames);

  const countries = await fetchAllCountries();
  const iso2ByName = new Map(countries.filter((c) => c.iso2).map((c) => [c.name, c.iso2!]));

  const countryRowsRes = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM regions WHERE name = ANY($1)`,
    [countryNames],
  );
  const countryIdByName = new Map(countryRowsRes.rows.map((r) => [r.name, r.id]));

  for (const [i, name] of countryNames.entries()) {
    const iso2 = iso2ByName.get(name);
    const countryId = countryIdByName.get(name);
    if (!iso2 || !countryId) {
      console.log(`[compute-provinces-bulk] ${i + 1}/${countryNames.length} ${name}: no ISO2/region row match, skipping`);
      continue;
    }
    console.log(`[compute-provinces-bulk] ${i + 1}/${countryNames.length} ${name} (${iso2})`);
    await computeCountryProvinces(name, iso2, countryId, apply);
  }

  console.log(`[compute-provinces-bulk] done.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
