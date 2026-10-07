// Every sea zone's fish and marine mammal checklist in one offline pass over the GBIF country
// downloads (data/gbif-country-cache/<ISO2>.zip, the same files compute-provinces-bulk.ts reads),
// instead of compute-sea-zones.ts's live polygon searches, which take ~13s each over a large zone
// and would need ~200,000 of them. Each record is assigned to the zones whose full-resolution
// outline contains it (zone-polygon-index.ts), then each zone's list is decided with the same
// rules as ensureSeaZoneComputed (sea-zone-checklist.ts) and stored the same way.
//
//   npx tsx src/scripts/compute-sea-zones-offline.ts                  dry run: per-zone counts
//   npx tsx src/scripts/compute-sea-zones-offline.ts --apply          writes every zone
//   ... --zones="North Sea,Red Sea"   only these zones
//   ... --countries=MT,IT             only these downloads (for trying it out; partial counts)
//
// Run fetch-worms-environment.ts first: WoRMS habitats leave freshwater-only species off and let a
// marine species seen only a few times stay when a neighbouring zone has it well recorded. With
// --zones, only the listed zones count as each other's neighbours.
//
// Known differences from the live path:
// - Records with no country code aren't in any country download, so the high-seas parts of the
//   IHO seas only count records GBIF assigned to a country (its EEZ or territorial waters).
// - The downloads keep only records identified to species rank (taxonrank = 'SPECIES'), while the
//   live facet also counts subspecies records under their species.
// - The downloads carry no typeStatus, so the type-specimen-only check can't run.
// - A zone is its full-resolution outline here (every part, islands included), not the 80-point
//   polygon the live path queries, which also takes in coastal land, lagoons and river mouths and
//   leaves out a zone's smaller parts. Freshwater fish recorded just inland drop out as a result,
//   and a species near the five-record line can land on the other side of it.
// - A species' global record count comes from species_traits.occurrence_count (all GBIF records
//   of the taxon, from fetch-occurrence-stats.ts) rather than a live count of present records
//   with a real basis of record, so it is a little higher and flags an outlier slightly sooner.
import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, withTransaction } from "@lifer/core/db.js";
import type { Point } from "@lifer/core/lib/geometry.js";
import { mapWithConcurrency } from "@lifer/core/lib/concurrency.js";
import {
  GEOGRAPHIC_OUTLIER_MAX_LOCAL_RECORDS,
  SEA_ZONE_BASIS_OF_RECORD,
  looksLikeInlandRecords,
} from "@lifer/core/regions/buildRegionSpecies.js";
import { fetchAllCountries } from "@lifer/core/regions/regionBoundary.js";
import { loadIhoFeatures } from "../fetch/fetch-iho-sea-areas.js";
import { loadEezIhoFeatures } from "../fetch/fetch-eez-iho.js";
import { ZonePolygonIndex } from "../build/zone-polygon-index.js";
import { SeaZoneTally, decideZoneChecklist } from "../build/sea-zone-checklist.js";
import { TsvClassFilter } from "../build/tsv-class-filter.js";
import { zoneNeighbours } from "../build/zone-neighbours.js";
import { isFreshwaterOrLandOnly } from "../pipeline/wormsEnvironment.js";

const PIPELINE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ZIP_DIR = path.join(PIPELINE_DIR, "data", "gbif-country-cache");

// Fish as the downloads spell their classes (bony fish are "Teleostei"), as in
// compute-provinces-bulk.ts. Mammalia rows are kept only for the marine mammals below.
const FISH_CLASSES = [
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
];

// The live path takes GBIF's Cetacea and Sirenia (MARINE_MAMMAL_ORDER_KEYS). The catalog files
// many whales and dolphins under the order Artiodactyla, so they're matched by family too.
const MARINE_MAMMAL_ORDERS = ["Cetacea", "Sirenia"];
const MARINE_MAMMAL_FAMILIES = [
  "Balaenidae",
  "Balaenopteridae",
  "Delphinidae",
  "Eschrichtiidae",
  "Iniidae",
  "Kogiidae",
  "Lipotidae",
  "Monodontidae",
  "Neobalaenidae",
  "Phocoenidae",
  "Physeteridae",
  "Platanistidae",
  "Pontoporiidae",
  "Ziphiidae",
  "Dugongidae",
  "Trichechidae",
];

