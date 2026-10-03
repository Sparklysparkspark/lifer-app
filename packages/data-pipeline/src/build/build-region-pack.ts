// Builds one region's offline pack: its checklist (and its provinces'), habitat descriptions and
// photo credits in a single archive. Photos are in the shared photo store (pipeline/photoStore.ts)
// and vectors in the catalog seed, so the archive carries neither.
//
// Species are keyed by scientific_name, never species.id: every install generates its own ids.
//
// A sea zone is its own standalone pack (--sea-zone), which neighbouring country packs list as a
// dependency instead of embedding. --taxon scopes a build (country or sea zone) to one taxon
// class (see TAXON_CLASSES), one file per group; omit it to build every taxon together.
//
// Usage:
//   npm run build-region-pack -w data-pipeline -- "Canada" [outputDir] [--taxon=<TaxonClass>]
//   npm run build-region-pack -w data-pipeline -- --sea-zone "Red Sea" [outputDir] [--taxon=<TaxonClass>]
import { existsSync, mkdirSync, writeFileSync, rmSync, statSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import { pool } from "../db.js";
import {
  bboxesNear,
  bboxContains,
  bboxDiagonalDegrees,
  SMALL_ISLAND_MAX_BBOX_DIAGONAL_DEGREES,
  minRingDistance,
  exteriorRingsFromGeometry,
  parseWktPolygonRing,
  type BoundingBox,
} from "../geometry.js";
import { sanitize, regionPackFileName, seaZonePackFileName, type PackVariant } from "./pack-id.js";

// A manifest must stay well under V8's ~512MB string limit, since both the builder and the app
// serialize it in one piece. Province-level hotspot clusters grow without bound, so an
// over-budget pack keeps each species' largest clusters per province, trying tighter caps until
// it fits. Packs under budget are untouched.
const MANIFEST_BUDGET_BYTES = 350 * 1024 * 1024;
const HOTSPOT_CAPS = [100, 50, 25, 10];

function fitHotspotsToBudget(topSpecies: ManifestSpecies[], children: ManifestChildRegion[], regionName: string): void {
  const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v) ?? "");
  const hotspotBytes = () => children.reduce((n, c) => n + c.species.reduce((m, sp) => m + bytes(sp.hotspots ?? null), 0), 0);
  const otherBytes =
    bytes(topSpecies) +
    children.reduce((n, c) => n + bytes({ ...c, species: c.species.map((sp) => ({ ...sp, hotspots: undefined })) }), 0);
  if (otherBytes + hotspotBytes() <= MANIFEST_BUDGET_BYTES) return;
  for (const cap of HOTSPOT_CAPS) {
    for (const c of children) {
      for (const sp of c.species) {
        if (sp.hotspots && sp.hotspots.length > cap) {
          sp.hotspots = [...sp.hotspots].sort((a, b) => b.pointCount - a.pointCount || (b.lastSeenYear ?? 0) - (a.lastSeenYear ?? 0)).slice(0, cap);
        }
      }
    }
    if (otherBytes + hotspotBytes() <= MANIFEST_BUDGET_BYTES) {
      console.log(`[build-region-pack] ${regionName}: kept the ${cap} largest hotspot clusters per species per province to fit the manifest budget`);
      return;
    }
  }
  // Still too big: contentHash's describeManifestSize says what's left.
}

