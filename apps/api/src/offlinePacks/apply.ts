// Applies a downloaded pack archive in one transaction. A species' photo and description are
// written only once, whichever pack (or live lookup) gets there first; a sea zone shared by
// several countries is downloaded once (see download.ts's dependency queue).
import { existsSync, mkdirSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import type { PoolClient } from "pg";
import { isSafePackEntry, resolveWithinDir } from "./packPaths.js";
import { PHOTO_DIRS } from "./photoStore.js";

interface ManifestSpecies {
  scientificName: string;
  habitatDescription: string | null;
  referenceCredit: string | null;
  referenceLicense: string | null;
  displayFile: string | null;
  thumbFile: string | null;
  // Mirrors build-region-pack.ts's ManifestSpecies, so a pack works offline without live fetches.
  gallery?: Array<{
    photoUrl: string;
    credit: string;
    license: string;
    sortOrder: number;
    focalX: number | null;
    focalY: number | null;
    displayFile: string | null;
    thumbFile: string | null;
    embedding?: number[];
    embeddingModelVersion?: string;
  }>;
  embedding?: number[];
  embeddingModelVersion?: string;
  // Checklist membership. A sea-zone pack only has recordCount.
  localFrequency?: number | null;
  seasonality?: number[] | null;
  localTier?: string | null;
  isVagrant?: boolean;
  recordCount?: number;
  // Why the tier is what it is, or why there's none (packages/shared tierExplain.ts).
  tierReason?: string | null;
  tierExplain?: unknown;
  weeklyFrequency?: number[] | null;
  // Province level only.
  hotspots?: Array<{
    centroidLat: number;
    centroidLon: number;
    pointCount: number;
    bboxDiagonalKm: number;
    lastSeenYear: number | null;
    distinctYears: number | null;
  }>;
}

interface ManifestChildRegion {
  name: string;
  ebirdRegionCode: string | null;
  boundaryGeoJson: unknown;
  externalCodes: string[];
  species: ManifestSpecies[];
  isOverseasTerritory: boolean;
}

export interface PackManifest {
  type: "region" | "seaZone";
  region?: string;
  seaZone?: string;
  // The one taxon class the pack covers, or null for every taxon. When absent the pack only adds
  // to a checklist (see pruneChecklist).
  taxon?: string | null;
  species: ManifestSpecies[];
  // Provinces bundled into a country pack, applied like the country (the local row is created
  // if missing).
  children?: ManifestChildRegion[];
  seaZoneDependencies?: Array<{ name: string; packFile: string }>;
}

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
// are removed. Other Taxa species are the user's own additions and always stay.
async function pruneChecklist(
  db: PoolClient,
  target: { regionId: string } | { seaZoneId: string },
  taxon: string | null | undefined,
  keepIds: string[],
): Promise<number> {
  if (taxon === undefined) return 0;
  const [table, column, id] = "regionId" in target ? ["region_species", "region_id", target.regionId] : ["sea_zone_species", "sea_zone_id", target.seaZoneId];
  const res = await db.query<{ species_id: string }>(
    `DELETE FROM ${table} t USING species s
     WHERE t.${column} = $1 AND s.id = t.species_id AND NOT s.is_other_taxa
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

// Applies one region's or sea zone's species list: enrichment (photo, habitat text) and checklist
// membership. `db` is the pack's transaction client, so a crash mid-apply leaves nothing
// half-written.
async function applyChecklist(
  db: PoolClient,
  species: ManifestSpecies[],
  target: { regionId: string } | { seaZoneId: string },
  extractDir: string,
  displayDir: string,
  thumbDir: string,
  galleryDisplayDir: string,
  galleryThumbDir: string,
  // The pack's taxon scope, for pruning; undefined leaves the checklist's other rows alone.
  taxon: string | null | undefined,
): Promise<{ applied: number; skipped: number; skippedNames: string[]; touched: Array<{ speciesId: string; providedEnrichment: boolean }> }> {
  let skipped = 0;
  const skippedNames: string[] = [];
  const touched: Array<{ speciesId: string; providedEnrichment: boolean }> = [];

  // Bulk reads up front, every decision in memory, then bulk writes, so large packs stay fast.
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
  const existingGalleryRes = speciesIds.length
    ? await db.query<{ id: string; species_id: string; photo_url: string; display_path: string | null; thumb_path: string | null }>(
        `SELECT id, species_id, photo_url, display_path, thumb_path FROM species_reference_photos WHERE species_id = ANY($1)`,
        [speciesIds],
      )
    : { rows: [] as Array<{ id: string; species_id: string; photo_url: string; display_path: string | null; thumb_path: string | null }> };
  const existingGalleryByKey = new Map(existingGalleryRes.rows.map((r) => [`${r.species_id}:${r.photo_url}`, r]));
  // Blocklisted photos (maps and other non-photos) are never installed, even if a pack has them.
  const blockedPhotos = new Set(
    (await db.query<{ photo_url: string }>(`SELECT photo_url FROM reference_photo_blocklist`)).rows.map((r) => r.photo_url),
  );
  // Final row id per gallery photo: prefetched, or filled in from the upsert's RETURNING.
  const galleryPhotoIdByKey = new Map([...existingGalleryByKey.entries()].map(([k, r]) => [k, r.id] as const));

  const enrichmentUpdates: Array<{
    id: string;
    habitat: string | null;
    credit: string | null;
    license: string | null;
    display: string | null;
    thumb: string | null;
  }> = [];
  const galleryUpserts: Array<{
    speciesId: string;
    photoUrl: string;
    credit: string;
    license: string;
    sortOrder: number;
    focalX: number | null;
    focalY: number | null;
    display: string | null;
    thumb: string | null;
  }> = [];
  const galleryEmbeddingCandidates: Array<{ speciesId: string; photoUrl: string; embedding: number[]; modelVersion: string }> = [];
  const speciesEmbeddings: Array<{ speciesId: string; embedding: number[]; modelVersion: string }> = [];
  // Every matched species is marked "gallery already tried": the pack build ran the same gallery
  // lookup, so viewing it shouldn't trigger a live fetch.
  const galleryBackfilledIds: string[] = [];
  const checklistRows: Array<{ speciesId: string; sp: ManifestSpecies }> = [];
  // Copies are queued and run together after the loop (destinations derive from row ids).
  const copyTasks: Array<{ src: string; dest: string }> = [];

  for (const sp of species) {
    const row = speciesByName.get(sp.scientificName);
    // A species this install's catalog doesn't have: nothing to apply.
    if (!row) {
      skipped++;
      skippedNames.push(sp.scientificName);
      continue;
    }
    galleryBackfilledIds.push(row.id);

    // Enrichment fills in only for a species not yet enriched, or whose display or thumb file
    // is missing or unrecorded (a catalog seed sets enriched_at without any image files).
    // Checklist membership below applies either way.
    const referenceFileMissing =
      (!!sp.displayFile && (row.reference_display_path == null || !existsSync(row.reference_display_path))) ||
      (!!sp.thumbFile && (row.reference_thumb_path == null || !existsSync(row.reference_thumb_path)));
    const providedEnrichment = !row.enriched_at || referenceFileMissing;
    if (providedEnrichment) {
      const displaySource = sp.displayFile ? resolveWithinDir(extractDir, sp.displayFile) : null;
      const thumbSource = sp.thumbFile ? resolveWithinDir(extractDir, sp.thumbFile) : null;

      let displayPath: string | null = null;
      let thumbPath: string | null = null;
      if (displaySource && existsSync(displaySource)) {
        displayPath = path.join(displayDir, `${row.id}.webp`);
        copyTasks.push({ src: displaySource, dest: displayPath });
      }
      if (thumbSource && existsSync(thumbSource)) {
        thumbPath = path.join(thumbDir, `${row.id}.webp`);
        copyTasks.push({ src: thumbSource, dest: thumbPath });
      }

      enrichmentUpdates.push({
        id: row.id,
        habitat: sp.habitatDescription,
        credit: sp.referenceCredit,
        license: sp.referenceLicense,
        display: displayPath,
        thumb: thumbPath,
      });
    }

    // Gallery photos and the reference embedding are checked on their own terms, independent of
    // the enrichment gate above.
    if (sp.gallery && sp.gallery.length > 0) {
      for (const g of sp.gallery) {
        // sortOrder names the photo's file, so anything but an integer could escape the folder.
        if (blockedPhotos.has(g.photoUrl) || !Number.isSafeInteger(g.sortOrder)) continue;
        const existingGalleryRow = existingGalleryByKey.get(`${row.id}:${g.photoUrl}`);
        const galleryFileMissing =
          !existingGalleryRow ||
          (existingGalleryRow.display_path != null && !existsSync(existingGalleryRow.display_path)) ||
          (existingGalleryRow.thumb_path != null && !existsSync(existingGalleryRow.thumb_path));

        if (galleryFileMissing) {
          const gDisplaySource = g.displayFile ? resolveWithinDir(extractDir, g.displayFile) : null;
          const gThumbSource = g.thumbFile ? resolveWithinDir(extractDir, g.thumbFile) : null;
          let gDisplayPath: string | null = existingGalleryRow?.display_path ?? null;
          let gThumbPath: string | null = existingGalleryRow?.thumb_path ?? null;
          if (gDisplaySource && existsSync(gDisplaySource)) {
            gDisplayPath = path.join(galleryDisplayDir, `${row.id}-${g.sortOrder}.webp`);
            copyTasks.push({ src: gDisplaySource, dest: gDisplayPath });
          }
          if (gThumbSource && existsSync(gThumbSource)) {
            gThumbPath = path.join(galleryThumbDir, `${row.id}-${g.sortOrder}.webp`);
            copyTasks.push({ src: gThumbSource, dest: gThumbPath });
          }
          galleryUpserts.push({
            speciesId: row.id,
            photoUrl: g.photoUrl,
            credit: g.credit,
            license: g.license,
            sortOrder: g.sortOrder,
            focalX: g.focalX,
            focalY: g.focalY,
            display: gDisplayPath,
            thumb: gThumbPath,
          });
        }

        // Kept even without the photo's file (a "small" pack) or when the row already exists.
        if (g.embedding && g.embeddingModelVersion) {
          galleryEmbeddingCandidates.push({ speciesId: row.id, photoUrl: g.photoUrl, embedding: g.embedding, modelVersion: g.embeddingModelVersion });
        }
      }
    }

    // Only fills a missing vector. Ranking joins on the current model version, so a row from
    // another version just sits unused.
    if (sp.embedding && sp.embeddingModelVersion) {
      speciesEmbeddings.push({ speciesId: row.id, embedding: sp.embedding, modelVersion: sp.embeddingModelVersion });
    }

    checklistRows.push({ speciesId: row.id, sp });
    touched.push({ speciesId: row.id, providedEnrichment });
  }

  // Files land before any row points at them.
  await copyFilesConcurrently(copyTasks);

  for (const batch of chunkRows(enrichmentUpdates, BULK_BATCH_SIZE)) {
    const values: unknown[] = [];
    const rows = batch.map((u, i) => {
      const base = i * 6;
      values.push(u.id, u.habitat, u.credit, u.license, u.display, u.thumb);
      return `($${base + 1}::uuid, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
    });
    await db.query(
      `UPDATE species AS s SET
         habitat_description = COALESCE(s.habitat_description, v.habitat),
         reference_credit = COALESCE(s.reference_credit, v.credit),
         reference_license = COALESCE(s.reference_license, v.license),
         reference_display_path = COALESCE(v.display, s.reference_display_path),
         reference_thumb_path = COALESCE(v.thumb, s.reference_thumb_path),
         enriched_at = now()
       FROM (VALUES ${rows.join(", ")}) AS v(id, habitat, credit, license, display, thumb)
       WHERE s.id = v.id`,
      values,
    );
  }

  // COALESCE keeps a value an earlier enrich already set.
  for (const batch of chunkRows(galleryBackfilledIds, BULK_BATCH_SIZE)) {
    await db.query(`UPDATE species SET gallery_backfilled_at = COALESCE(gallery_backfilled_at, now()) WHERE id = ANY($1::uuid[])`, [
      batch,
    ]);
  }

  for (const batch of chunkRows(galleryUpserts, BULK_BATCH_SIZE)) {
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
    for (const r of res.rows) galleryPhotoIdByKey.set(`${r.species_id}:${r.photo_url}`, r.id);
  }

  const galleryEmbeddingRows = galleryEmbeddingCandidates
    .map((e) => ({ ...e, referencePhotoId: galleryPhotoIdByKey.get(`${e.speciesId}:${e.photoUrl}`) ?? null }))
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

  for (const batch of chunkRows(speciesEmbeddings, BULK_BATCH_SIZE)) {
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

  if ("regionId" in target) {
    for (const batch of chunkRows(checklistRows, BULK_BATCH_SIZE)) {
      const values: unknown[] = [];
      const rows = batch.map(({ speciesId, sp }, i) => {
        const base = i * 9;
        values.push(
          target.regionId,
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
        await db.query(`DELETE FROM region_species_hotspots WHERE region_id = $1 AND species_id = ANY($2)`, [target.regionId, idBatch]);
      }
      const hotspotRows = speciesWithHotspots.flatMap(({ speciesId, sp }) => sp.hotspots!.map((h) => ({ speciesId, h })));
      for (const hotspotBatch of chunkRows(hotspotRows, BULK_BATCH_SIZE)) {
        const values: unknown[] = [];
        const rowPlaceholders = hotspotBatch.map(({ speciesId, h }, idx) => {
          const base = idx * 8;
          values.push(target.regionId, speciesId, h.centroidLat, h.centroidLon, h.pointCount, h.bboxDiagonalKm, h.lastSeenYear, h.distinctYears);
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
  } else {
    for (const batch of chunkRows(checklistRows, BULK_BATCH_SIZE)) {
      const values: unknown[] = [];
      const rows = batch.map(({ speciesId, sp }, i) => {
        const base = i * 3;
        values.push(target.seaZoneId, speciesId, sp.recordCount ?? 0);
        return `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3})`;
      });
      await db.query(
        `INSERT INTO sea_zone_species (sea_zone_id, species_id, record_count)
         VALUES ${rows.join(", ")}
         ON CONFLICT (sea_zone_id, species_id) DO UPDATE SET record_count = EXCLUDED.record_count`,
        values,
      );
    }
  }

  await pruneChecklist(db, target, taxon, checklistRows.map((r) => r.speciesId));
  return { applied: checklistRows.length, skipped, skippedNames, touched };
}

export async function applyPack(db: PoolClient, archivePath: string): Promise<{
  speciesCount: number;
  skipped: number;
  /** Pack species this install's catalog doesn't have, so they couldn't be added. */
  skippedNames: string[];
  manifest: PackManifest;
  touched: Array<{ speciesId: string; providedEnrichment: boolean }>;
  allChildRegionIds: string[];
  territoryChildRegionIds: string[];
}> {
  const extractDir = mkdtempSync(path.join(os.tmpdir(), "lifer-pack-"));
  try {
    await tar.extract({ file: archivePath, cwd: extractDir, filter: isSafePackEntry });
    const manifest = JSON.parse(readFileSync(path.join(extractDir, "manifest.json"), "utf-8")) as PackManifest;

    const { display: displayDir, thumb: thumbDir, galleryDisplay: galleryDisplayDir, galleryThumb: galleryThumbDir } = PHOTO_DIRS;
    for (const dir of Object.values(PHOTO_DIRS)) mkdirSync(dir, { recursive: true });

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

    let applied = 0;
    let skipped = 0;
    const skippedNames: string[] = [];
    const touched: Array<{ speciesId: string; providedEnrichment: boolean }> = [];
    if (regionId) {
      const result = await applyChecklist(db, manifest.species, { regionId }, extractDir, displayDir, thumbDir, galleryDisplayDir, galleryThumbDir, manifest.taxon);
      applied += result.applied;
      skipped += result.skipped;
      skippedNames.push(...result.skippedNames);
      touched.push(...result.touched);
    } else if (seaZoneId) {
      const result = await applyChecklist(db, manifest.species, { seaZoneId }, extractDir, displayDir, thumbDir, galleryDisplayDir, galleryThumbDir, manifest.taxon);
      applied += result.applied;
      skipped += result.skipped;
      skippedNames.push(...result.skippedNames);
      touched.push(...result.touched);
    }

    // Bundled provinces: create the local row if missing, then apply like the country.
    const territoryChildRegionIds: string[] = [];
    const allChildRegionIds: string[] = [];
    if (regionId && manifest.children) {
      for (const child of manifest.children) {
        await db.query(
          `INSERT INTO regions (name, parent_id, ebird_region_code, boundary_geojson, external_codes, occurrence_computed_at, is_overseas_territory)
           VALUES ($1, $2, $3, $4, $5, now(), $6)
           ON CONFLICT (name, parent_id) DO UPDATE SET is_overseas_territory = EXCLUDED.is_overseas_territory`,
          [
            child.name,
            regionId,
            child.ebirdRegionCode,
            JSON.stringify(child.boundaryGeoJson),
            child.externalCodes,
            child.isOverseasTerritory ?? false,
          ],
        );
        const childRegionRes = await db.query<{ id: string }>(`SELECT id FROM regions WHERE name = $1 AND parent_id = $2`, [
          child.name,
          regionId,
        ]);
        const childRegionId = childRegionRes.rows[0]?.id;
        if (!childRegionId) continue;
        allChildRegionIds.push(childRegionId);
        if (child.isOverseasTerritory) territoryChildRegionIds.push(childRegionId);
        const result = await applyChecklist(
          db,
          child.species,
          { regionId: childRegionId },
          extractDir,
          displayDir,
          thumbDir,
          galleryDisplayDir,
          galleryThumbDir,
          manifest.taxon,
        );
        applied += result.applied;
        skipped += result.skipped;
        skippedNames.push(...result.skippedNames);
        touched.push(...result.touched);
        await db.query(`UPDATE regions SET occurrence_computed_at = now(), has_children = false WHERE id = $1`, [childRegionId]);
      }
      await db.query(`UPDATE regions SET has_children = true WHERE id = $1`, [regionId]);
    }

    // The checklist is downloaded data now, so no live computation is needed.
    if (regionId) {
      await db.query(`UPDATE regions SET occurrence_computed_at = now() WHERE id = $1`, [regionId]);
    } else if (seaZoneId) {
      await db.query(`UPDATE sea_zones SET occurrence_computed_at = now() WHERE id = $1`, [seaZoneId]);
    }

    return { speciesCount: applied, skipped, skippedNames: [...new Set(skippedNames)], manifest, touched, allChildRegionIds, territoryChildRegionIds };
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}