// unzip is the bottleneck (~150 MB/s of CPU each), so several downloads stream at once.
const DEFAULT_CONCURRENCY = Math.max(1, Math.min(6, os.cpus().length - 2));
const COORDINATE_CACHE_LIMIT = 2_000_000;

interface Options {
  apply: boolean;
  zones: string[] | null;
  countries: string[] | null;
  concurrency: number;
}

function parseArgs(argv: string[]): Options {
  const list = (name: string) => {
    const raw = argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
    return raw
      ? raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : null;
  };
  const concurrency = Number(argv.find((a) => a.startsWith("--concurrency="))?.slice(14) ?? DEFAULT_CONCURRENCY);
  return { apply: argv.includes("--apply"), zones: list("zones"), countries: list("countries"), concurrency };
}

// Each part's exterior ring only: an island (a hole in the outline) belongs to the sea around it,
// and fish records on its shore often carry a point on land. With the holes cut out, agreement
// with the live path's lists drops sharply around island-studded seas (Aegean, Andaman).
function exteriorRingsOf(geometry: { type: string; coordinates: unknown } | null): Point[][] {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [(geometry.coordinates as Point[][])[0]];
  if (geometry.type === "MultiPolygon") return (geometry.coordinates as Point[][][]).map((p) => p[0]);
  return [];
}

/** Catalog species id per name, the catalog's own name winning over a synonym, as the province
 *  path matches names. */
async function speciesIdByName(): Promise<Map<string, string>> {
  const res = await pool.query<{ name: string; id: string }>(
    `SELECT DISTINCT ON (n.name) n.name, n.id FROM (
       SELECT scientific_name AS name, id, 0 AS pref FROM species WHERE NOT is_other_taxa
       UNION ALL
       SELECT ss.synonym_name, ss.species_id, 1 FROM species_synonyms ss JOIN species s ON s.id = ss.species_id
        WHERE NOT s.is_other_taxa
     ) n ORDER BY n.name, n.pref`,
  );
  return new Map(res.rows.map((r) => [r.name, r.id]));
}

/** Two-letter codes of countries whose every region has no sea zone: their downloads are skipped. */
async function landlockedIso2(): Promise<Set<string>> {
  const iso2ByIso3 = new Map((await fetchAllCountries()).filter((c) => c.iso2).map((c) => [c.iso3, c.iso2!]));
  const res = await pool.query<{ iso3: string; coastal: boolean }>(
    `SELECT external_codes[1] AS iso3, bool_or(cardinality(nearby_sea_zone_ids) > 0) AS coastal
     FROM regions WHERE external_codes[1] ~ '^[A-Z]{3}$' AND nearby_sea_zone_ids IS NOT NULL GROUP BY 1`,
  );
  return new Set(res.rows.filter((r) => !r.coastal && iso2ByIso3.has(r.iso3)).map((r) => iso2ByIso3.get(r.iso3)!));
}

