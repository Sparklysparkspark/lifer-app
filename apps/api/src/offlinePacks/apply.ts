// Applies a downloaded pack archive in one transaction. A species' photo and description are
// written only once, whichever pack (or live lookup) gets there first; a sea zone shared by
// several countries is downloaded once (see download.ts's dependency queue).
import { HUMAN_SCIENTIFIC_NAME } from "@lifer/core/species/neverListed.js";
import { existsSync, mkdirSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import type { PoolClient } from "pg";
import { descendantIdsSql } from "@lifer/core/regions/regionTree.js";
import { isSafePackEntry, resolveWithinDir } from "./packPaths.js";
import { PHOTO_DIRS } from "./photoStore.js";
import { PackManifestSchema, parseRemoteJson, type ManifestSpecies, type PackManifest } from "./schemas.js";

export type { PackManifest } from "./schemas.js";

// Rows per bulk statement, well under Postgres's ~65535 bind-parameter limit at 9 columns.
const BULK_BATCH_SIZE = 500;

function chunkRows<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Independent copies overlap (a NAS pays latency per file), with a bound so thousands of files
// don't open that many descriptors at once.
async function copyFilesConcurrently(tasks: Array<{ src: string; dest: string }>, concurrency = 24): Promise<void> {
  if (tasks.length === 0) return;
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const task = tasks[next++];
      await copyFile(task.src, task.dest);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}

// A pack is the whole checklist for its region (or sea zone) and taxon, so rows it no longer lists
// are removed. The user's own additions, hand imports included, live in separate tables
// (regions/checklistAdditions.ts) that this never touches.
async function pruneChecklist(
  db: PoolClient,
  target: { regionId: string } | { seaZoneId: string },
  taxon: string | null | undefined,
  keepIds: string[],
): Promise<number> {
  if (taxon === undefined) return 0;
  const [table, column, id] =
    "regionId" in target
      ? ["region_species", "region_id", target.regionId]
      : ["sea_zone_species", "sea_zone_id", target.seaZoneId];
  const res = await db.query<{ species_id: string }>(
    `DELETE FROM ${table} t USING species s
     WHERE t.${column} = $1 AND s.id = t.species_id
       AND ($2::text IS NULL OR s.taxon_class = $2)
       AND NOT (t.species_id = ANY($3::uuid[]))
     RETURNING t.species_id`,
    [id, taxon, keepIds],
  );
  if ("regionId" in target && res.rows.length > 0) {
    await db.query(`DELETE FROM region_species_hotspots WHERE region_id = $1 AND species_id = ANY($2::uuid[])`, [
      target.regionId,
      res.rows.map((r) => r.species_id),
    ]);
  }
  return res.rows.length;
}

type ChecklistTarget = { regionId: string } | { seaZoneId: string };
type Touched = { speciesId: string; providedEnrichment: boolean };

/** The extracted archive and the folders its photos are copied into. */
interface PackDirs {
  extractDir: string;
  display: string;
  thumb: string;
  galleryDisplay: string;
  galleryThumb: string;
}

interface ChecklistPlan {
  skippedNames: string[];
  touched: Touched[];
  // Copies run together after planning (destinations derive from row ids), before any row points
  // at them.
  copyTasks: Array<{ src: string; dest: string }>;
  enrichmentUpdates: Array<{
    id: string;
    habitat: string | null;
    credit: string | null;
    license: string | null;
    display: string | null;
    thumb: string | null;
  }>;
  galleryUpserts: Array<{
    speciesId: string;
    photoUrl: string;
    credit: string;
    license: string;
    sortOrder: number;
    focalX: number | null;
    focalY: number | null;
    display: string | null;
    thumb: string | null;
  }>;
  /** Final row id per gallery photo ("speciesId:photoUrl"): prefetched, then filled in by the upsert. */
  galleryPhotoIdByKey: Map<string, string>;
  galleryEmbeddingCandidates: Array<{ speciesId: string; photoUrl: string; embedding: number[]; modelVersion: string }>;
  speciesEmbeddings: Array<{ speciesId: string; embedding: number[]; modelVersion: string }>;
  // Every matched species is marked "gallery already tried": the pack build ran the same gallery
  // lookup, so viewing it shouldn't trigger a live fetch.
  galleryBackfilledIds: string[];
  checklistRows: Array<{ speciesId: string; sp: ManifestSpecies }>;
}

// Bulk reads up front and every decision in memory, so the writes after can be bulk too and
// large packs stay fast.
async function planChecklist(db: PoolClient, species: ManifestSpecies[], dirs: PackDirs): Promise<ChecklistPlan> {
  const existingRes = await db.query<{
    id: string;
    scientific_name: string;
    enriched_at: string | null;
    reference_display_path: string | null;
    reference_thumb_path: string | null;
  }>(
    `SELECT id, scientific_name, enriched_at, reference_display_path, reference_thumb_path
     FROM species WHERE scientific_name = ANY($1)`,
    [species.map((sp) => sp.scientificName)],
  );
  const speciesByName = new Map(existingRes.rows.map((r) => [r.scientific_name, r]));

  const speciesIds = existingRes.rows.map((r) => r.id);
  type GalleryRow = {
    id: string;
    species_id: string;
    photo_url: string;
    display_path: string | null;
    thumb_path: string | null;
  };
  const existingGalleryRows = speciesIds.length
    ? (
        await db.query<GalleryRow>(
          `SELECT id, species_id, photo_url, display_path, thumb_path FROM species_reference_photos WHERE species_id = ANY($1)`,
          [speciesIds],
        )
      ).rows
    : [];
  const existingGalleryByKey = new Map(existingGalleryRows.map((r) => [`${r.species_id}:${r.photo_url}`, r]));
  // Blocklisted photos (maps and other non-photos) are never installed, even if a pack has them.
  const blockedPhotos = new Set(
    (await db.query<{ photo_url: string }>(`SELECT photo_url FROM reference_photo_blocklist`)).rows.map(
      (r) => r.photo_url,
    ),
  );

  const plan: ChecklistPlan = {
    skippedNames: [],
    touched: [],
    copyTasks: [],
    enrichmentUpdates: [],
    galleryUpserts: [],
    galleryPhotoIdByKey: new Map([...existingGalleryByKey.entries()].map(([k, r]) => [k, r.id] as const)),
    galleryEmbeddingCandidates: [],
    speciesEmbeddings: [],
    galleryBackfilledIds: [],
    checklistRows: [],
  };

  for (const sp of species) {
    // Packs built before people were left out still list them.
    if (sp.scientificName === HUMAN_SCIENTIFIC_NAME) continue;
    const row = speciesByName.get(sp.scientificName);
    // A species this install's catalog doesn't have: nothing to apply.
    if (!row) {
      plan.skippedNames.push(sp.scientificName);
      continue;
    }
    plan.galleryBackfilledIds.push(row.id);

    // Enrichment fills in only for a species not yet enriched, or whose display or thumb file
    // is missing or unrecorded (a catalog seed sets enriched_at without any image files).
    // Checklist membership below applies either way.
    const referenceFileMissing =
      (!!sp.displayFile && (row.reference_display_path == null || !existsSync(row.reference_display_path))) ||
      (!!sp.thumbFile && (row.reference_thumb_path == null || !existsSync(row.reference_thumb_path)));
    const providedEnrichment = !row.enriched_at || referenceFileMissing;
    if (providedEnrichment) {
      const displaySource = sp.displayFile ? resolveWithinDir(dirs.extractDir, sp.displayFile) : null;
      const thumbSource = sp.thumbFile ? resolveWithinDir(dirs.extractDir, sp.thumbFile) : null;

      let displayPath: string | null = null;
      let thumbPath: string | null = null;
      if (displaySource && existsSync(displaySource)) {
        displayPath = path.join(dirs.display, `${row.id}.webp`);
        plan.copyTasks.push({ src: displaySource, dest: displayPath });
      }
      if (thumbSource && existsSync(thumbSource)) {
        thumbPath = path.join(dirs.thumb, `${row.id}.webp`);
        plan.copyTasks.push({ src: thumbSource, dest: thumbPath });
      }

      plan.enrichmentUpdates.push({
        id: row.id,
        habitat: sp.habitatDescription ?? null,
        credit: sp.referenceCredit ?? null,
        license: sp.referenceLicense ?? null,
        display: displayPath,
        thumb: thumbPath,
      });
    }

    // Gallery photos and the reference embedding are checked on their own terms, independent of
    // the enrichment gate above.
    for (const g of sp.gallery ?? []) {
      // sortOrder names the photo's file, so anything but an integer could escape the folder.
      if (blockedPhotos.has(g.photoUrl) || !Number.isSafeInteger(g.sortOrder)) continue;
      const sortOrder = g.sortOrder as number;
      const existingGalleryRow = existingGalleryByKey.get(`${row.id}:${g.photoUrl}`);
      const galleryFileMissing =
        !existingGalleryRow ||
        (existingGalleryRow.display_path != null && !existsSync(existingGalleryRow.display_path)) ||
        (existingGalleryRow.thumb_path != null && !existsSync(existingGalleryRow.thumb_path));

      if (galleryFileMissing) {
        const gDisplaySource = g.displayFile ? resolveWithinDir(dirs.extractDir, g.displayFile) : null;
        const gThumbSource = g.thumbFile ? resolveWithinDir(dirs.extractDir, g.thumbFile) : null;
        let gDisplayPath: string | null = existingGalleryRow?.display_path ?? null;
        let gThumbPath: string | null = existingGalleryRow?.thumb_path ?? null;
        if (gDisplaySource && existsSync(gDisplaySource)) {
          gDisplayPath = path.join(dirs.galleryDisplay, `${row.id}-${sortOrder}.webp`);
          plan.copyTasks.push({ src: gDisplaySource, dest: gDisplayPath });
        }
        if (gThumbSource && existsSync(gThumbSource)) {
          gThumbPath = path.join(dirs.galleryThumb, `${row.id}-${sortOrder}.webp`);
          plan.copyTasks.push({ src: gThumbSource, dest: gThumbPath });
        }
        plan.galleryUpserts.push({
          speciesId: row.id,
          photoUrl: g.photoUrl,
          credit: g.credit,
          license: g.license,
          sortOrder,
          focalX: g.focalX,
          focalY: g.focalY,
          display: gDisplayPath,
          thumb: gThumbPath,
        });
      }

      // Kept even without the photo's file (a "small" pack) or when the row already exists.
      if (g.embedding && g.embeddingModelVersion) {
        plan.galleryEmbeddingCandidates.push({
          speciesId: row.id,
          photoUrl: g.photoUrl,
          embedding: g.embedding,
          modelVersion: g.embeddingModelVersion,
        });
      }
    }

    // Only fills a missing vector. Ranking joins on the current model version, so a row from
    // another version just sits unused.
    if (sp.embedding && sp.embeddingModelVersion) {
      plan.speciesEmbeddings.push({
        speciesId: row.id,
        embedding: sp.embedding,
        modelVersion: sp.embeddingModelVersion,
      });
    }

    plan.checklistRows.push({ speciesId: row.id, sp });
    plan.touched.push({ speciesId: row.id, providedEnrichment });
  }
  return plan;
}

async function writeEnrichment(db: PoolClient, updates: ChecklistPlan["enrichmentUpdates"]): Promise<number> {
  for (const batch of chunkRows(updates, BULK_BATCH_SIZE)) {
    const values: unknown[] = [];
    const rows = batch.map((u, i) => {
      const base = i * 6;
      values.push(u.id, u.habitat, u.credit, u.license, u.display, u.thumb);
      return `($${base + 1}::uuid, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
    });
    await db.query(
      `UPDATE species AS s SET
         habitat_description = COALESCE(s.habitat_description, v.habitat),
         -- The credit and license describe whichever photo ends up installed: the pack's when it
         -- brings one, otherwise the one already there.
         reference_credit = CASE WHEN v.display IS NOT NULL AND v.credit IS NOT NULL THEN v.credit
                                 ELSE COALESCE(s.reference_credit, v.credit) END,
         reference_license = CASE WHEN v.display IS NOT NULL AND v.credit IS NOT NULL THEN v.license
                                  ELSE COALESCE(s.reference_license, v.license) END,
         reference_display_path = COALESCE(v.display, s.reference_display_path),
         reference_thumb_path = COALESCE(v.thumb, s.reference_thumb_path),
         enriched_at = now()
       FROM (VALUES ${rows.join(", ")}) AS v(id, habitat, credit, license, display, thumb)
       WHERE s.id = v.id`,
      values,
    );
  }
  return updates.length;
}

async function markGalleryBackfilled(db: PoolClient, speciesIds: string[]): Promise<number> {
  // COALESCE keeps a value an earlier enrich already set.
  for (const batch of chunkRows(speciesIds, BULK_BATCH_SIZE)) {
    await db.query(
      `UPDATE species SET gallery_backfilled_at = COALESCE(gallery_backfilled_at, now()) WHERE id = ANY($1::uuid[])`,
      [batch],
    );
  }
  return speciesIds.length;
}

/** Upserts gallery rows and records each one's id in `photoIdByKey`. */
async function upsertGalleryPhotos(
  db: PoolClient,
  upserts: ChecklistPlan["galleryUpserts"],
  photoIdByKey: Map<string, string>,
): Promise<number> {
  for (const batch of chunkRows(upserts, BULK_BATCH_SIZE)) {
    const values: unknown[] = [];
    const rows = batch.map((g, i) => {
      const base = i * 9;
      values.push(g.speciesId, g.photoUrl, g.credit, g.license, g.sortOrder, g.focalX, g.focalY, g.display, g.thumb);
      return `($${base + 1}::uuid, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
    });
    const res = await db.query<{ id: string; species_id: string; photo_url: string }>(
      `INSERT INTO species_reference_photos (species_id, photo_url, credit, license, sort_order, focal_x, focal_y, display_path, thumb_path)
       VALUES ${rows.join(", ")}
       ON CONFLICT (species_id, photo_url) DO UPDATE SET
         display_path = COALESCE(EXCLUDED.display_path, species_reference_photos.display_path),
         thumb_path = COALESCE(EXCLUDED.thumb_path, species_reference_photos.thumb_path)
       RETURNING id, species_id, photo_url`,
      values,
    );
    for (const r of res.rows) photoIdByKey.set(`${r.species_id}:${r.photo_url}`, r.id);
  }
  return upserts.length;
}

async function insertEmbeddings(
  db: PoolClient,
  plan: Pick<ChecklistPlan, "galleryEmbeddingCandidates" | "speciesEmbeddings" | "galleryPhotoIdByKey">,
): Promise<number> {
  const galleryEmbeddingRows = plan.galleryEmbeddingCandidates
    .map((e) => ({ ...e, referencePhotoId: plan.galleryPhotoIdByKey.get(`${e.speciesId}:${e.photoUrl}`) ?? null }))
    .filter((e): e is typeof e & { referencePhotoId: string } => e.referencePhotoId != null);
  for (const batch of chunkRows(galleryEmbeddingRows, BULK_BATCH_SIZE)) {
    const values: unknown[] = [];
    const rows = batch.map((e, i) => {
      const base = i * 4;
      values.push(e.referencePhotoId, e.speciesId, e.embedding, e.modelVersion);
      return `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}, $${base + 4})`;
    });
    await db.query(
      `INSERT INTO species_reference_gallery_embeddings (reference_photo_id, species_id, embedding, model_version)
       VALUES ${rows.join(", ")}
       ON CONFLICT (reference_photo_id) DO NOTHING`,
      values,
    );
  }

  for (const batch of chunkRows(plan.speciesEmbeddings, BULK_BATCH_SIZE)) {
    const values: unknown[] = [];
    const rows = batch.map((e, i) => {
      const base = i * 3;
      values.push(e.speciesId, e.embedding, e.modelVersion);
      return `($${base + 1}::uuid, $${base + 2}, $${base + 3})`;
    });
    await db.query(
      `INSERT INTO species_reference_embeddings (species_id, embedding, model_version)
       VALUES ${rows.join(", ")}
       ON CONFLICT (species_id) DO NOTHING`,
      values,
    );
  }
  return galleryEmbeddingRows.length + plan.speciesEmbeddings.length;
}

async function writeRegionChecklist(
  db: PoolClient,
  regionId: string,
  checklistRows: ChecklistPlan["checklistRows"],
): Promise<number> {
  for (const batch of chunkRows(checklistRows, BULK_BATCH_SIZE)) {
    const values: unknown[] = [];
    const rows = batch.map(({ speciesId, sp }, i) => {
      const base = i * 9;
      values.push(
        regionId,
        speciesId,
        sp.localFrequency ?? null,
        sp.seasonality ?? null,
        sp.localTier ?? null,
        sp.isVagrant ?? false,
        sp.weeklyFrequency ?? null,
        sp.tierReason ?? null,
        sp.tierExplain != null ? JSON.stringify(sp.tierExplain) : null,
      );
      return `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}::jsonb)`;
    });
    await db.query(
      `INSERT INTO region_species (region_id, species_id, local_frequency, seasonality, local_tier, is_vagrant, weekly_frequency, tier_reason, tier_explain)
       VALUES ${rows.join(", ")}
       ON CONFLICT (region_id, species_id) DO UPDATE SET
         local_frequency = EXCLUDED.local_frequency,
         seasonality = EXCLUDED.seasonality,
         local_tier = EXCLUDED.local_tier,
         is_vagrant = EXCLUDED.is_vagrant,
         weekly_frequency = EXCLUDED.weekly_frequency,
         tier_reason = EXCLUDED.tier_reason,
         tier_explain = EXCLUDED.tier_explain`,
      values,
    );
  }

  // Gap-finder hotspot clusters (province level only): delete then reinsert, batched across
  // every species in the region at once.
  const speciesWithHotspots = checklistRows.filter(({ sp }) => sp.hotspots && sp.hotspots.length > 0);
  if (speciesWithHotspots.length > 0) {
    for (const idBatch of chunkRows(
      speciesWithHotspots.map((r) => r.speciesId),
      BULK_BATCH_SIZE,
    )) {
      await db.query(`DELETE FROM region_species_hotspots WHERE region_id = $1 AND species_id = ANY($2)`, [
        regionId,
        idBatch,
      ]);
    }
    const hotspotRows = speciesWithHotspots.flatMap(({ speciesId, sp }) => sp.hotspots!.map((h) => ({ speciesId, h })));
    for (const hotspotBatch of chunkRows(hotspotRows, BULK_BATCH_SIZE)) {
      const values: unknown[] = [];
      const rowPlaceholders = hotspotBatch.map(({ speciesId, h }, idx) => {
        const base = idx * 8;
        values.push(
          regionId,
          speciesId,
          h.centroidLat,
          h.centroidLon,
          h.pointCount,
          h.bboxDiagonalKm,
          h.lastSeenYear,
          h.distinctYears,
        );
        return `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
      });
      await db.query(
        `INSERT INTO region_species_hotspots
           (region_id, species_id, centroid_lat, centroid_lon, point_count, bbox_diagonal_km, last_seen_year, distinct_years)
         VALUES ${rowPlaceholders.join(", ")}`,
        values,
      );
    }
  }
  return checklistRows.length;
}

async function writeSeaZoneChecklist(
  db: PoolClient,
  seaZoneId: string,
  checklistRows: ChecklistPlan["checklistRows"],
): Promise<number> {
  for (const batch of chunkRows(checklistRows, BULK_BATCH_SIZE)) {
    const values: unknown[] = [];
    const rows = batch.map(({ speciesId, sp }, i) => {
      const base = i * 3;
      values.push(seaZoneId, speciesId, sp.recordCount ?? 0);
      return `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3})`;
    });
    await db.query(
      `INSERT INTO sea_zone_species (sea_zone_id, species_id, record_count)
       VALUES ${rows.join(", ")}
       ON CONFLICT (sea_zone_id, species_id) DO UPDATE SET record_count = EXCLUDED.record_count`,
      values,
    );
  }
  return checklistRows.length;
}

interface ChecklistResult {
  applied: number;
  skipped: number;
  skippedNames: string[];
  touched: Touched[];
}

// Applies one region's or sea zone's species list: enrichment (photo, habitat text) and checklist
// membership. `db` is the pack's transaction client, so a crash mid-apply leaves nothing
// half-written. `taxon` is the pack's taxon scope, for pruning; undefined leaves the checklist's
// other rows alone.
async function applyChecklist(
  db: PoolClient,
  species: ManifestSpecies[],
  target: ChecklistTarget,
  dirs: PackDirs,
  taxon: string | null | undefined,
): Promise<ChecklistResult> {
  const plan = await planChecklist(db, species, dirs);

  // Files land before any row points at them.
  await copyFilesConcurrently(plan.copyTasks);
  await writeEnrichment(db, plan.enrichmentUpdates);
  await markGalleryBackfilled(db, plan.galleryBackfilledIds);
  await upsertGalleryPhotos(db, plan.galleryUpserts, plan.galleryPhotoIdByKey);
  await insertEmbeddings(db, plan);
  if ("regionId" in target) await writeRegionChecklist(db, target.regionId, plan.checklistRows);
  else await writeSeaZoneChecklist(db, target.seaZoneId, plan.checklistRows);

  await pruneChecklist(
    db,
    target,
    taxon,
    plan.checklistRows.map((r) => r.speciesId),
  );
  return {
    applied: plan.checklistRows.length,
    skipped: plan.skippedNames.length,
    skippedNames: plan.skippedNames,
    touched: plan.touched,
  };
}

type ManifestChildRegion = NonNullable<PackManifest["children"]>[number];

/** One bundled region under `parentId` (the country, or a regional group of it), and the
 *  provinces inside it when it's a group. Returns the local region id. */
async function applyChildRegion(
  db: PoolClient,
  child: ManifestChildRegion,
  parentId: string,
  countryId: string,
  dirs: PackDirs,
  taxon: PackManifest["taxon"],
  add: (result: ChecklistResult) => void,
): Promise<string | null> {
  const isGroup = (child.children?.length ?? 0) > 0;
  let childRegionId = (
    await db.query<{ id: string }>(`SELECT id FROM regions WHERE name = $1 AND parent_id = $2`, [child.name, parentId])
  ).rows[0]?.id;
  if (!childRegionId && !isGroup) {
    // The same province elsewhere in the country: the pack and this install disagree on whether
    // it's grouped (one of them predates the country's regional groups). Never a second copy:
    // moved into the pack's group, or left in its group when the pack is ungrouped.
    const elsewhere = await db.query<{ id: string }>(
      `SELECT r.id FROM regions r
       WHERE r.name = $1 AND r.id IN (${descendantIdsSql("$2")})
         AND NOT EXISTS (SELECT 1 FROM regions k WHERE k.parent_id = r.id)
       LIMIT 1`,
      [child.name, countryId],
    );
    childRegionId = elsewhere.rows[0]?.id;
    if (childRegionId && parentId !== countryId) {
      await db.query(`UPDATE regions SET parent_id = $1 WHERE id = $2`, [parentId, childRegionId]);
    }
  }
  if (!childRegionId) {
    childRegionId = (
      await db.query<{ id: string }>(
        `INSERT INTO regions (name, parent_id, ebird_region_code, boundary_geojson, external_codes, occurrence_computed_at, is_overseas_territory)
         VALUES ($1, $2, $3, $4, $5, now(), $6)
         ON CONFLICT (name, parent_id) DO UPDATE SET is_overseas_territory = EXCLUDED.is_overseas_territory
         RETURNING id`,
        [
          child.name,
          parentId,
          child.ebirdRegionCode,
          JSON.stringify(child.boundaryGeoJson),
          child.externalCodes,
          child.isOverseasTerritory ?? false,
        ],
      )
    ).rows[0]?.id;
  } else {
    await db.query(`UPDATE regions SET is_overseas_territory = $2 WHERE id = $1`, [
      childRegionId,
      child.isOverseasTerritory ?? false,
    ]);
  }
  if (!childRegionId) return null;
  add(await applyChecklist(db, child.species, { regionId: childRegionId }, dirs, taxon));
  for (const province of child.children ?? []) {
    await applyChildRegion(db, province, childRegionId, countryId, dirs, taxon, add);
  }
  await db.query(`UPDATE regions SET occurrence_computed_at = now(), has_children = $2 WHERE id = $1`, [
    childRegionId,
    isGroup,
  ]);
  return childRegionId;
}

export async function applyPack(
  db: PoolClient,
  archivePath: string,
): Promise<{
  speciesCount: number;
  skipped: number;
  /** Pack species this install's catalog doesn't have, so they couldn't be added. */
  skippedNames: string[];
  manifest: PackManifest;
  touched: Touched[];
  allChildRegionIds: string[];
  territoryChildRegionIds: string[];
}> {
  const extractDir = mkdtempSync(path.join(os.tmpdir(), "lifer-pack-"));
  try {
    await tar.extract({ file: archivePath, cwd: extractDir, filter: isSafePackEntry });
    const manifest = parseRemoteJson(
      PackManifestSchema,
      JSON.parse(readFileSync(path.join(extractDir, "manifest.json"), "utf-8")),
      "pack's manifest",
    );

    for (const dir of Object.values(PHOTO_DIRS)) mkdirSync(dir, { recursive: true });
    const dirs: PackDirs = { extractDir, ...PHOTO_DIRS };

    // Regions and sea zones match by name, since ids differ between installs.
    let regionId: string | null = null;
    let seaZoneId: string | null = null;
    if (manifest.type === "region" && manifest.region) {
      const res = await db.query<{ id: string }>(`SELECT id FROM regions WHERE name = $1`, [manifest.region]);
      regionId = res.rows[0]?.id ?? null;
    } else if (manifest.type === "seaZone" && manifest.seaZone) {
      const res = await db.query<{ id: string }>(`SELECT id FROM sea_zones WHERE name = $1`, [manifest.seaZone]);
      seaZoneId = res.rows[0]?.id ?? null;
    }

    const total: ChecklistResult = { applied: 0, skipped: 0, skippedNames: [], touched: [] };
    const add = (result: ChecklistResult) => {
      total.applied += result.applied;
      total.skipped += result.skipped;
      total.skippedNames.push(...result.skippedNames);
      total.touched.push(...result.touched);
    };
    if (regionId) add(await applyChecklist(db, manifest.species, { regionId }, dirs, manifest.taxon));
    else if (seaZoneId) add(await applyChecklist(db, manifest.species, { seaZoneId }, dirs, manifest.taxon));

    // Bundled groups and provinces: create the local row if missing, then apply like the country.
    const territoryChildRegionIds: string[] = [];
    const allChildRegionIds: string[] = [];
    if (regionId && manifest.children) {
      for (const child of manifest.children) {
        const childRegionId = await applyChildRegion(db, child, regionId, regionId, dirs, manifest.taxon, add);
        if (!childRegionId) continue;
        allChildRegionIds.push(childRegionId);
        if (child.isOverseasTerritory) territoryChildRegionIds.push(childRegionId);
      }
      await db.query(`UPDATE regions SET has_children = true WHERE id = $1`, [regionId]);
    }

    // The checklist is downloaded data now, so no live computation is needed.
    if (regionId) {
      await db.query(`UPDATE regions SET occurrence_computed_at = now() WHERE id = $1`, [regionId]);
    } else if (seaZoneId) {
      await db.query(`UPDATE sea_zones SET occurrence_computed_at = now() WHERE id = $1`, [seaZoneId]);
    }

    return {
      speciesCount: total.applied,
      skipped: total.skipped,
      skippedNames: [...new Set(total.skippedNames)],
      manifest,
      touched: total.touched,
      allChildRegionIds,
      territoryChildRegionIds,
    };
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}
