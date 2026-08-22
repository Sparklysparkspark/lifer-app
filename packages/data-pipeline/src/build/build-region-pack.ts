// Bundles one region's already-enriched reference photos + habitat descriptions into a single
// downloadable archive hosted on GitHub, so every self-hosted Lifer install can pull ONE
// canonical pack instead of each independently re-hitting iNaturalist/Wikipedia for the same
// species. Meant to be run by hand, occasionally, as enrich-all-species.ts covers more
// species — not something a self-hosted install runs itself.
//
// Species are keyed by scientific_name in the pack, never by species.id — every install seeds
// its own species table with a fresh gen_random_uuid() per row, even from the same source
// data, so a pack's contents can only ever be matched back up by name (the same cross-install
// identity problem the desktop-to-server migration feature has to handle).
//
// A sea zone (e.g. the Red Sea) is its OWN separate, standalone pack (see --sea-zone below),
// never embedded inside a country pack, so that a country's download can include the nearby
// sea zones its fish may reference without duplicating that data across multiple countries. A
// country pack's manifest just lists which sea zone packs are relevant (seaZoneDependencies)
// so the client knows to also fetch those — once, shared across every neighboring country that
// references the same zone, not re-downloaded per country.
//
// --taxon scopes a build to one taxon class, producing a separate, independently downloadable
// file per group, so installs can download fish, mammals, or birds by themselves or as a
// group; omit it to build every taxon together.
//
// Usage:
//   npm run build-region-pack -w data-pipeline -- "Canada" [outputDir] [--taxon=aves|mammalia|actinopterygii]
//   npm run build-region-pack -w data-pipeline -- --sea-zone "Red Sea" [outputDir]
import { existsSync, mkdirSync, writeFileSync, copyFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import { pool } from "../db.js";
import { bboxesNear, minRingDistance, exteriorRingsFromGeometry, parseWktPolygonRing, type BoundingBox } from "../geometry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");

// Same constants/logic as regions/routes.ts's own nearbyZones — duplicated rather than
// imported since that lives in apps/api, which data-pipeline scripts don't depend on
// (data-pipeline is the lower layer; apps/api imports FROM it, never the reverse).
const BBOX_PREFILTER_BUFFER_DEGREES = 10;
const NEARBY_MAX_DISTANCE_DEGREES = 2;

const TAXON_CLASSES = ["aves", "mammalia", "actinopterygii"] as const;
type TaxonClass = (typeof TAXON_CLASSES)[number];

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

interface ManifestSpecies {
  scientificName: string;
  commonName: string | null;
  habitatDescription: string | null;
  referenceCredit: string | null;
  referenceLicense: string | null;
  displayFile: string | null;
  thumbFile: string | null;
}

interface SpeciesRow {
  scientific_name: string;
  common_name: string | null;
  habitat_description: string | null;
  reference_display_path: string | null;
  reference_thumb_path: string | null;
  reference_credit: string | null;
  reference_license: string | null;
}

async function nearbyZonesForRegion(boundaryGeoJson: {
  bbox?: [number, number, number, number];
  geometry?: { type: string; coordinates: unknown };
} | null): Promise<Array<{ id: string; name: string }>> {
  const bbox = boundaryGeoJson?.bbox;
  const geometry = boundaryGeoJson?.geometry;
  if (!bbox || !geometry) return [];
  const regionBbox: BoundingBox = { minLon: bbox[0], minLat: bbox[1], maxLon: bbox[2], maxLat: bbox[3] };
  const regionRings = exteriorRingsFromGeometry(geometry);

  const zonesRes = await pool.query<{
    id: string;
    name: string;
    wkt: string;
    bbox_min_lon: number;
    bbox_min_lat: number;
    bbox_max_lon: number;
    bbox_max_lat: number;
  }>(`SELECT id, name, wkt, bbox_min_lon, bbox_min_lat, bbox_max_lon, bbox_max_lat FROM sea_zones`);

  return zonesRes.rows
    .filter((z) =>
      bboxesNear(
        regionBbox,
        { minLon: z.bbox_min_lon, minLat: z.bbox_min_lat, maxLon: z.bbox_max_lon, maxLat: z.bbox_max_lat },
        BBOX_PREFILTER_BUFFER_DEGREES,
      ),
    )
    .filter((z) => minRingDistance(regionRings, [parseWktPolygonRing(z.wkt)]) <= NEARBY_MAX_DISTANCE_DEGREES)
    .map((z) => ({ id: z.id, name: z.name }));
}