// Says which part of a manifest pushed it past V8's string limit, instead of a bare RangeError.
function describeManifestSize(core: { species: unknown[]; children?: Array<{ name: string; species: unknown[]; boundaryGeoJson?: unknown }> }): string {
  const mb = (v: unknown) => (Buffer.byteLength(JSON.stringify(v) ?? "") / 1e6).toFixed(1);
  const kids = core.children ?? [];
  const perField: Record<string, number> = {};
  for (const c of kids) {
    for (const sp of c.species as Array<Record<string, unknown>>) {
      for (const [k, v] of Object.entries(sp)) perField[k] = (perField[k] ?? 0) + Buffer.byteLength(JSON.stringify(v) ?? "");
    }
  }
  const top = Object.entries(perField).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${(v / 1e6).toFixed(0)}MB`);
  const boundaries = kids.reduce((n, c) => n + Buffer.byteLength(JSON.stringify(c.boundaryGeoJson) ?? ""), 0);
  return `top-level species ${mb(core.species)}MB; ${kids.length} child regions, boundaries ${(boundaries / 1e6).toFixed(0)}MB, species fields: ${top.join(", ")}`;
}

function contentHash(manifestCore: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(manifestCore);
  } catch (err) {
    if (err instanceof RangeError) {
      throw new RangeError(`Pack manifest is too large to serialize: ${describeManifestSize(manifestCore as Parameters<typeof describeManifestSize>[0])}`);
    }
    throw err;
  }
  return createHash("sha256").update(json).digest("hex");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");

// Same constants/logic as regions/routes.ts's nearbyZones, duplicated because data-pipeline
// must not depend on apps/api.
const BBOX_PREFILTER_BUFFER_DEGREES = 10;
const NEARBY_MAX_DISTANCE_DEGREES = 2;

// Mirrors packages/shared/src/species.ts's TaxonClass, kept local like the nearbyZones constants.
const TAXON_CLASSES = [
  "aves",
  "mammalia",
  "actinopterygii",
  "elasmobranchii",
  "aquatic_mammalia",
  "amphibia",
  "squamata",
  "testudines",
  "corals",
  "jellies_and_anemones",
  "echinodermata",
  "nudibranchs",
  "marine_mollusks",
  "cephalopoda",
  "crustacea",
  "sponges_tunicates_other",
] as const;
type TaxonClass = (typeof TAXON_CLASSES)[number];

// Only these taxa have sea_zone_species data (see regions/routes.ts's ensureSeaZoneComputed).
const TAXA_WITH_SEA_ZONE_DATA: readonly TaxonClass[] = ["actinopterygii", "elasmobranchii", "aquatic_mammalia"];

interface ManifestSpecies {
  scientificName: string;
  commonName: string | null;
  habitatDescription: string | null;
  referenceCredit: string | null;
  referenceLicense: string | null;
  // Always null: the photo files come from the photo store.
  displayFile: null;
  thumbFile: null;
  // The reference-photo gallery's credits and focal points (species_reference_photos). Omitted
  // for a species with no gallery photos.
  gallery?: Array<{
    photoUrl: string;
    credit: string;
    license: string;
    sortOrder: number;
    focalX: number | null;
    focalY: number | null;
    displayFile: null;
    thumbFile: null;
  }>;
  // Checklist membership, so an install can populate a region's checklist from the pack alone
  // (see offlinePacks/routes.ts's applyPack). Sea-zone packs carry only recordCount.
  localFrequency?: number | null;
  seasonality?: number[] | null;
  localTier?: string | null;
  isVagrant?: boolean;
  recordCount?: number;
  weeklyFrequency?: number[] | null;
  // Gap-finder hotspot clusters (migration 074), province-level only (see
  // compute-provinces-bulk.ts). Omitted for a country's top-level list and sea-zone packs.
  hotspots?: Array<{
    centroidLat: number;
    centroidLon: number;
    pointCount: number;
    bboxDiagonalKm: number;
    lastSeenYear: number | null;
    distinctYears: number | null;
  }>;
}

interface SpeciesRow {
  id: string;
  scientific_name: string;
  common_name: string | null;
  habitat_description: string | null;
  reference_display_path: string | null;
  reference_thumb_path: string | null;
  reference_credit: string | null;
  reference_license: string | null;
  local_frequency?: string | null;
  seasonality?: number[] | null;
  local_tier?: string | null;
  is_vagrant?: boolean;
  record_count?: number;
  weekly_frequency?: number[] | null;
  tier_reason?: string | null;
  tier_explain?: unknown;
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
    .filter((z) => {
      // Same bbox-containment bypass as apps/api/src/regions/routes.ts's nearbyZones: an island's
      // bbox inside a zone's bbox counts even when the simplified polygon edge sits just past the
      // distance cutoff. Island-scale regions only (see bboxContains).
      const zoneBbox: BoundingBox = { minLon: z.bbox_min_lon, minLat: z.bbox_min_lat, maxLon: z.bbox_max_lon, maxLat: z.bbox_max_lat };
      if (bboxDiagonalDegrees(regionBbox) <= SMALL_ISLAND_MAX_BBOX_DIAGONAL_DEGREES && bboxContains(zoneBbox, regionBbox)) {
        return true;
      }
      return minRingDistance(regionRings, [parseWktPolygonRing(z.wkt)]) <= NEARBY_MAX_DISTANCE_DEGREES;
    })
    .map((z) => ({ id: z.id, name: z.name }));
}

interface GalleryPhotoRaw {
  photoUrl: string;
  credit: string;
  license: string;
  sortOrder: number;
  focalX: number | null;
  focalY: number | null;
  displayPath: string | null;
  thumbPath: string | null;
}

// Batch-fetched once per call site and matched onto rows by scientific_name.
async function fetchGallery(speciesIds: string[]): Promise<Map<string, GalleryPhotoRaw[]>> {
  const galleryByScientificName = new Map<string, GalleryPhotoRaw[]>();
  const galleryRes = await pool.query<{
    scientific_name: string;
    photo_url: string;
    credit: string;
    license: string;
    sort_order: number;
    focal_x: string | null;
    focal_y: string | null;
    display_path: string | null;
    thumb_path: string | null;
  }>(
    `SELECT s.scientific_name, p.photo_url, p.credit, p.license, p.sort_order, p.focal_x, p.focal_y, p.display_path, p.thumb_path
     FROM species_reference_photos p
     JOIN species s ON s.id = p.species_id
     WHERE p.species_id = ANY($1)
     ORDER BY p.species_id, p.sort_order`,
    [speciesIds],
  );
  for (const row of galleryRes.rows) {
    if (!galleryByScientificName.has(row.scientific_name)) galleryByScientificName.set(row.scientific_name, []);
    galleryByScientificName.get(row.scientific_name)!.push({
      photoUrl: row.photo_url,
      credit: row.credit,
      license: row.license,
      sortOrder: row.sort_order,
      focalX: row.focal_x != null ? Number(row.focal_x) : null,
      focalY: row.focal_y != null ? Number(row.focal_y) : null,
      displayPath: row.display_path,
      thumbPath: row.thumb_path,
    });
  }
  return galleryByScientificName;
}

function packSpecies(
  rows: SpeciesRow[],
  hotspotsByScientificName?: Map<string, ManifestSpecies["hotspots"]>,
  galleryByScientificName?: Map<string, GalleryPhotoRaw[]>,
): { manifestSpecies: ManifestSpecies[]; photoCount: number; galleryPhotoCount: number } {
  const manifestSpecies: ManifestSpecies[] = [];
  let photoCount = 0;
  let galleryPhotoCount = 0;
  // Photos the database says are cached but whose file is missing, reported rather than skipped silently.
  const missingFiles: string[] = [];
  const present = (p: string | null): p is string => {
    if (!p) return false;
    if (existsSync(p)) return true;
    missingFiles.push(p);
    return false;
  };
  for (const row of rows) {
    // Every checklist member ships, enriched or not: the pack is the only source of checklist
    // membership for an install. Photos live in the shared photo store (pipeline/photoStore.ts),
    // not the pack; this only checks they're on disk.
    if (present(row.reference_display_path)) photoCount++;
    present(row.reference_thumb_path);

    const gallery: ManifestSpecies["gallery"] = [];
    for (const g of galleryByScientificName?.get(row.scientific_name) ?? []) {
      if (present(g.displayPath)) galleryPhotoCount++;
      present(g.thumbPath);
      gallery.push({
        photoUrl: g.photoUrl,
        credit: g.credit,
        license: g.license,
        sortOrder: g.sortOrder,
        focalX: g.focalX,
        focalY: g.focalY,
        displayFile: null,
        thumbFile: null,
      });
    }

    manifestSpecies.push({
      scientificName: row.scientific_name,
      commonName: row.common_name,
      habitatDescription: row.habitat_description,
      referenceCredit: row.reference_credit,
      referenceLicense: row.reference_license,
      displayFile: null,
      thumbFile: null,
      ...(gallery.length > 0 && { gallery }),
      ...(row.local_frequency !== undefined && { localFrequency: row.local_frequency != null ? Number(row.local_frequency) : null }),
      ...(row.seasonality !== undefined && { seasonality: row.seasonality }),
      ...(row.local_tier !== undefined && { localTier: row.local_tier }),
      ...(row.is_vagrant !== undefined && { isVagrant: row.is_vagrant }),
      ...(row.record_count !== undefined && { recordCount: row.record_count }),
      ...(row.weekly_frequency !== undefined && { weeklyFrequency: row.weekly_frequency }),
      // Why the tier is what it is (or why there's none), shown when the tier is tapped.
      ...(row.tier_reason != null && { tierReason: row.tier_reason }),
      ...(row.tier_explain != null && { tierExplain: row.tier_explain }),
      ...(hotspotsByScientificName?.has(row.scientific_name) && {
        hotspots: hotspotsByScientificName.get(row.scientific_name),
      }),
    });
  }
  if (missingFiles.length > 0 && process.env.ALLOW_MISSING_PHOTOS !== "1") {
    throw new Error(
      `${missingFiles.length} cached photo file(s) are missing (e.g. ${missingFiles.slice(0, 3).join(", ")}). ` +
        `Run apps/api/src/scripts/repair-missing-reference-photos.ts, or set ALLOW_MISSING_PHOTOS=1 to build without them.`,
    );
  }
  return { manifestSpecies, photoCount, galleryPhotoCount };
}

// Uncompressed byte counts for photos vs. checklist JSON. The archive is one gzip stream, so
// this is an estimate of relative weight, enough for OfflinePacksPage's offload-impact UI.
function photoBytesInStaging(stagingDir: string): number {
  const photosDir = path.join(stagingDir, "photos");
  if (!existsSync(photosDir)) return 0;
  return readdirSync(photosDir).reduce((sum, file) => sum + statSync(path.join(photosDir, file)).size, 0);
}

async function writeArchive(stagingDir: string, outDir: string, archiveName: string): Promise<number> {
  mkdirSync(outDir, { recursive: true });
  const archivePath = path.join(outDir, archiveName);
  await tar.create({ gzip: true, file: archivePath, cwd: stagingDir }, ["manifest.json", "photos"]);
  rmSync(stagingDir, { recursive: true, force: true });
  return statSync(archivePath).size;
}

export interface BuiltPack {
  fileName: string;
  speciesCount: number;
}

export async function buildSeaZonePack(zoneName: string, outDir: string, taxon: TaxonClass | null, variant: PackVariant = "full"): Promise<BuiltPack | null> {
  const zoneRes = await pool.query<{ id: string }>(`SELECT id FROM sea_zones WHERE name = $1`, [zoneName]);
  const zone = zoneRes.rows[0];
  if (!zone) throw new Error(`No sea zone named "${zoneName}"`);

  const taxonFilter = taxon ? `AND s.taxon_class = '${taxon}'` : "";
  const speciesRes = await pool.query<SpeciesRow>(
    `SELECT s.id, s.scientific_name, s.common_name, s.habitat_description,
            s.reference_display_path, s.reference_thumb_path, s.reference_credit, s.reference_license,
            zs.record_count
     FROM sea_zone_species zs
     JOIN species s ON s.id = zs.species_id
     WHERE zs.sea_zone_id = $1 AND NOT s.is_other_taxa ${taxonFilter}
     ORDER BY s.scientific_name`,
    [zone.id],
  );

  // Same empty-archive guard as buildRegionPack's taxon-scoped check: most sea zones carry only fish.
  if (taxon !== null && speciesRes.rows.length === 0) {
    console.log(`[build-region-pack] sea zone "${zoneName}"-${taxon}: 0 species, skipping`);
    return null;
  }

  const suffix = taxon ? `-${taxon}` : "";
  const variantSuffix = variant === "small" ? "-small" : "";
  const stagingDir = path.join(outDir, `.staging-seazone-${sanitize(zoneName)}${suffix}${variantSuffix}`);
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(path.join(stagingDir, "photos"), { recursive: true });

  const { manifestSpecies, photoCount } = packSpecies(speciesRes.rows, undefined, await fetchGallery(speciesRes.rows.map((r) => r.id)));
  const manifestCore = {
    type: "seaZone",
    seaZone: zoneName,
    taxon,
    variant,
    speciesCount: manifestSpecies.length,
    species: manifestSpecies,
  };
  const manifest = {
    ...manifestCore,
    generatedAt: new Date().toISOString(),
    contentVersion: contentHash(manifestCore),
    photoBytes: photoBytesInStaging(stagingDir),
    checklistBytes: Buffer.byteLength(JSON.stringify(manifestCore)),
  };
  // Compact, not pretty-printed: indenting can push a large manifest past V8's string limit.
  writeFileSync(path.join(stagingDir, "manifest.json"), JSON.stringify(manifest));

  const archiveName = seaZonePackFileName(zoneName, taxon, variant);
  const sizeMb = (await writeArchive(stagingDir, outDir, archiveName)) / 1024 / 1024;
  console.log(`[build-region-pack] sea zone "${zoneName}"${suffix}: ${manifestSpecies.length} species (${photoCount} with photos)`);
  console.log(`[build-region-pack] wrote ${path.join(outDir, archiveName)} (${sizeMb.toFixed(1)} MB)`);
  return { fileName: archiveName, speciesCount: manifestSpecies.length };
}

interface ManifestChildRegion {
  name: string;
  ebirdRegionCode: string | null;
  boundaryGeoJson: unknown;
  externalCodes: string[];
  species: ManifestSpecies[];
  isOverseasTerritory: boolean;
}

// A country pack also carries its provinces' region records and checklists, since an install
// has no other way to create them. Only computed provinces (occurrence_computed_at set) are included.
async function fetchChildRegionsWithSpecies(parentId: string, taxonFilter: string): Promise<ManifestChildRegion[]> {
  const childrenRes = await pool.query<{
    id: string;
    name: string;
    ebird_region_code: string | null;
    boundary_geojson: unknown;
    external_codes: string[];
    is_overseas_territory: boolean;
  }>(
    `SELECT id, name, ebird_region_code, boundary_geojson, external_codes, is_overseas_territory
     FROM regions WHERE parent_id = $1 AND occurrence_computed_at IS NOT NULL ORDER BY name`,
    [parentId],
  );

  const children: ManifestChildRegion[] = [];
  for (const child of childrenRes.rows) {
    const childSpeciesRes = await pool.query<SpeciesRow>(
      `SELECT s.id, s.scientific_name, s.common_name, s.habitat_description,
              s.reference_display_path, s.reference_thumb_path, s.reference_credit, s.reference_license,
              rs.local_frequency, rs.seasonality, rs.local_tier, rs.is_vagrant, rs.weekly_frequency, rs.tier_reason, rs.tier_explain
       FROM region_species rs
       JOIN species s ON s.id = rs.species_id
       WHERE rs.region_id = $1 AND NOT s.is_other_taxa ${taxonFilter}
       ORDER BY s.scientific_name`,
      [child.id],
    );
    // Hotspot clusters only exist at province level, matched onto species by scientific_name.
    const hotspotsRes = await pool.query<{
      scientific_name: string;
      centroid_lat: number;
      centroid_lon: number;
      point_count: number;
      bbox_diagonal_km: number;
      last_seen_year: number | null;
      distinct_years: number | null;
    }>(
      `SELECT s.scientific_name, h.centroid_lat, h.centroid_lon, h.point_count, h.bbox_diagonal_km,
              h.last_seen_year, h.distinct_years
       FROM region_species_hotspots h
       JOIN species s ON s.id = h.species_id
       WHERE h.region_id = $1`,
      [child.id],
    );
    const hotspotsByScientificName = new Map<string, ManifestSpecies["hotspots"]>();
    for (const h of hotspotsRes.rows) {
      if (!hotspotsByScientificName.has(h.scientific_name)) hotspotsByScientificName.set(h.scientific_name, []);
      hotspotsByScientificName.get(h.scientific_name)!.push({
        centroidLat: h.centroid_lat,
        centroidLon: h.centroid_lon,
        pointCount: h.point_count,
        bboxDiagonalKm: h.bbox_diagonal_km,
        lastSeenYear: h.last_seen_year,
        distinctYears: h.distinct_years,
      });
    }
    const { manifestSpecies } = packSpecies(childSpeciesRes.rows, hotspotsByScientificName, await fetchGallery(childSpeciesRes.rows.map((r) => r.id)));
    children.push({
      name: child.name,
      ebirdRegionCode: child.ebird_region_code,
      boundaryGeoJson: child.boundary_geojson,
      externalCodes: child.external_codes,
      species: manifestSpecies,
      isOverseasTerritory: child.is_overseas_territory,
    });
  }
  return children;
}

export async function buildRegionPack(
  regionName: string,
  outDir: string,
  taxon: TaxonClass | null,
  variant: PackVariant = "full",
  opts: {
    // Region names repeat (a Georgia country and a Georgia state), so callers that know the id pass it.
    regionId?: string;
    // Only sea zone packs that will actually be built are listed as dependencies.
    seaZonePackAvailable?: (fileName: string) => boolean;
  } = {},
): Promise<BuiltPack | null> {
  const regionRes = await pool.query<{ id: string; boundary_geojson: unknown }>(
    opts.regionId ? `SELECT id, boundary_geojson FROM regions WHERE id = $1` : `SELECT id, boundary_geojson FROM regions WHERE name = $1`,
    [opts.regionId ?? regionName],
  );
  const region = regionRes.rows[0];
  if (!region) throw new Error(`No region named "${regionName}"`);

  const taxonFilter = taxon ? `AND s.taxon_class = '${taxon}'` : "";
  const speciesRes = await pool.query<SpeciesRow>(
    `SELECT s.id, s.scientific_name, s.common_name, s.habitat_description,
            s.reference_display_path, s.reference_thumb_path, s.reference_credit, s.reference_license,
            rs.local_frequency, rs.seasonality, rs.local_tier, rs.is_vagrant, rs.weekly_frequency, rs.tier_reason, rs.tier_explain
     FROM region_species rs
     JOIN species s ON s.id = rs.species_id
     WHERE rs.region_id = $1 AND NOT s.is_other_taxa ${taxonFilter}
     ORDER BY s.scientific_name`,
    [region.id],
  );

  // A taxon-scoped build often has nothing to ship, so skip writing an empty archive. An
  // "all taxa" build always writes.
  if (taxon !== null && speciesRes.rows.length === 0) {
    // A country with an empty list for this taxon while its provinces list species is a broken
    // roll-up, not a country without the taxon, so refuse instead of skipping.
    const onProvinces = await pool.query<{ n: string }>(
      `SELECT count(DISTINCT rs.species_id) AS n FROM region_species rs JOIN regions r ON r.id = rs.region_id JOIN species s ON s.id = rs.species_id
       WHERE r.parent_id = $1 AND NOT s.is_other_taxa ${taxonFilter}`,
      [region.id],
    );
    const n = Number(onProvinces.rows[0].n);
    if (n > 0) throw new Error(`${regionName}-${taxon}: the country's own list is empty but its provinces list ${n} species; rebuild its country list first`);
    console.log(`[build-region-pack] ${regionName}-${taxon}: 0 species, skipping`);
    return null;
  }

  // See TAXA_WITH_SEA_ZONE_DATA.
  const includeSeaZones = taxon === null || TAXA_WITH_SEA_ZONE_DATA.includes(taxon);
  const seaZones = includeSeaZones
    ? await nearbyZonesForRegion(region.boundary_geojson as Parameters<typeof nearbyZonesForRegion>[0])
    : [];

  const suffix = taxon ? `-${taxon}` : "";
  const variantSuffix = variant === "small" ? "-small" : "";
  const stagingDir = path.join(outDir, `.staging-${sanitize(regionName)}${suffix}${variantSuffix}`);
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(path.join(stagingDir, "photos"), { recursive: true });

  const { manifestSpecies, photoCount } = packSpecies(speciesRes.rows, undefined, await fetchGallery(speciesRes.rows.map((r) => r.id)));
  const children = await fetchChildRegionsWithSpecies(region.id, taxonFilter);
  fitHotspotsToBudget(manifestSpecies, children, regionName);
  const manifestCore = {
    type: "region",
    region: regionName,
    taxon,
    variant,
    speciesCount: manifestSpecies.length,
    species: manifestSpecies,
    // Provinces/states this pack makes available (see fetchChildRegionsWithSpecies).
    children,
    // Each sea zone pack is downloaded separately and once. Scoped to the same taxon as this
    // build; an "all taxa" build depends on the "all taxa" sea zone pack.
    seaZoneDependencies: seaZones
      .map((z) => ({ name: z.name, packFile: seaZonePackFileName(z.name, taxon, variant) }))
      .filter((d) => !opts.seaZonePackAvailable || opts.seaZonePackAvailable(d.packFile)),
  };
  const manifest = {
    ...manifestCore,
    generatedAt: new Date().toISOString(),
    contentVersion: contentHash(manifestCore),
    photoBytes: photoBytesInStaging(stagingDir),
    checklistBytes: Buffer.byteLength(JSON.stringify(manifestCore)),
  };
  // Compact, not pretty-printed: indenting can push a large manifest past V8's string limit.
  writeFileSync(path.join(stagingDir, "manifest.json"), JSON.stringify(manifest));

  const archiveName = regionPackFileName(regionName, taxon, variant);
  const sizeMb = (await writeArchive(stagingDir, outDir, archiveName)) / 1024 / 1024;
  console.log(
    `[build-region-pack] ${regionName}${suffix}: ${manifestSpecies.length} species (${photoCount} with photos)` +
      (children.length > 0 ? `, ${children.length} province(s)/state(s) bundled (${children.map((c) => c.name).join(", ")})` : "") +
      (seaZones.length > 0 ? `, depends on sea zone pack(s): ${seaZones.map((z) => z.name).join(", ")}` : ""),
  );
  console.log(`[build-region-pack] wrote ${path.join(outDir, archiveName)} (${sizeMb.toFixed(1)} MB)`);
  return { fileName: archiveName, speciesCount: manifestSpecies.length };
}

