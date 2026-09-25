// Bundles one region's already-enriched reference photos + habitat descriptions into a single
// downloadable archive, so every self-hosted install can pull ONE canonical pack instead of
// each independently re-hitting iNaturalist/Wikipedia for the same species. Run by hand,
// occasionally, as enrich-all-species.ts covers more species.
//
// Species are keyed by scientific_name, never species.id — every install seeds its own table
// with a fresh gen_random_uuid() per row, so a pack's contents can only be matched back up by name.
//
// A sea zone (e.g. the Red Sea) is its own standalone pack (--sea-zone below), never embedded
// inside a country pack, so multiple neighboring countries can share one download instead of
// duplicating it — a country pack's manifest just lists which sea zone packs it depends on.
// --taxon applies to a sea zone build too, same as a country build: a "Canada (Fish)" country
// pack depends only on that zone's fish-taxon pack, never its other taxon-scoped packs (e.g.
// nudibranchs someone downloaded separately) — each taxon in a zone is its own independent
// download, not bundled all-or-nothing with the zone itself.
//
// --taxon scopes a build to one taxon class (see TAXON_CLASSES below for the full fine-grained
// list), producing a separate downloadable file per group; omit it to build every taxon together.
//
// Usage:
//   npm run build-region-pack -w data-pipeline -- "Canada" [outputDir] [--taxon=<TaxonClass>]
//   npm run build-region-pack -w data-pipeline -- --sea-zone "Red Sea" [outputDir] [--taxon=<TaxonClass>]
import { existsSync, mkdirSync, writeFileSync, copyFileSync, rmSync, statSync, readdirSync } from "node:fs";
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

// Hash of everything in the manifest EXCEPT generatedAt (a fresh timestamp every run would
// otherwise make every rebuild look like a content change) — see build-pack-index.ts and
// offlinePacks/routes.ts, which compare this against a client's stored content_version to
// decide whether an already-downloaded pack actually needs re-fetching.
// A manifest has to stay well under V8's ~512MB string limit: the builder serializes it in one
// piece, and so does the app when it installs the pack. Province-level hotspot clusters are what
// grow without bound (the United States' birds carried 4.9 million, 673MB of JSON), so a pack
// over budget keeps each species' largest clusters per province, trying progressively tighter
// caps until it fits. Packs under budget are left exactly as they were.
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

// When a manifest grows past V8's string limit (JSON.stringify throws "Invalid string length"),
// says which part did it, instead of leaving only the bare RangeError.
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

// Same constants/logic as regions/routes.ts's own nearbyZones — duplicated rather than
// imported since that lives in apps/api, which data-pipeline scripts don't depend on
// (data-pipeline is the lower layer; apps/api imports FROM it, never the reverse).
const BBOX_PREFILTER_BUFFER_DEGREES = 10;
const NEARBY_MAX_DISTANCE_DEGREES = 2;

// Mirrors packages/shared/src/species.ts's TaxonClass exactly — kept as its own local tuple
// (not imported) to match this file's existing pattern, same reasoning as this file's own
// top comment on duplicating regions/routes.ts's nearbyZones logic instead of importing it.
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

// Only these taxa currently have any sea_zone_species data at all (see regions/routes.ts's
// ensureSeaZoneComputed) — the newer invertebrate/reptile/amphibian groups aren't wired into
// region/sea-zone computation yet (disclosed gap, same as their seed scripts' own notes), so
// checking for a sea zone dependency on them would just always find zero and add nothing.
const TAXA_WITH_SEA_ZONE_DATA: readonly TaxonClass[] = ["actinopterygii", "elasmobranchii", "aquatic_mammalia"];