function packSpecies(stagingDir: string, rows: SpeciesRow[]): { manifestSpecies: ManifestSpecies[]; photoCount: number } {
  const manifestSpecies: ManifestSpecies[] = [];
  let photoCount = 0;
  for (const row of rows) {
    // Nothing worth shipping for a species that enriched to nothing (no photo found, no
    // habitat blurb either) — skip rather than pad the pack with empty entries.
    if (!row.habitat_description && !row.reference_display_path) continue;

    const key = sanitize(row.scientific_name);
    let displayFile: string | null = null;
    let thumbFile: string | null = null;
    if (row.reference_display_path && existsSync(row.reference_display_path)) {
      displayFile = `photos/${key}.display.webp`;
      copyFileSync(row.reference_display_path, path.join(stagingDir, displayFile));
      photoCount++;
    }
    if (row.reference_thumb_path && existsSync(row.reference_thumb_path)) {
      thumbFile = `photos/${key}.thumb.webp`;
      copyFileSync(row.reference_thumb_path, path.join(stagingDir, thumbFile));
    }

    manifestSpecies.push({
      scientificName: row.scientific_name,
      commonName: row.common_name,
      habitatDescription: row.habitat_description,
      referenceCredit: row.reference_credit,
      referenceLicense: row.reference_license,
      displayFile,
      thumbFile,
    });
  }
  return { manifestSpecies, photoCount };
}

async function writeArchive(stagingDir: string, outDir: string, archiveName: string): Promise<number> {
  mkdirSync(outDir, { recursive: true });
  const archivePath = path.join(outDir, archiveName);
  await tar.create({ gzip: true, file: archivePath, cwd: stagingDir }, ["manifest.json", "photos"]);
  rmSync(stagingDir, { recursive: true, force: true });
  return statSync(archivePath).size;
}