async function main() {
  const args = process.argv.slice(2);
  const taxonArg = args.find((a) => a.startsWith("--taxon="))?.slice("--taxon=".length) ?? null;
  if (taxonArg && !TAXON_CLASSES.includes(taxonArg as TaxonClass)) {
    console.error(`--taxon must be one of: ${TAXON_CLASSES.join(", ")}`);
    process.exit(1);
  }
  const seaZoneMode = args.includes("--sea-zone");
  const variantArg = args.find((a) => a.startsWith("--variant="))?.slice("--variant=".length) ?? "full";
  if (variantArg !== "full" && variantArg !== "small") {
    console.error(`--variant must be "full" or "small"`);
    process.exit(1);
  }
  const variant = variantArg as PackVariant;
  const positional = args.filter((a) => !a.startsWith("--"));
  const name = positional[0];
  const outDir = positional[1] ?? path.join(REPO_ROOT, "packs");

  if (!name) {
    console.error(
      `Usage: npm run build-region-pack -w data-pipeline -- <region name> [outputDir] [--taxon=${TAXON_CLASSES.join("|")}] [--variant=full|small]\n` +
        `   or: npm run build-region-pack -w data-pipeline -- --sea-zone <sea zone name> [outputDir] [--taxon=${TAXON_CLASSES.join("|")}] [--variant=full|small]`,
    );
    process.exit(1);
  }

  if (seaZoneMode) {
    await buildSeaZonePack(name, outDir, taxonArg as TaxonClass | null, variant);
  } else {
    await buildRegionPack(name, outDir, taxonArg as TaxonClass | null, variant);
  }

  await pool.end();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