interface ManifestSpecies {
  scientificName: string;
  commonName: string | null;
  habitatDescription: string | null;
  referenceCredit: string | null;
  referenceLicense: string | null;
  displayFile: string | null;
  thumbFile: string | null;
  // The full reference-photo gallery (species_reference_photos), not just the single main
  // photo above: a self-hosted install used to only ever get the gallery's ROW data (and
  // only then via the separate, one-time catalog seed, never a region pack), with the actual
  // image files never bundled anywhere at all. That left every gallery photo dependent on a
  // live hotlink to Wikimedia/iNaturalist forever, which defeats the entire point of an
  // offline pack, and a species page should work with no network connection the same way its
  // main photo already does. Undefined/omitted for a species with no gallery photos.
  gallery?: Array<{
    photoUrl: string;
    credit: string;
    license: string;
    sortOrder: number;
    focalX: number | null;
    focalY: number | null;
    displayFile: string | null;
    thumbFile: string | null;
    // Per-gallery-photo auto-suggest vector (species_reference_gallery_embeddings), shipped
    // in BOTH pack variants, same reasoning as the species-level embedding field below:
    // matching a candidate photo against several reference poses (not just the one main photo)
    // catches real photos taken at a different angle from that single reference image, which
    // otherwise could legitimately score below the confidence cutoff despite being an obvious
    // match to a human. Omitted for a gallery photo that hasn't been embedded yet.
    embedding?: number[];
    embeddingModelVersion?: string;
  }>;
  // The species' auto-suggest reference vector (species_reference_embeddings), computed
  // once, server-side, synchronously with enrichment (see lazyEnrich.ts), yet never actually
  // shipped anywhere before this: not in a region pack (this file had no embedding code at
  // all), and not even in the one-time catalog seed despite a comment there claiming it was.
  // Bundling it here means a freshly downloaded region's species are suggestion-ready
  // immediately, with no separate backfill step the desktop app never runs on its own.
  // Omitted for a species that hasn't been embedded yet.
  embedding?: number[];
  embeddingModelVersion?: string;
  // Checklist membership itself, not just enrichment content — this is what lets a
  // self-hosted install populate a region's checklist from the pack alone, with no live GBIF
  // call ever needed at request time (see offlinePacks/routes.ts's applyPack, which upserts
  // region_species/sea_zone_species from these fields). Undefined/omitted for a sea-zone
  // pack, which never computes local_tier/is_vagrant (see this file's own region_species
  // schema comment) — only recordCount there.
  localFrequency?: number | null;
  seasonality?: number[] | null;
  localTier?: string | null;
  isVagrant?: boolean;
  recordCount?: number;
  weeklyFrequency?: number[] | null;
  // Gap-finder hotspot clusters (migration 074) — province-level only, never populated at
  // country level (hotspots are computed per-province; see compute-provinces-bulk.ts). Omitted
  // entirely for a country's own top-level species list and for sea-zone packs.
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
      // Same bbox-containment bypass as apps/api/src/regions/routes.ts's nearbyZones — a
      // small island's bbox sitting entirely inside a sea zone's bbox is unambiguous even
      // when the zone's simplified polygon edge happens to sit just past the ring-distance
      // cutoff (see that file's comment on Antigua and Barb. vs. the Eastern Caribbean zone).
      // Gated to island-scale regions only — see bboxContains's own comment on why this
      // backfires (Aswan, Egypt) for a large landlocked region without that gate.
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
  embedding: number[] | null;
  embeddingModelVersion: string | null;
}

interface EmbeddingRaw {
  embedding: number[];
  modelVersion: string;
}