async function buildSeaZonePack(zoneName: string, outDir: string): Promise<void> {
  const zoneRes = await pool.query<{ id: string }>(`SELECT id FROM sea_zones WHERE name = $1`, [zoneName]);
  const zone = zoneRes.rows[0];
  if (!zone) {
    console.error(`No sea zone named "${zoneName}"`);
    process.exit(1);
  }

  const speciesRes = await pool.query<SpeciesRow>(
    `SELECT s.scientific_name, s.common_name, s.habitat_description,
            s.reference_display_path, s.reference_thumb_path, s.reference_credit, s.reference_license
     FROM sea_zone_species zs
     JOIN species s ON s.id = zs.species_id
     WHERE zs.sea_zone_id = $1 AND s.enriched_at IS NOT NULL
     ORDER BY s.scientific_name`,
    [zone.id],
  );

  const stagingDir = path.join(outDir, `.staging-seazone-${sanitize(zoneName)}`);
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(path.join(stagingDir, "photos"), { recursive: true });

  const { manifestSpecies, photoCount } = packSpecies(stagingDir, speciesRes.rows);
  const manifest = {
    type: "seaZone",
    seaZone: zoneName,
    generatedAt: new Date().toISOString(),
    speciesCount: manifestSpecies.length,
    species: manifestSpecies,
  };
  writeFileSync(path.join(stagingDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  const archiveName = `seazone-${sanitize(zoneName).toLowerCase()}.pack.tar.gz`;
  const sizeMb = (await writeArchive(stagingDir, outDir, archiveName)) / 1024 / 1024;
  console.log(`[build-region-pack] sea zone "${zoneName}": ${manifestSpecies.length} species (${photoCount} with photos)`);
  console.log(`[build-region-pack] wrote ${path.join(outDir, archiveName)} (${sizeMb.toFixed(1)} MB)`);
}

async function buildRegionPack(regionName: string, outDir: string, taxon: TaxonClass | null): Promise<void> {
  const regionRes = await pool.query<{ id: string; boundary_geojson: unknown }>(
    `SELECT id, boundary_geojson FROM regions WHERE name = $1`,
    [regionName],
  );
  const region = regionRes.rows[0];
  if (!region) {
    console.error(`No region named "${regionName}"`);
    process.exit(1);
  }

  const taxonFilter = taxon ? `AND s.taxon_class = '${taxon}'` : "";
  const speciesRes = await pool.query<SpeciesRow>(
    `SELECT s.scientific_name, s.common_name, s.habitat_description,
            s.reference_display_path, s.reference_thumb_path, s.reference_credit, s.reference_license
     FROM region_species rs
     JOIN species s ON s.id = rs.species_id
     WHERE rs.region_id = $1 AND s.enriched_at IS NOT NULL ${taxonFilter}
     ORDER BY s.scientific_name`,
    [region.id],
  );

  // Only fish ever reference a sea zone — sea_zone_species is populated exclusively from fish
  // taxon keys — so this is skipped entirely for a birds/mammals-only build rather than
  // computing zones nobody asked for.
  const includeSeaZones = taxon === null || taxon === "actinopterygii";
  const seaZones = includeSeaZones
    ? await nearbyZonesForRegion(region.boundary_geojson as Parameters<typeof nearbyZonesForRegion>[0])
    : [];

  const suffix = taxon ? `-${taxon === "actinopterygii" ? "fish" : taxon === "aves" ? "birds" : "mammals"}` : "";
  const stagingDir = path.join(outDir, `.staging-${sanitize(regionName)}${suffix}`);
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(path.join(stagingDir, "photos"), { recursive: true });

  const { manifestSpecies, photoCount } = packSpecies(stagingDir, speciesRes.rows);
  const manifest = {
    type: "region",
    region: regionName,
    taxon,
    generatedAt: new Date().toISOString(),
    speciesCount: manifestSpecies.length,
    species: manifestSpecies,
    // The client downloads each of these SEPARATELY (and only once, however many of this
    // region's neighbors also depend on it) — see this file's own top comment.
    seaZoneDependencies: seaZones.map((z) => ({ name: z.name, packFile: `seazone-${sanitize(z.name).toLowerCase()}.pack.tar.gz` })),
  };
  writeFileSync(path.join(stagingDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  const archiveName = `${sanitize(regionName).toLowerCase()}${suffix}.pack.tar.gz`;
  const sizeMb = (await writeArchive(stagingDir, outDir, archiveName)) / 1024 / 1024;
  console.log(
    `[build-region-pack] ${regionName}${suffix}: ${manifestSpecies.length} species (${photoCount} with photos) of ${speciesRes.rows.length} enriched` +
      (seaZones.length > 0 ? `, depends on sea zone pack(s): ${seaZones.map((z) => z.name).join(", ")}` : ""),
  );
  console.log(`[build-region-pack] wrote ${path.join(outDir, archiveName)} (${sizeMb.toFixed(1)} MB)`);
}

async function main() {
  const args = process.argv.slice(2);
  const taxonArg = args.find((a) => a.startsWith("--taxon="))?.slice("--taxon=".length) ?? null;
  if (taxonArg && !TAXON_CLASSES.includes(taxonArg as TaxonClass)) {
    console.error(`--taxon must be one of: ${TAXON_CLASSES.join(", ")}`);
    process.exit(1);
  }
  const seaZoneMode = args.includes("--sea-zone");
  const positional = args.filter((a) => !a.startsWith("--"));
  const name = positional[0];
  const outDir = positional[1] ?? path.join(REPO_ROOT, "packs");

  if (!name) {
    console.error(
      "Usage: npm run build-region-pack -w data-pipeline -- <region name> [outputDir] [--taxon=aves|mammalia|actinopterygii]\n" +
        "   or: npm run build-region-pack -w data-pipeline -- --sea-zone <sea zone name> [outputDir]",
    );
    process.exit(1);
  }

  if (seaZoneMode) {
    await buildSeaZonePack(name, outDir);
  } else {
    await buildRegionPack(name, outDir, taxonArg as TaxonClass | null);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