async function scanZip(
  zipPath: string,
  index: ZonePolygonIndex,
  names: Map<string, string>,
  marineMammals: Set<string>,
  tally: SeaZoneTally,
): Promise<{ rows: number; matched: number }> {
  const proc = spawn("unzip", ["-p", zipPath]);
  let stderr = "";
  proc.stderr.on("data", (chunk) => (stderr += chunk));
  const filter = new TsvClassFilter([...FISH_CLASSES, "Mammalia"]);
  // Sea zones count records cited from literature too (see SEA_ZONE_BASIS_OF_RECORD).
  const realBasis = new Set(SEA_ZONE_BASIS_OF_RECORD);
  const coordinateCache = new Map<string, number[]>();
  let col: Record<string, number> | null = null;
  let rows = 0;
  let matched = 0;
  const handle = (cols: string[]) => {
    col ??= Object.fromEntries(filter.header!.map((h, i) => [h, i]));
    rows++;
    if (!realBasis.has(cols[col.basisofrecord])) return;
    const speciesId = names.get(cols[col.species]);
    if (!speciesId) return;
    if (cols[col.class] === "Mammalia" && !marineMammals.has(speciesId)) return;
    const latRaw = cols[col.decimallatitude];
    const lonRaw = cols[col.decimallongitude];
    const key = `${latRaw},${lonRaw}`;
    let zones = coordinateCache.get(key);
    if (!zones) {
      const lat = Number(latRaw);
      const lon = Number(lonRaw);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      zones = index.zonesContaining(lon, lat);
      if (coordinateCache.size >= COORDINATE_CACHE_LIMIT) coordinateCache.clear();
      coordinateCache.set(key, zones);
    }
    if (zones.length === 0) return;
    matched++;
    const point: Point = [Number(lonRaw), Number(latRaw)];
    const recordCount = Number(cols[col.record_count]) || 1;
    for (const zone of zones) tally.add(zone, speciesId, point, recordCount);
  };
  for await (const chunk of proc.stdout as AsyncIterable<Buffer>) for (const cols of filter.push(chunk)) handle(cols);
  for (const cols of filter.end()) handle(cols);
  const exit = await new Promise<number | null>((resolve) => proc.on("close", resolve));
  // A corrupt zip can print nothing on stdout, which would look like a country with no records.
  if (exit !== 0) throw new Error(`unzip -p ${zipPath} exited ${exit}: ${stderr.trim()}`);
  return { rows, matched };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;

  const zonesRes = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM sea_zones WHERE $1::text[] IS NULL OR name = ANY($1) ORDER BY name`,
    [opts.zones],
  );
  if (opts.zones) {
    const missing = opts.zones.filter((n) => !zonesRes.rows.some((z) => z.name === n));
    if (missing.length > 0) throw new Error(`No sea zone named ${missing.join(", ")}`);
  }

  // Full-resolution outlines from the same cached files replace-sea-zones.ts built the zones from.
  const geometries = new Map<string, { type: string; coordinates: unknown } | null>();
  for (const f of await loadIhoFeatures()) if (f.properties.name) geometries.set(f.properties.name.trim(), f.geometry);
  for (const f of await loadEezIhoFeatures()) {
    if (f.properties.marregion) geometries.set(f.properties.marregion.trim(), f.geometry);
  }
  const zones = zonesRes.rows.filter((z) => {
    if (geometries.has(z.name)) return true;
    console.warn(`[compute-sea-zones-offline] no outline for "${z.name}" in the cached sources, skipped`);
    return false;
  });
  const zoneRings = zones.map((z) => exteriorRingsOf(geometries.get(z.name)!));
  const index = new ZonePolygonIndex(zoneRings.map((rings) => ({ rings })));
  const neighbours = zoneNeighbours(zoneRings);
  zoneRings.length = 0;
  geometries.clear();
  console.log(`[compute-sea-zones-offline] indexed ${zones.length} zone outline(s) (${elapsed()})`);

  const names = await speciesIdByName();
  const marineMammalRes = await pool.query<{ id: string }>(
    `SELECT id FROM species WHERE taxon_order = ANY($1) OR family = ANY($2)`,
    [MARINE_MAMMAL_ORDERS, MARINE_MAMMAL_FAMILIES],
  );
  const marineMammals = new Set(marineMammalRes.rows.map((r) => r.id));

  const landlocked = await landlockedIso2();
  const zips = readdirSync(ZIP_DIR)
    .filter((f) => /^[A-Z]{2}\.zip$/.test(f))
    .map((f) => f.slice(0, 2))
    .filter((iso2) => (opts.countries ? opts.countries.includes(iso2) : !landlocked.has(iso2)))
    // Largest first, so the biggest downloads (US, GB) aren't left running alone at the end.
    .sort((a, b) => statSync(path.join(ZIP_DIR, `${b}.zip`)).size - statSync(path.join(ZIP_DIR, `${a}.zip`)).size);
  console.log(
    `[compute-sea-zones-offline] scanning ${zips.length} download(s), ${opts.concurrency} at a time` +
      (opts.countries ? "" : ` (skipping ${landlocked.size} landlocked)`),
  );

  const tally = new SeaZoneTally();
  let done = 0;
  await mapWithConcurrency(zips, opts.concurrency, async (iso2) => {
    const t = Date.now();
    const { rows, matched } = await scanZip(path.join(ZIP_DIR, `${iso2}.zip`), index, names, marineMammals, tally);
    done++;
    console.log(
      `[compute-sea-zones-offline] ${done}/${zips.length} ${iso2}: ${rows.toLocaleString()} fish/mammal rows, ` +
        `${matched.toLocaleString()} in a zone (${Math.round((Date.now() - t) / 1000)}s, total ${elapsed()})`,
    );
  });

  // The same rule as ensureSeaZoneComputed's highTierNoPhotoGbifKeys.
  const highTierRes = await pool.query<{ id: string }>(
    `SELECT s.id FROM species s LEFT JOIN species_rarity r ON r.species_id = s.id
     WHERE s.reference_photo IS NULL AND r.tier IN ('rare', 'legendary', 'unrated')`,
  );
  const globalRes = await pool.query<{ species_id: string; occurrence_count: string }>(
    `SELECT species_id, occurrence_count FROM species_traits WHERE occurrence_count IS NOT NULL`,
  );
  // WoRMS habitats (fetch-worms-environment.ts): freshwater-only species stay off, and a marine
  // species with only a sliver of its records in a zone stays when a neighbouring zone has it well
  // recorded. Species WoRMS hasn't been asked about follow the record checks alone.
  const wormsRes = await pool.query<{
    species_id: string;
    worms_is_marine: boolean | null;
    worms_is_brackish: boolean | null;
    worms_is_freshwater: boolean | null;
    worms_is_terrestrial: boolean | null;
  }>(
    `SELECT species_id, worms_is_marine, worms_is_brackish, worms_is_freshwater, worms_is_terrestrial
     FROM species_traits WHERE worms_checked_at IS NOT NULL`,
  );
  const freshwaterOnly = new Set<string>();
  const marineOrBrackish = new Set<string>();
  for (const r of wormsRes.rows) {
    const env = {
      marine: r.worms_is_marine,
      brackish: r.worms_is_brackish,
      freshwater: r.worms_is_freshwater,
      terrestrial: r.worms_is_terrestrial,
    };
    if (isFreshwaterOrLandOnly(env)) freshwaterOnly.add(r.species_id);
    if (env.marine === true || env.brackish === true) marineOrBrackish.add(r.species_id);
  }
  if (wormsRes.rows.length === 0) {
    console.warn(
      "[compute-sea-zones-offline] no WoRMS habitats yet: run fetch-worms-environment.ts first for the freshwater and edge-of-range rules",
    );
  }
  const baseInputs = {
    highTierNoPhoto: new Set(highTierRes.rows.map((r) => r.id)),
    globalCount: new Map(globalRes.rows.map((r) => [r.species_id, Number(r.occurrence_count)])),
    looksInland: (points: Point[]) =>
      looksLikeInlandRecords(points.map((point) => ({ locality: null, typeStatus: null, point }))),
    freshwaterOnly,
    marineOrBrackish,
  };

  let speciesRows = 0;
  const empty: string[] = [];
  for (const [zi, zone] of zones.entries()) {
    const establishedNearby = (speciesId: string) =>
      [...(neighbours.get(zi) ?? [])].some(
        (nz) => (tally.byZone.get(nz)?.get(speciesId)?.recordCount ?? 0) > GEOGRAPHIC_OUTLIER_MAX_LOCAL_RECORDS,
      );
    const checklist = await decideZoneChecklist(tally.byZone.get(zi) ?? new Map(), {
      ...baseInputs,
      establishedNearby,
    });
    speciesRows += checklist.length;
    if (checklist.length === 0) empty.push(zone.name);
    const candidates = tally.byZone.get(zi)?.size ?? 0;
    console.log(`  ${zone.name}\t${checklist.length} species (${candidates} candidates)`);
    if (!opts.apply) continue;
    await withTransaction(
      async (client) => {
        await client.query(`DELETE FROM sea_zone_species WHERE sea_zone_id = $1`, [zone.id]);
        await client.query(
          `INSERT INTO sea_zone_species (sea_zone_id, species_id, record_count)
           SELECT $1, unnest($2::uuid[]), unnest($3::int[])`,
          [zone.id, checklist.map((c) => c.speciesId), checklist.map((c) => c.recordCount)],
        );
        await client.query(`UPDATE sea_zones SET occurrence_computed_at = now() WHERE id = $1`, [zone.id]);
      },
      { lockReferenceData: true },
    );
  }
  console.log(
    `[compute-sea-zones-offline] ${zones.length} zone(s), ${speciesRows.toLocaleString()} species rows, ` +
      `${empty.length} empty${empty.length > 0 && empty.length <= 30 ? ` (${empty.join(", ")})` : ""}. ` +
      `${opts.apply ? "Written" : "Dry run, nothing written; rerun with --apply"} (${elapsed()})`,
  );
  // maxRSS is in kilobytes.
  console.log(`[compute-sea-zones-offline] peak memory ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