// Batch-fetched once per call site (not per species; see this file's own pattern for
// hotspots) and matched back onto each row by scientific_name, the same cross-install
// identity every other pack field already uses. Both queries no-op cleanly on an empty
// speciesIds array (an ANY($1) over an empty array matches nothing, not an error).
async function fetchGalleryAndEmbeddings(
  speciesIds: string[],
): Promise<{ galleryByScientificName: Map<string, GalleryPhotoRaw[]>; embeddingByScientificName: Map<string, EmbeddingRaw> }> {
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
    embedding: number[] | null;
    embedding_model_version: string | null;
  }>(
    `SELECT s.scientific_name, p.photo_url, p.credit, p.license, p.sort_order, p.focal_x, p.focal_y, p.display_path, p.thumb_path,
            ge.embedding, ge.model_version AS embedding_model_version
     FROM species_reference_photos p
     JOIN species s ON s.id = p.species_id
     LEFT JOIN species_reference_gallery_embeddings ge ON ge.reference_photo_id = p.id
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
      embedding: row.embedding,
      embeddingModelVersion: row.embedding_model_version,
    });
  }

  const embeddingByScientificName = new Map<string, EmbeddingRaw>();
  const embeddingRes = await pool.query<{ scientific_name: string; embedding: number[]; model_version: string }>(
    `SELECT s.scientific_name, e.embedding, e.model_version
     FROM species_reference_embeddings e
     JOIN species s ON s.id = e.species_id
     WHERE e.species_id = ANY($1)`,
    [speciesIds],
  );
  for (const row of embeddingRes.rows) {
    embeddingByScientificName.set(row.scientific_name, { embedding: row.embedding, modelVersion: row.model_version });
  }

  return { galleryByScientificName, embeddingByScientificName };
}

function packSpecies(
  stagingDir: string,
  rows: SpeciesRow[],
  hotspotsByScientificName?: Map<string, ManifestSpecies["hotspots"]>,
  galleryByScientificName?: Map<string, GalleryPhotoRaw[]>,
  embeddingByScientificName?: Map<string, EmbeddingRaw>,
  variant: PackVariant = "full",
  // Species already carrying their embedding (species-level + every gallery photo's own) in
  // the COUNTRY's own top-level manifestSpecies entry — a province's checklist is normally a
  // subset of its country's, so re-embedding the same floats once per province multiplied the
  // manifest size by however many provinces a species appeared in (13-18x for a country like
  // France) and is exactly what pushed JSON.stringify(manifestCore) past V8's own string-length
  // ceiling building France's aves pack ("RangeError: Invalid string length"). The client
  // upserts embeddings keyed by species_id/photo_url regardless of which pack entry supplied
  // them, so skipping the duplicate here loses nothing — a species NOT in this set (present in
  // a province's checklist but somehow absent from the country's own top-level one) still gets
  // its embedding from this call, same as before.
  skipEmbeddingFor?: Set<string>,
): { manifestSpecies: ManifestSpecies[]; photoCount: number; galleryPhotoCount: number } {
  const manifestSpecies: ManifestSpecies[] = [];
  let photoCount = 0;
  let galleryPhotoCount = 0;
  // Photos the database says are cached but whose file is gone. These used to be skipped
  // silently, so packs got published missing thousands of photos without any sign of it.
  const missingFiles: string[] = [];
  const present = (p: string | null): p is string => {
    if (!p) return false;
    if (existsSync(p)) return true;
    missingFiles.push(p);
    return false;
  };
  for (const row of rows) {
    // Every checklist member ships, enriched or not — the pack is now the sole source of
    // checklist membership for a self-hosted install (no live GBIF fallback), so a species
    // with no photo/habitat text yet (enrichment hasn't reached it, or none exists) still
    // needs its region_species row applied, just with null enrichment fields.
    const key = sanitize(row.scientific_name);
    let displayFile: string | null = null;
    let thumbFile: string | null = null;
    if (present(row.reference_display_path)) {
      displayFile = `photos/${key}.display.webp`;
      copyFileSync(row.reference_display_path, path.join(stagingDir, displayFile));
      photoCount++;
    }
    if (present(row.reference_thumb_path)) {
      thumbFile = `photos/${key}.thumb.webp`;
      copyFileSync(row.reference_thumb_path, path.join(stagingDir, thumbFile));
    }

    // Fetched regardless of variant now: a "small" pack still ships every gallery photo's
    // embedding (a few KB each), it just skips copying the image files themselves below.
    const galleryRaw = galleryByScientificName?.get(row.scientific_name) ?? [];
    const gallery: ManifestSpecies["gallery"] = [];
    for (const g of galleryRaw) {
      let gDisplayFile: string | null = null;
      let gThumbFile: string | null = null;
      if (variant !== "small") {
        if (present(g.displayPath)) {
          gDisplayFile = `photos/${key}.gallery-${g.sortOrder}.display.webp`;
          copyFileSync(g.displayPath, path.join(stagingDir, gDisplayFile));
          galleryPhotoCount++;
        }
        if (present(g.thumbPath)) {
          gThumbFile = `photos/${key}.gallery-${g.sortOrder}.thumb.webp`;
          copyFileSync(g.thumbPath, path.join(stagingDir, gThumbFile));
        }
      }
      gallery.push({
        photoUrl: g.photoUrl,
        credit: g.credit,
        license: g.license,
        sortOrder: g.sortOrder,
        focalX: g.focalX,
        focalY: g.focalY,
        displayFile: gDisplayFile,
        thumbFile: gThumbFile,
        ...(g.embedding &&
          g.embeddingModelVersion &&
          !skipEmbeddingFor?.has(row.scientific_name) && { embedding: g.embedding, embeddingModelVersion: g.embeddingModelVersion }),
      });
    }

    const embeddingEntry = skipEmbeddingFor?.has(row.scientific_name) ? undefined : embeddingByScientificName?.get(row.scientific_name);

    manifestSpecies.push({
      scientificName: row.scientific_name,
      commonName: row.common_name,
      habitatDescription: row.habitat_description,
      referenceCredit: row.reference_credit,
      referenceLicense: row.reference_license,
      displayFile,
      thumbFile,
      ...(gallery.length > 0 && { gallery }),
      ...(embeddingEntry && { embedding: embeddingEntry.embedding, embeddingModelVersion: embeddingEntry.modelVersion }),
      ...(row.local_frequency !== undefined && { localFrequency: row.local_frequency != null ? Number(row.local_frequency) : null }),
      ...(row.seasonality !== undefined && { seasonality: row.seasonality }),
      ...(row.local_tier !== undefined && { localTier: row.local_tier }),
      ...(row.is_vagrant !== undefined && { isVagrant: row.is_vagrant }),
      ...(row.record_count !== undefined && { recordCount: row.record_count }),
      ...(row.weekly_frequency !== undefined && { weeklyFrequency: row.weekly_frequency }),
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

// Uncompressed byte counts for the two things that actually make up a pack's size — photos
// (species reference images) vs. the checklist itself (species/habitat/rarity JSON, no
// images). Both are measured pre-gzip: the archive is a single gzip stream over both together
// (see writeArchive), so there's no way to recover an exact post-compression split from the
// finished .tar.gz — this is an estimate of relative weight, good enough for "would offloading
// this pack's photos free up meaningfully more space than its checklist," which is what
// OfflinePacksPage's offload-impact UI actually needs.
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

async function buildSeaZonePack(zoneName: string, outDir: string, taxon: TaxonClass | null, variant: PackVariant = "full"): Promise<void> {
  const zoneRes = await pool.query<{ id: string }>(`SELECT id FROM sea_zones WHERE name = $1`, [zoneName]);
  const zone = zoneRes.rows[0];
  if (!zone) {
    console.error(`No sea zone named "${zoneName}"`);
    process.exit(1);
  }

  const taxonFilter = taxon ? `AND s.taxon_class = '${taxon}'` : "";
  const speciesRes = await pool.query<SpeciesRow>(
    `SELECT s.id, s.scientific_name, s.common_name, s.habitat_description,
            s.reference_display_path, s.reference_thumb_path, s.reference_credit, s.reference_license,
            zs.record_count
     FROM sea_zone_species zs
     JOIN species s ON s.id = zs.species_id
     WHERE zs.sea_zone_id = $1 ${taxonFilter}
     ORDER BY s.scientific_name`,
    [zone.id],
  );

  // Same "don't publish a near-empty archive nobody wants" guard as buildRegionPack's own
  // taxon-scoped check — a sea zone that only ever carries fish (the common case) legitimately
  // has 0 aquatic_mammalia species most of the time.
  if (taxon !== null && speciesRes.rows.length === 0) {
    console.log(`[build-region-pack] sea zone "${zoneName}"-${taxon}: 0 species, skipping`);
    return;
  }

  const suffix = taxon ? `-${taxon}` : "";
  const variantSuffix = variant === "small" ? "-small" : "";
  const stagingDir = path.join(outDir, `.staging-seazone-${sanitize(zoneName)}${suffix}${variantSuffix}`);
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(path.join(stagingDir, "photos"), { recursive: true });

  const { galleryByScientificName, embeddingByScientificName } = await fetchGalleryAndEmbeddings(speciesRes.rows.map((r) => r.id));
  const { manifestSpecies, photoCount } = packSpecies(stagingDir, speciesRes.rows, undefined, galleryByScientificName, embeddingByScientificName, variant);
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
  // Compact, not pretty-printed: manifest.json is machine-read only, never hand-edited, and
  // pretty-printing a large numeric array (a gallery photo's own embedding, now duplicated once
  // per province a species appears in) adds a newline+indent per float, not per array -- enough
  // overhead on top of the embeddings themselves to push a big taxon's manifest (aves: ~631
  // species x up to 6 gallery photos x 768 floats, times every province each species appears in)
  // past V8's own JSON.stringify string-length ceiling. Confirmed live: this crashed building
  // Canada's aves pack with "RangeError: Invalid string length" the first time gallery photos
  // shipped their own embeddings.
  writeFileSync(path.join(stagingDir, "manifest.json"), JSON.stringify(manifest));

  const archiveName = seaZonePackFileName(zoneName, taxon, variant);
  const sizeMb = (await writeArchive(stagingDir, outDir, archiveName)) / 1024 / 1024;
  console.log(`[build-region-pack] sea zone "${zoneName}"${suffix}: ${manifestSpecies.length} species (${photoCount} with photos)`);
  console.log(`[build-region-pack] wrote ${path.join(outDir, archiveName)} (${sizeMb.toFixed(1)} MB)`);
}

interface ManifestChildRegion {
  name: string;
  ebirdRegionCode: string | null;
  boundaryGeoJson: unknown;
  externalCodes: string[];
  species: ManifestSpecies[];
  isOverseasTerritory: boolean;
}

// A downloaded country pack should leave its provinces/states ready too, not just the
// country's own top-level checklist — a self-hosted install has no other way to get a
// province row to exist at all (drill-down only creates it locally via the same Natural
// Earth boundary lookup a maintainer already ran to compute it here), so the pack has to
// carry both the province's own region record AND its checklist. Only children that have
// actually been computed (occurrence_computed_at set) are included — an uncomputed province
// just isn't ready yet and stays absent from the pack rather than shipping an empty checklist.
async function fetchChildRegionsWithSpecies(
  parentId: string,
  taxonFilter: string,
  variant: PackVariant = "full",
  // See packSpecies' own comment on skipEmbeddingFor — every province reuses this same set so
  // its species entries don't re-embed floats the country's own top-level list already shipped.
  topLevelScientificNames?: Set<string>,
): Promise<ManifestChildRegion[]> {
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
              rs.local_frequency, rs.seasonality, rs.local_tier, rs.is_vagrant, rs.weekly_frequency
       FROM region_species rs
       JOIN species s ON s.id = rs.species_id
       WHERE rs.region_id = $1 ${taxonFilter}
       ORDER BY s.scientific_name`,
      [child.id],
    );
    // Gap-finder hotspot clusters only ever exist at this province level (see
    // compute-provinces-bulk.ts) — fetched once per province and matched back onto its own
    // species by scientific_name, the same cross-install identity every other pack field uses.
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
    // Reuses the parent's own staging/photos dir — a species shared between the country and
    // one of its provinces (the common case) writes its photo once, not once per region.
    const { galleryByScientificName, embeddingByScientificName } = await fetchGalleryAndEmbeddings(
      childSpeciesRes.rows.map((r) => r.id),
    );
    const { manifestSpecies } = packSpecies(
      currentStagingDir,
      childSpeciesRes.rows,
      hotspotsByScientificName,
      galleryByScientificName,
      embeddingByScientificName,
      variant,
      topLevelScientificNames,
    );
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

// Set once per buildRegionPack call so fetchChildRegionsWithSpecies (called from inside it)
// can share the same photos/ staging directory without threading it through every call.
let currentStagingDir = "";

async function buildRegionPack(regionName: string, outDir: string, taxon: TaxonClass | null, variant: PackVariant = "full"): Promise<void> {
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
    `SELECT s.id, s.scientific_name, s.common_name, s.habitat_description,
            s.reference_display_path, s.reference_thumb_path, s.reference_credit, s.reference_license,
            rs.local_frequency, rs.seasonality, rs.local_tier, rs.is_vagrant, rs.weekly_frequency
     FROM region_species rs
     JOIN species s ON s.id = rs.species_id
     WHERE rs.region_id = $1 ${taxonFilter}
     ORDER BY s.scientific_name`,
    [region.id],
  );

  // A per-taxon build (e.g. --taxon=corals for a landlocked country) legitimately has nothing
  // to ship most of the time — skip writing an empty archive rather than publishing a
  // near-zero-byte pack nobody would ever want to download. Only applies to taxon-scoped
  // builds; an "all taxa" build always writes even if a region turns out to have 0 species,
  // same as before this check existed.
  if (taxon !== null && speciesRes.rows.length === 0) {
    console.log(`[build-region-pack] ${regionName}-${taxon}: 0 species, skipping`);
    return;
  }

  // See TAXA_WITH_SEA_ZONE_DATA's own comment — only fish/sharks/aquatic mammals currently
  // have any sea zone data computed at all.
  const includeSeaZones = taxon === null || TAXA_WITH_SEA_ZONE_DATA.includes(taxon);
  const seaZones = includeSeaZones
    ? await nearbyZonesForRegion(region.boundary_geojson as Parameters<typeof nearbyZonesForRegion>[0])
    : [];

  const suffix = taxon ? `-${taxon}` : "";
  const variantSuffix = variant === "small" ? "-small" : "";
  const stagingDir = path.join(outDir, `.staging-${sanitize(regionName)}${suffix}${variantSuffix}`);
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(path.join(stagingDir, "photos"), { recursive: true });
  currentStagingDir = stagingDir;

  const { galleryByScientificName, embeddingByScientificName } = await fetchGalleryAndEmbeddings(speciesRes.rows.map((r) => r.id));
  const { manifestSpecies, photoCount } = packSpecies(stagingDir, speciesRes.rows, undefined, galleryByScientificName, embeddingByScientificName, variant);
  const children = await fetchChildRegionsWithSpecies(
    region.id,
    taxonFilter,
    variant,
    new Set(speciesRes.rows.map((r) => r.scientific_name)),
  );
  fitHotspotsToBudget(manifestSpecies, children, regionName);
  const manifestCore = {
    type: "region",
    region: regionName,
    taxon,
    variant,
    speciesCount: manifestSpecies.length,
    species: manifestSpecies,
    // Provinces/states this country's install can already show once this pack applies —
    // see fetchChildRegionsWithSpecies's own comment.
    children,
    // The client downloads each of these SEPARATELY (and only once, however many of this
    // region's neighbors also depend on it) — see this file's own top comment. Scoped to the
    // SAME taxon as this country build itself: a "Canada (Fish)" pack depends only on the
    // fish-taxon sea zone packs, never on a sea zone's other taxon-scoped packs (nudibranchs,
    // etc.) — those are independent downloads a user opts into separately. An "all taxa"
    // country build (taxon === null) still depends on the "all taxa" sea zone pack, which
    // covers every taxon in that zone at once, same as before this taxon-scoping existed.
    seaZoneDependencies: seaZones.map((z) => ({ name: z.name, packFile: seaZonePackFileName(z.name, taxon, variant) })),
  };
  const manifest = {
    ...manifestCore,
    generatedAt: new Date().toISOString(),
    contentVersion: contentHash(manifestCore),
    // Sums the WHOLE staging photos/ folder, which by this point also includes every bundled
    // child province's own reference photos (packed in via fetchChildRegionsWithSpecies above)
    // — the total for the entire archive this manifest ends up inside, not just this region's
    // own top-level species.
    photoBytes: photoBytesInStaging(stagingDir),
    checklistBytes: Buffer.byteLength(JSON.stringify(manifestCore)),
  };
  // Compact, not pretty-printed: manifest.json is machine-read only, never hand-edited, and
  // pretty-printing a large numeric array (a gallery photo's own embedding, now duplicated once
  // per province a species appears in) adds a newline+indent per float, not per array -- enough
  // overhead on top of the embeddings themselves to push a big taxon's manifest (aves: ~631
  // species x up to 6 gallery photos x 768 floats, times every province each species appears in)
  // past V8's own JSON.stringify string-length ceiling. Confirmed live: this crashed building
  // Canada's aves pack with "RangeError: Invalid string length" the first time gallery photos
  // shipped their own embeddings.
  writeFileSync(path.join(stagingDir, "manifest.json"), JSON.stringify(manifest));

  const archiveName = regionPackFileName(regionName, taxon, variant);
  const sizeMb = (await writeArchive(stagingDir, outDir, archiveName)) / 1024 / 1024;
  console.log(
    `[build-region-pack] ${regionName}${suffix}: ${manifestSpecies.length} species (${photoCount} with photos)` +
      (children.length > 0 ? `, ${children.length} province(s)/state(s) bundled (${children.map((c) => c.name).join(", ")})` : "") +
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
