// Downloads and applies packs built by data-pipeline's
// build-region-pack.ts. Two kinds of duplication are guarded against, at two different
// layers: a sea-zone pack shared by several countries is only ever fetched once (tracked by
// pack id in downloaded_packs — see applyPack's dependency queue below), and a species whose
// range spans two packs (e.g. present in both a "North America" and "Central America" pack)
// only ever gets its photo/description written once (a species already enriched, by ANY
// earlier pack or the app's own lazy path, is left alone — see applyPack's dedup check).
import { existsSync, mkdirSync, readFileSync, rmSync, mkdtempSync, statSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { requireAuth } from "../auth/session.js";
import { APP_DATA_DIR, PACK_INDEX_URL } from "../config.js";
// Cross-package import, same convention as regions/routes.ts's own build-region-species.js
// import — pure id-derivation logic with no heavy runtime deps.
import { packIdFromFileName } from "data-pipeline/src/build/pack-id.js";
import { subdivisionLabelFor } from "@lifer/shared";
import { createJob, type JobContext } from "../lib/job.js";
import { catalogFirstBootState, waitForFirstBootCatalog } from "../species/catalogSeedUpdate.js";
import { downloadToFile } from "../lib/download.js";
import { isSafePackEntry, resolveWithinDir } from "./packPaths.js";

export interface PackIndexEntry {
  id: string;
  type: "region" | "seaZone";
  region?: string;
  seaZone?: string;
  taxon?: string | null;
  // "small" ships the same checklist/embeddings as "full" but without the reference-photo
  // gallery (only the single featured photo per species), a much smaller download for anyone
  // fine fetching extra gallery photos on demand once online. Absent on any pack built before
  // this existed, which always means "full".
  variant?: "full" | "small";
  sizeBytes: number;
  speciesCount: number;
  // Content hash of the pack's manifest (see build-region-pack.ts's contentHash) — lets an
  // already-downloaded pack be recognized as stale when its upstream content changes, instead
  // of dedup being purely "have I ever downloaded this id" forever.
  contentVersion: string;
  // Deduplicated across the pack's own top-level species and every bundled child region's
  // species (build-pack-index.ts does the dedup — a country pack's manifest doesn't
  // deduplicate those against each other) — the only thing /offline-packs/recommend needs to
  // score a pack's coverage against a list of missing species.
  scientificNames: string[];
  url: string;
  // Sea zone pack IDs this (region-type) pack depends on (build-region-pack.ts's own
  // seaZoneDependencies, reduced from {name, packFile} pairs to just the pack id derived from
  // packFile) — lets the client group a country's dependency sea zones under "<Country> - Sea
  // zones" instead of each one showing up as its own top-level entry in the downloaded-packs
  // list. IDs, not zone names, because a zone can have several packs now (one per taxon) — a
  // "Canada (Fish)" pack's dependency here points at that zone's fish-taxon pack specifically,
  // never its other taxon-scoped packs. Undefined for sea-zone packs themselves and any region
  // pack with none.
  seaZoneDependencies?: string[];
}

export interface PackIndex {
  generatedAt: string;
  packs: PackIndexEntry[];
}

export async function fetchPackIndex(): Promise<PackIndex> {
  if (!PACK_INDEX_URL) throw new Error("No pack index is configured for this instance yet");
  const res = await fetch(PACK_INDEX_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Couldn't fetch the pack index (${res.status})`);
  return (await res.json()) as PackIndex;
}

// The index itself comes from a trusted, operator-configured URL (PACK_INDEX_URL), but each
// individual pack's `url` is just a field inside that fetched JSON — if the index host were
// ever compromised or MITM'd, an entry could point this server's outbound fetch() at an
// internal service (a LAN admin panel, a cloud metadata endpoint) instead of a real pack.
// Requiring every pack to be hosted on the same origin as the index it came from keeps the
// server's outbound requests confined to wherever the operator actually pointed it.
function assertTrustedPackUrl(url: string): void {
  if (!PACK_INDEX_URL) throw new Error("No pack index is configured for this instance yet");
  const packOrigin = new URL(url).origin;
  const indexOrigin = new URL(PACK_INDEX_URL).origin;
  if (packOrigin !== indexOrigin) {
    throw new Error(`Refusing to fetch a pack from an untrusted origin: ${packOrigin}`);
  }
}

interface ManifestSpecies {
  scientificName: string;
  habitatDescription: string | null;
  referenceCredit: string | null;
  referenceLicense: string | null;
  displayFile: string | null;
  thumbFile: string | null;
  // Mirrors build-region-pack.ts's own ManifestSpecies.gallery/embedding. See that file's
  // comment for why these are here at all (a pack used to ship neither, leaving both
  // dependent on a live network call or a lazy per-view fetch that never happens for most of
  // a freshly downloaded region's species).
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
  // Checklist membership — see build-region-pack.ts's ManifestSpecies for why this rides
  // along in the same entry rather than a separate list. Omitted entirely for a sea-zone
  // pack except recordCount.
  localFrequency?: number | null;
  seasonality?: number[] | null;
  localTier?: string | null;
  isVagrant?: boolean;
  recordCount?: number;
  weeklyFrequency?: number[] | null;
  // Province-level only — see build-region-pack.ts's identical field for why this is never
  // populated for a country's own top-level species list.
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

interface PackManifest {
  type: "region" | "seaZone";
  region?: string;
  seaZone?: string;
  species: ManifestSpecies[];
  // Provinces/states bundled into a country pack (see build-region-pack.ts's
  // fetchChildRegionsWithSpecies) — applied the same way as the top-level region, just
  // against a local province row this install may not have yet (created here if missing).
  children?: ManifestChildRegion[];
  seaZoneDependencies?: Array<{ name: string; packFile: string }>;
}

// Applies one region/sea-zone's species list — enrichment fields (photo/habitat text) plus
// checklist membership (region_species/sea_zone_species). Shared between the top-level
// region a pack is named after and any provinces/states bundled into it (see
// build-region-pack.ts's fetchChildRegionsWithSpecies) — a province is applied exactly the
// same way, just against its own local region row instead of the country's.
// Row-batch size for every bulk statement below — keeps well under Postgres's ~65535
// bind-parameter ceiling regardless of how many columns a given statement uses (same 500 the
// hotspot batching below already validated safe at 8 columns/row).
const BULK_BATCH_SIZE = 500;

function chunkRows<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Reference/gallery photo copies used to happen one at a time via the synchronous copyFileSync,
// blocking the event loop for each individual file — for a pack with hundreds of species
// carrying several gallery photos each, that's roughly a thousand sequential filesystem round
// trips, real cost on a bind-mounted Docker volume or NAS-backed storage (each syscall's own
// latency, not overlapped with the next). Every source->destination pair is already fully known
// by the time copying starts (species matching already ran, in bulk, before this) — there's no
// dependency between one photo's copy and another's, so there's no reason to serialize them.
// Runs with bounded concurrency, not fully unbounded: a pack can carry thousands of files, and
// firing them all as one Promise.all would open that many file descriptors/reads at once.
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

// `db` is always a checked-out transaction client (see runDownloadJob's own BEGIN/COMMIT), never
// the raw pool — every write below must live or die with the rest of this SAME pack's apply, so
// a crash or restart mid-apply (a server redeploy, a container OOM — not something a user can be
// relied on to never trigger) rolls back to nothing-applied instead of leaving a checklist
// half-written, the exact shape of bug a partial British Columbia checklist turned out to be.
async function applyChecklist(
  db: PoolClient,
  species: ManifestSpecies[],
  target: { regionId: string } | { seaZoneId: string },
  extractDir: string,
  displayDir: string,
  thumbDir: string,
  galleryDisplayDir: string,
  galleryThumbDir: string,
): Promise<{ applied: number; skipped: number; touched: Array<{ speciesId: string; providedEnrichment: boolean }> }> {
  let skipped = 0;
  const touched: Array<{ speciesId: string; providedEnrichment: boolean }> = [];

  // Every write below used to happen one species (and one gallery photo) at a time — for a
  // country the size of Canada (900+ species, several gallery photos each once the per-photo
  // embedding feature shipped), that's tens of thousands of sequential awaited round-trips to
  // apply a single pack, the exact reason a real update could sit for a long time with the
  // progress bar barely moving. Fixed the same way the hotspot batching further down already
  // fixed its own version of this problem: read everything this function needs in a handful of
  // bulk queries up front, do all the per-species/per-photo DECISION-MAKING in memory (no DB
  // calls at all in the loop below), then write everything back in a handful of bulk
  // statements at the end instead of one round-trip per row.
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
  // Resolves every gallery photo's final row id once the bulk upsert below runs — a photo that
  // didn't need re-upserting keeps its prefetched id; one that did gets it filled in from that
  // upsert's own RETURNING.
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
  // Every species this pack actually matched locally, regardless of whether providedEnrichment
  // or galleryUpserts ended up touching it (a species can already be enriched from an earlier,
  // gallery-less pack and only need its gallery filled in here, or vice versa) - the pack's own
  // build already ran the same iNaturalist gallery lookup this app would do live, empty result
  // included, so every one of these species should read as "gallery already tried" the same way
  // a live lazy-enrich marks it, not just the ones that happened to get new gallery rows this
  // time. Confirmed live: without this, a self-hosted (non-desktop) install still fired a live,
  // user-visible iNaturalist gallery fetch on the first view of EVERY pack-covered species,
  // even ones the pack fully covered - the exact "a pack should work fully offline" guarantee
  // this field exists to protect, just never actually set by pack apply.
  const galleryBackfilledIds: string[] = [];
  const checklistRows: Array<{ speciesId: string; sp: ManifestSpecies }> = [];
  // Every file copy this loop decides on gets queued here instead of run inline — the
  // destination path is deterministic (derived from row.id, computable with zero I/O), so
  // there's nothing gained by actually copying bytes synchronously mid-loop. Run once, all at
  // once, after every species has been decided (see copyFilesConcurrently's own comment).
  const copyTasks: Array<{ src: string; dest: string }> = [];

  for (const sp of species) {
    const row = speciesByName.get(sp.scientificName);
    // No local match — a pack can reference species this install's own seed doesn't have
    // (different taxonomy version, etc.) — nothing at all to apply for this entry.
    if (!row) {
      skipped++;
      continue;
    }
    galleryBackfilledIds.push(row.id);

    // Enrichment fields (photo/habitat text) only fill in if this species hasn't already
    // been enriched by something else (its own lazy fetch, or an earlier pack) — see this
    // file's top comment on the cross-pack dedup. Checklist membership below is applied
    // regardless of enrichment status: a species can already be enriched yet still need
    // its region_species row for THIS newly-downloaded region.
    //
    // enriched_at alone isn't enough, though: species/region data restored from a portable
    // catalog seed (see desktop's embedded_db.rs) arrives with enriched_at already set but
    // NONE of the cached image files, deliberately — that's the whole reason a pack bundles
    // its own copies. Treating "enriched_at is set" as "nothing to do" would skip extracting
    // those images forever, even though this pack has exactly what's missing. Re-running the
    // copy whenever the currently-recorded path doesn't actually resolve on disk covers both:
    // a genuinely fresh species (never enriched at all) and one whose data moved here without
    // its files. Checked independently for display AND thumb — a species can have one file
    // present and the other missing (e.g. a partial extraction), and treating "display exists"
    // as "nothing to do" left the thumb 404ing forever even after re-downloading the pack.
    const referenceFileMissing =
      (row.reference_display_path != null && !existsSync(row.reference_display_path)) ||
      (row.reference_thumb_path != null && !existsSync(row.reference_thumb_path));
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

    // Gallery photos and the auto-suggest reference embedding, independent of the
    // providedEnrichment gate above: a species can already have its main photo (enriched by
    // an earlier, gallery/embedding-less pack, or this app's own version before this feature
    // existed) while still missing either of these entirely. Each checked and applied on its
    // own terms rather than folded into the "already enriched, skip" branch.
    if (sp.gallery && sp.gallery.length > 0) {
      for (const g of sp.gallery) {
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

        // Independent of the file-presence gate above (same reasoning as the main species
        // embedding block below): a gallery photo's embedding is worth having even on a
        // "small" pack that never bundled that photo's actual file, and even on a re-run where
        // the photo row and its files already exist but this photo was never embedded before.
        if (g.embedding && g.embeddingModelVersion) {
          galleryEmbeddingCandidates.push({ speciesId: row.id, photoUrl: g.photoUrl, embedding: g.embedding, modelVersion: g.embeddingModelVersion });
        }
      }
    }

    // Never overwrites an existing row: a species already embedded (this app's own lazy
    // enrichment, or an earlier pack) already has a usable vector; the pack's copy only fills
    // in a genuinely missing one. A version mismatch against this install's current model
    // isn't a concern to guard against here either: rankSpeciesByEmbedding/rankSpeciesByEmbeddings
    // only ever join on the CURRENT EMBEDDING_MODEL_VERSION, so a stale-version row would
    // simply sit unused, not get matched against by mistake.
    if (sp.embedding && sp.embeddingModelVersion) {
      speciesEmbeddings.push({ speciesId: row.id, embedding: sp.embedding, modelVersion: sp.embeddingModelVersion });
    }

    checklistRows.push({ speciesId: row.id, sp });
    touched.push({ speciesId: row.id, providedEnrichment });
  }

  // Every copy runs concurrently with every OTHER copy (see copyFilesConcurrently's own
  // comment) but this whole batch is awaited BEFORE any DB write below starts, not after —
  // each bulk UPDATE/INSERT commits as soon as its own await resolves, independent of
  // anything else in this function, so a row claiming a display/thumb path must not go live
  // until the actual file at that path exists. A concurrent request (another user's page load,
  // mid-download) reading a species' reference_display_path the instant after this species'
  // row commits must always find a real file there.
  await copyFilesConcurrently(copyTasks);

  // --- Bulk writes below — replaces what used to be one query per species/photo above. ---

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

  // See galleryBackfilledIds' own comment above for why every matched species gets this, not
  // just the ones with new galleryUpserts rows this time. COALESCE keeps a value already set
  // by a live lazy-enrich (or an earlier pack) rather than clobbering it.
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
        const base = i * 7;
        values.push(target.regionId, speciesId, sp.localFrequency ?? null, sp.seasonality ?? null, sp.localTier ?? null, sp.isVagrant ?? false, sp.weeklyFrequency ?? null);
        return `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
      });
      await db.query(
        `INSERT INTO region_species (region_id, species_id, local_frequency, seasonality, local_tier, is_vagrant, weekly_frequency)
         VALUES ${rows.join(", ")}
         ON CONFLICT (region_id, species_id) DO UPDATE SET
           local_frequency = EXCLUDED.local_frequency,
           seasonality = EXCLUDED.seasonality,
           local_tier = EXCLUDED.local_tier,
           is_vagrant = EXCLUDED.is_vagrant,
           weekly_frequency = EXCLUDED.weekly_frequency`,
        values,
      );
    }

    // Gap-finder hotspot clusters — province-level only (sp.hotspots is undefined for a
    // country's own top-level species list, so this never runs there). Delete-then-reinsert,
    // same freshness pattern as compute-provinces-bulk.ts's own write.
    //
    // This used to loop per SPECIES (one DELETE + a batched INSERT per species) — the row
    // batching inside each species' own insert didn't help because the loop itself, and the
    // DELETE, stayed sequential across species. For a province-bundling country pack (Canada's
    // aves pack alone reapplies birds' hotspot data across 13 provinces, each with hundreds of
    // species carrying hotspot clusters), that's thousands of sequential awaited round-trips —
    // confirmed live as the actual cause of a "small" pack selection (a few hundred MB) still
    // taking 10+ minutes to apply, far longer than an unrelated flat file download of several
    // times that size. Batched across every species in this region/province at once instead,
    // same bulk-write pattern as everything else in this function.
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

  return { applied: checklistRows.length, skipped, touched };
}

async function applyPack(db: PoolClient, archivePath: string): Promise<{
  speciesCount: number;
  skipped: number;
  manifest: PackManifest;
  touched: Array<{ speciesId: string; providedEnrichment: boolean }>;
  allChildRegionIds: string[];
  territoryChildRegionIds: string[];
}> {
  const extractDir = mkdtempSync(path.join(os.tmpdir(), "lifer-pack-"));
  try {
    await tar.extract({ file: archivePath, cwd: extractDir, filter: isSafePackEntry });
    const manifest = JSON.parse(readFileSync(path.join(extractDir, "manifest.json"), "utf-8")) as PackManifest;

    const displayDir = path.join(APP_DATA_DIR, "reference-display");
    const thumbDir = path.join(APP_DATA_DIR, "reference-thumb");
    const galleryDisplayDir = path.join(APP_DATA_DIR, "reference-gallery-display");
    const galleryThumbDir = path.join(APP_DATA_DIR, "reference-gallery-thumb");
    mkdirSync(displayDir, { recursive: true });
    mkdirSync(thumbDir, { recursive: true });
    mkdirSync(galleryDisplayDir, { recursive: true });
    mkdirSync(galleryThumbDir, { recursive: true });

    // Resolved once, not per species — the checklist membership a pack carries is applied
    // against this install's own local region/sea-zone row, matched by name (the same
    // cross-install identity approach as species-by-scientific-name; every install seeds an
    // identical regions/sea_zones table, just with its own UUIDs).
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
    const touched: Array<{ speciesId: string; providedEnrichment: boolean }> = [];
    if (regionId) {
      const result = await applyChecklist(db, manifest.species, { regionId }, extractDir, displayDir, thumbDir, galleryDisplayDir, galleryThumbDir);
      applied += result.applied;
      skipped += result.skipped;
      touched.push(...result.touched);
    } else if (seaZoneId) {
      const result = await applyChecklist(db, manifest.species, { seaZoneId }, extractDir, displayDir, thumbDir, galleryDisplayDir, galleryThumbDir);
      applied += result.applied;
      skipped += result.skipped;
      touched.push(...result.touched);
    }

    // Provinces/states bundled into a country pack — create the local region row if this
    // install doesn't have it yet (matched by name; same cross-install identity approach as
    // everything else here), then apply its checklist exactly like the country's own.
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
        );
        applied += result.applied;
        skipped += result.skipped;
        touched.push(...result.touched);
        await db.query(`UPDATE regions SET occurrence_computed_at = now(), has_children = false WHERE id = $1`, [childRegionId]);
      }
      await db.query(`UPDATE regions SET has_children = true WHERE id = $1`, [regionId]);
    }

    // Checklist membership is now real, downloaded data — the region no longer needs (and,
    // going forward, should never trigger) a live GBIF computation of its own.
    if (regionId) {
      await db.query(`UPDATE regions SET occurrence_computed_at = now() WHERE id = $1`, [regionId]);
    } else if (seaZoneId) {
      await db.query(`UPDATE sea_zones SET occurrence_computed_at = now() WHERE id = $1`, [seaZoneId]);
    }

    return { speciesCount: applied, skipped, manifest, touched, allChildRegionIds, territoryChildRegionIds };
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

// Extra status fields on top of JobStatus. `packIds` lets a client that remounts mid-job
// reconstruct which packs to show as "updating"; `currentPack` mirrors currentItem for older
// clients. Packs already applied before a cancel stay applied (each commits on its own).
interface DownloadJobExtra {
  packIds: string[];
  currentPack: string | null;
}
const downloadJob = createJob<{ packsApplied: number }, DownloadJobExtra>("pack-download", { packIds: [], currentPack: null });

function startDownloadJob(packIds: string[], force = false): boolean {
  return downloadJob.start((ctx) => runDownloadJob(ctx, packIds, force), { packIds, total: packIds.length, processed: 0 });
}

async function runDownloadJob(ctx: JobContext<{ packsApplied: number }, DownloadJobExtra>, requestedPackIds: string[], force = false): Promise<{ packsApplied: number }> {
  const job = downloadJob.status;
  let packsApplied = 0;
  const index = await fetchPackIndex();
  const byId = new Map(index.packs.map((p) => [p.id, p]));

  const queue = [...requestedPackIds];
  const seen = new Set<string>();
  const done = () => ctx.update({ processed: (job.processed ?? 0) + 1 });

  while (queue.length > 0) {
    ctx.throwIfCancelled();
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    ctx.update({ currentItem: id, currentPack: id, total: seen.size + queue.length, phase: "downloading", downloadedBytes: 0, totalBytes: null });

    const entry = byId.get(id);
    if (!entry) {
      // Unknown pack id (index changed since the client's copy, a stale dependency
      // reference), skip it rather than fail the whole job over one bad entry.
      done();
      continue;
    }

    // Only skip when the CONTENT hasn't changed, a pack already downloaded at an older
    // content_version proceeds through the same download+apply flow below to pick up the
    // update (safe to re-apply: enrichment writes are COALESCE-guarded, checklist upserts
    // are ON CONFLICT DO UPDATE, see applyPack's own comments). `force` bypasses this check
    // entirely, needed by Fix 8's "re-add a province" flow, which redownloads an
    // ALREADY-current-version pack specifically to restore a province whose region_species
    // rows were individually offloaded (content_version never changed, so the normal skip
    // would otherwise make this whole flow a no-op, confirmed live).
    if (!force) {
      const already = await pool.query<{ content_version: string | null }>(
        `SELECT content_version FROM downloaded_packs WHERE pack_id = $1`,
        [id],
      );
      if (already.rows.length > 0 && already.rows[0].content_version === entry.contentVersion) {
        done();
        continue;
      }
    }

    assertTrustedPackUrl(entry.url);
    const tmpFile = path.join(os.tmpdir(), `${id}.pack.tar.gz`);
    try {
      // Streamed to disk with a stall timeout rather than a total cap, and the job's signal
      // aborts the body read too, so cancel stops the current pack immediately.
      let bytes: number;
      try {
        ({ bytes } = await downloadToFile(entry.url, tmpFile, {
          signal: ctx.signal,
          onProgress: (downloadedBytes, totalBytes) => ctx.update({ downloadedBytes, totalBytes }),
        }));
      } catch (err) {
        ctx.throwIfCancelled();
        throw new Error(`Couldn't download "${id}": ${(err as Error).message}`);
      }
      ctx.throwIfCancelled();
      // On a brand-new server the species catalog may still be loading (see
      // seedCatalogIfEmpty). The pack file is already downloaded; only writing it has to wait.
      if (catalogFirstBootState() === "running") {
        ctx.update({ phase: "preparing" });
        await waitForFirstBootCatalog();
        ctx.throwIfCancelled();
      } else if (catalogFirstBootState() === "failed") {
        await waitForFirstBootCatalog();
      }
      ctx.update({ phase: "applying" });

      // Everything from here through the territory cleanup below runs inside ONE transaction —
      // a pack (country + every bundled province) is either fully applied or not applied at
      // all. Without this, a server restart mid-apply (a redeploy, a container OOM — a real
      // Docker/NAS scenario, not just a user hitting refresh) commits whatever batches had
      // already run and abandons the rest, leaving a genuinely half-written checklist behind
      // with no obvious sign anything went wrong (confirmed live: exactly how a British Columbia
      // checklist ended up with a small fraction of its real species count).
      const client = await pool.connect();
      let manifest: PackManifest;
      try {
        await client.query("BEGIN");
        const applyResult = await applyPack(client, tmpFile);
        const speciesCount = applyResult.speciesCount;
        manifest = applyResult.manifest;
        const { touched, allChildRegionIds, territoryChildRegionIds } = applyResult;

        // applied_province_region_ids resets on every (re)download — applyPack's children loop
        // unconditionally restores every province each time, so any prior per-province exclusion
        // (Fix 8) no longer reflects reality once this runs. Defaults to excluding overseas
        // territories specifically (NULL/"all applied" only when there are none) rather than
        // requiring the user to manually offload each one after every fresh download — they can
        // still opt one back in via the same province checklist Fix 8 already built.
        const defaultAppliedProvinceIds =
          territoryChildRegionIds.length > 0 ? JSON.stringify(allChildRegionIds.filter((rid) => !territoryChildRegionIds.includes(rid))) : null;
        await client.query(
          `INSERT INTO downloaded_packs (pack_id, region, taxon, species_count, bytes, content_version, applied_province_region_ids)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (pack_id) DO UPDATE SET
             species_count = EXCLUDED.species_count, bytes = EXCLUDED.bytes, content_version = EXCLUDED.content_version,
             downloaded_at = now(), applied_province_region_ids = EXCLUDED.applied_province_region_ids`,
          [id, entry.region ?? entry.seaZone ?? null, entry.taxon ?? null, speciesCount, bytes, entry.contentVersion, defaultAppliedProvinceIds],
        );

        // A species can appear more than once within one pack (e.g. a country's own checklist
        // AND one of its bundled provinces' checklists) — deduped here by species id before the
        // bulk upsert below, since a single INSERT's VALUES list can't ON CONFLICT-update the
        // same row twice. providedEnrichment=true wins the dedup (a species is "provided by this
        // pack" if ANY of its checklist entries within the pack triggered the actual file copy).
        const touchedBySpeciesId = new Map<string, boolean>();
        for (const t of touched) {
          touchedBySpeciesId.set(t.speciesId, touchedBySpeciesId.get(t.speciesId) || t.providedEnrichment);
        }
        if (touchedBySpeciesId.size > 0) {
          const speciesIds = [...touchedBySpeciesId.keys()];
          const providedFlags = speciesIds.map((sid) => touchedBySpeciesId.get(sid)!);
          await client.query(
            `INSERT INTO pack_species (pack_id, species_id, provided_enrichment)
             SELECT $1, unnest($2::uuid[]), unnest($3::boolean[])
             ON CONFLICT (pack_id, species_id) DO UPDATE SET provided_enrichment = EXCLUDED.provided_enrichment`,
            [id, speciesIds, providedFlags],
          );
        }

        // Territories excluded by default (seeded above, before pack_species existed for this
        // pack) must actually have their region_species rows removed too — applyChecklist's
        // children loop just wrote them unconditionally like any other province, so without this
        // they'd show `applied: false` yet still count toward checklists/downloads until the user
        // happens to toggle them off manually. Uses this pack's own species (just upserted above),
        // not a stale/empty read from before this pack existed in pack_species at all.
        if (territoryChildRegionIds.length > 0 && touchedBySpeciesId.size > 0) {
          const speciesIds = [...touchedBySpeciesId.keys()];
          for (const territoryRegionId of territoryChildRegionIds) {
            await client.query(`DELETE FROM region_species WHERE region_id = $1 AND species_id = ANY($2)`, [territoryRegionId, speciesIds]);
          }
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      packsApplied++;
      done();
      for (const dep of manifest.seaZoneDependencies ?? []) {
        const depId = packIdFromFileName(dep.packFile);
        if (!seen.has(depId)) queue.push(depId);
      }
    } finally {
      rmSync(tmpFile, { force: true });
    }
  }
  return { packsApplied };
}

interface DeleteImpact {
  regionIds: string[];
  seaZoneId: string | null;
  checklistRegionsAffected: string[];
  speciesToRemove: string[];
  speciesKeptCount: number;
  bytesToFree: number;
  // True when bytesToFree/speciesToRemove came from the pack_species-empty fallback below
  // (downloaded_packs.bytes, the whole archive's own size) rather than a real per-species
  // reference-photo tally — lets the UI say "about" instead of implying exact precision.
  isEstimate: boolean;
}

// Shared by both the dry-run preview and the real delete — same computation, the preview just
// never reaches the write step. Deleting a country pack also removes its bundled provinces'
// checklist rows (they only exist because this same pack created them via applyPack's
// manifest.children loop) — every direct child of the pack's own region is treated as owned by
// it, a deliberate simplification (see this plan's own note on the tradeoff).
// A pack with no pack_species rows at all (never backfilled, or backfilled but no longer
// present in the pack index — confirmed live: both "canada" and "st-martin" fell into this
// exact case on a real dev install) degrades to the safest possible outcome, not a partial
// one: region_species deletion below is scoped to `species_id = ANY(pack_species-derived
// list)`, so an empty list means NOTHING is deleted — checklist rows, reference photos, and
// enrichment all stay exactly as they were. Deleting such a pack only forgets the
// downloaded_packs bookkeeping row itself (so it no longer shows as "downloaded" and can be
// re-applied fresh later), never touches data it can't prove is safe to remove.
async function computeDeleteImpact(packId: string): Promise<DeleteImpact | null> {
  const packRes = await pool.query<{ region: string | null; bytes: number; applied_province_region_ids: string[] | null }>(
    `SELECT region, bytes, applied_province_region_ids FROM downloaded_packs WHERE pack_id = $1`,
    [packId],
  );
  const packRegionName = packRes.rows[0]?.region;
  if (packRes.rows.length === 0) return null;
  const packBytes = Number(packRes.rows[0].bytes ?? 0);
  const appliedProvinceIds = packRes.rows[0].applied_province_region_ids;

  let regionIds: string[] = [];
  let seaZoneId: string | null = null;
  const checklistRegionsAffected: string[] = [];
  if (packRegionName) {
    const regionRes = await pool.query<{ id: string; name: string }>(`SELECT id, name FROM regions WHERE name = $1`, [packRegionName]);
    if (regionRes.rows.length > 0) {
      const { id, name } = regionRes.rows[0];
      regionIds.push(id);
      checklistRegionsAffected.push(name);
      const childrenRes = await pool.query<{ id: string; name: string }>(`SELECT id, name FROM regions WHERE parent_id = $1`, [id]);
      for (const child of childrenRes.rows) {
        // A province already offloaded on its own (Fix 8) has no region_species rows left to
        // delete here — skipping it keeps this count from double-counting a province the user
        // already removed individually before deleting the whole country pack.
        if (appliedProvinceIds && !appliedProvinceIds.includes(child.id)) continue;
        regionIds.push(child.id);
        checklistRegionsAffected.push(child.name);
      }
    } else {
      const zoneRes = await pool.query<{ id: string }>(`SELECT id FROM sea_zones WHERE name = $1`, [packRegionName]);
      if (zoneRes.rows.length > 0) {
        seaZoneId = zoneRes.rows[0].id;
        checklistRegionsAffected.push(packRegionName);
      }
    }
  }

  const speciesRes = await pool.query<{ species_id: string; provided_enrichment: boolean }>(
    `SELECT species_id, provided_enrichment FROM pack_species WHERE pack_id = $1`,
    [packId],
  );

  const speciesToRemove: string[] = [];
  let speciesKeptCount = 0;
  let bytesToFree = 0;
  for (const row of speciesRes.rows) {
    // provided_enrichment used to gate this loop entirely ("only free a species if THIS pack was
    // the one that introduced its enrichment") — but a species enriched earlier by a bulk script
    // (rather than through any pack download) never gets that credit for ANY pack, so a
    // taxon-scoped pack whose species were all already bulk-enriched (e.g. "Canada (Fish)", where
    // fish get enriched by a standalone bulk pass) always reported 0 species/0 bytes to free,
    // even when nothing else on disk still needed those reference photos. The otherPackRes/
    // userHasItRes checks right below already answer the real question — "is this species still
    // needed by anything else" — regardless of who originally provided its enrichment, so that's
    // the actual ownership check to gate on, not provided_enrichment.
    const otherPackRes = await pool.query(`SELECT 1 FROM pack_species WHERE species_id = $1 AND pack_id != $2 LIMIT 1`, [
      row.species_id,
      packId,
    ]);
    const userHasItRes = await pool.query(`SELECT 1 FROM user_species WHERE species_id = $1 LIMIT 1`, [row.species_id]);
    if ((otherPackRes.rowCount ?? 0) > 0 || (userHasItRes.rowCount ?? 0) > 0) {
      speciesKeptCount++;
      continue;
    }
    const fileRes = await pool.query<{ reference_display_path: string | null; reference_thumb_path: string | null }>(
      `SELECT reference_display_path, reference_thumb_path FROM species WHERE id = $1`,
      [row.species_id],
    );
    const paths = fileRes.rows[0];
    for (const p of [paths?.reference_display_path, paths?.reference_thumb_path]) {
      if (p && existsSync(p)) bytesToFree += statSync(p).size;
    }
    speciesToRemove.push(row.species_id);
  }

  // No pack_species rows at all (never backfilled — see this function's own comment above) —
  // fall back to the archive's own stored size rather than reporting a misleading "0 species,
  // freeing 0KB" for a pack that very much occupies real disk space.
  if (speciesRes.rows.length === 0 && packBytes > 0) {
    return {
      regionIds,
      seaZoneId,
      checklistRegionsAffected,
      speciesToRemove,
      speciesKeptCount,
      bytesToFree: packBytes,
      isEstimate: true,
    };
  }

  return { regionIds, seaZoneId, checklistRegionsAffected, speciesToRemove, speciesKeptCount, bytesToFree, isEstimate: false };
}

async function deletePack(packId: string): Promise<{ deletedSpeciesFiles: number; keptSpeciesCount: number; regions: string[] }> {
  const impact = await computeDeleteImpact(packId);
  if (!impact) throw new Error(`No downloaded pack found with id "${packId}"`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (impact.regionIds.length > 0) {
      const speciesRes = await client.query<{ species_id: string }>(`SELECT species_id FROM pack_species WHERE pack_id = $1`, [packId]);
      const allSpeciesIds = speciesRes.rows.map((r) => r.species_id);
      if (allSpeciesIds.length > 0) {
        await client.query(`DELETE FROM region_species WHERE region_id = ANY($1) AND species_id = ANY($2)`, [
          impact.regionIds,
          allSpeciesIds,
        ]);
      }
    } else if (impact.seaZoneId) {
      const speciesRes = await client.query<{ species_id: string }>(`SELECT species_id FROM pack_species WHERE pack_id = $1`, [packId]);
      const allSpeciesIds = speciesRes.rows.map((r) => r.species_id);
      if (allSpeciesIds.length > 0) {
        await client.query(`DELETE FROM sea_zone_species WHERE sea_zone_id = $1 AND species_id = ANY($2)`, [
          impact.seaZoneId,
          allSpeciesIds,
        ]);
      }
    }

    for (const speciesId of impact.speciesToRemove) {
      const fileRes = await client.query<{ reference_display_path: string | null; reference_thumb_path: string | null }>(
        `SELECT reference_display_path, reference_thumb_path FROM species WHERE id = $1`,
        [speciesId],
      );
      const paths = fileRes.rows[0];
      for (const p of [paths?.reference_display_path, paths?.reference_thumb_path]) {
        if (p && existsSync(p)) rmSync(p, { force: true });
      }
      // reference_photo (the enrichment-discovered source URL, separate from the locally-cached
      // reference_display_path/reference_thumb_path files above) must be cleared alongside
      // credit/license too, or this violates reference_photo_requires_credit — confirmed live:
      // a real pack with actual enriched species (canada-mammalia, downloaded fresh for this
      // fix's own end-to-end test) hit exactly this constraint violation, since every prior
      // exercise of this code path only ever had packs with empty pack_species to delete.
      await client.query(
        `UPDATE species SET
           reference_display_path = NULL, reference_thumb_path = NULL, habitat_description = NULL,
           reference_credit = NULL, reference_license = NULL, reference_photo = NULL, enriched_at = NULL
         WHERE id = $1`,
        [speciesId],
      );
    }

    // pack_species cascades from this delete (ON DELETE CASCADE, migration 054).
    await client.query(`DELETE FROM downloaded_packs WHERE pack_id = $1`, [packId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return {
    deletedSpeciesFiles: impact.speciesToRemove.length,
    keptSpeciesCount: impact.speciesKeptCount,
    regions: impact.checklistRegionsAffected,
  };
}

// Shared by /offline-packs/index (per-pack cards) and /offline-packs/updates-summary (the
// global banner) — same downloaded/updateAvailable computation, extracted so the two never
// drift out of sync with each other.
async function computePackStatuses(): Promise<{
  generatedAt: string;
  packs: Array<PackIndexEntry & { downloaded: boolean; updateAvailable: boolean }>;
}> {
  const index = await fetchPackIndex();
  const downloadedRes = await pool.query<{
    pack_id: string;
    content_version: string | null;
    region: string | null;
    taxon: string | null;
    species_count: number;
    bytes: string;
  }>(`SELECT pack_id, content_version, region, taxon, species_count, bytes FROM downloaded_packs`);
  const downloadedByPackId = new Map(downloadedRes.rows.map((r) => [r.pack_id, r]));

  const packs = index.packs.map((p) => {
    const downloaded = downloadedByPackId.get(p.id);
    return {
      ...p,
      downloaded: downloaded !== undefined,
      // A pack downloaded before content_version existed (downloaded.content_version === null)
      // reads as "no update available" rather than a false positive — there's no real signal to
      // compare against yet, and it'll self-correct the next time it's actually re-applied.
      updateAvailable: downloaded?.content_version != null && downloaded.content_version !== p.contentVersion,
    };
  });

  // A pack this user has already downloaded and applied can go missing from the CURRENT remote
  // index — not just from a bug (see build-pack-index.ts's own comment on the "index only
  // reflects the last local batch" regression this fixed), but even in ordinary steady state a
  // region's pack briefly drops out of the index mid-republish. Without this, index.packs.map
  // above silently drops that pack from the response entirely — a fully working, already-applied
  // region would just vanish from the Offline Packs page, looking like it was never downloaded.
  // Local DB state (this user's own downloaded_packs rows) is the actual source of truth for
  // "do I have this" and must never depend on what the remote catalog happens to list right now.
  const indexedIds = new Set(index.packs.map((p) => p.id));
  const missingFromIndex = downloadedRes.rows
    .filter((r) => !indexedIds.has(r.pack_id))
    .map((r) => ({
      id: r.pack_id,
      type: (r.pack_id.startsWith("seazone-") ? "seaZone" : "region") as "region" | "seaZone",
      region: r.region ?? undefined,
      seaZone: r.pack_id.startsWith("seazone-") ? (r.region ?? undefined) : undefined,
      taxon: r.taxon,
      sizeBytes: Number(r.bytes),
      speciesCount: r.species_count,
      contentVersion: r.content_version ?? "",
      scientificNames: [],
      url: "",
      downloaded: true,
      // Can't compare against a version the current index doesn't carry — same "no real signal
      // yet" reasoning as the content_version === null case above.
      updateAvailable: false,
    }));

  return { generatedAt: index.generatedAt, packs: [...packs, ...missingFromIndex] };
}

export async function offlinePacksRoutes(app: FastifyInstance): Promise<void> {
  app.get("/offline-packs/index", { preHandler: requireAuth }, async (_request, reply) => {
    try {
      const statuses = await computePackStatuses();
      return {
        generatedAt: statuses.generatedAt,
        // scientificNames is left out here — this listing only ever renders pack cards, never
        // needs the per-species names, and it can be a meaningful chunk of payload for the
        // largest all-taxa country packs. /offline-packs/recommend fetches the full index
        // itself when it actually needs that field.
        packs: statuses.packs.map(({ scientificNames: _scientificNames, ...p }) => p),
      };
    } catch (err) {
      return reply.code(503).send({ error: (err as Error).message });
    }
  });

  // Small, cheap payload (no scientificNames, no per-pack detail beyond what a global banner
  // needs) so it's reasonable to check at app launch without waiting on the full index.
  app.get("/offline-packs/updates-summary", { preHandler: requireAuth }, async (_request, reply) => {
    try {
      const statuses = await computePackStatuses();
      const stale = statuses.packs.filter((p) => p.updateAvailable);
      return {
        updateCount: stale.length,
        totalBytes: stale.reduce((sum, p) => sum + p.sizeBytes, 0),
        packIds: stale.map((p) => p.id),
      };
    } catch (err) {
      return reply.code(503).send({ error: (err as Error).message });
    }
  });

  // Given a list of scientific names (e.g. the gap the library reimport tool surfaced —
  // recovered species with no reference photo/description), greedily picks the smallest set
  // of not-yet-downloaded packs that covers them, rather than every pack with SOME overlap.
  // Standard greedy set-cover: repeatedly take whichever remaining pack covers the most still-
  // uncovered names, until either nothing's left to cover or no remaining pack covers anything.
  app.post<{ Body: { scientificNames?: string[] } }>("/offline-packs/recommend", { preHandler: requireAuth }, async (request, reply) => {
    const scientificNames = request.body?.scientificNames;
    if (!scientificNames || scientificNames.length === 0) {
      return reply.code(400).send({ error: "scientificNames is required" });
    }
    try {
      const index = await fetchPackIndex();
      const downloadedRes = await pool.query<{ pack_id: string }>(`SELECT pack_id FROM downloaded_packs`);
      const downloadedIds = new Set(downloadedRes.rows.map((r) => r.pack_id));

      let remaining = new Set(scientificNames);
      // Small-variant packs cover the exact same species as their full counterpart, so including
      // both here would just double the candidate set for no coverage gain. Recommending the
      // full pack keeps this endpoint's job (auto-suggest coverage) simple; a user who wants the
      // small download instead picks it themselves via the regular pack browser.
      const candidates = index.packs.filter((p) => !downloadedIds.has(p.id) && (p.variant ?? "full") === "full");
      const picked: Array<{ id: string; region?: string; seaZone?: string; taxon: string | null; sizeBytes: number; covers: number }> = [];

      while (remaining.size > 0) {
        let best: PackIndexEntry | null = null;
        let bestCoverage = 0;
        for (const pack of candidates) {
          if (picked.some((p) => p.id === pack.id)) continue;
          const coverage = pack.scientificNames.filter((n) => remaining.has(n)).length;
          if (coverage > bestCoverage) {
            best = pack;
            bestCoverage = coverage;
          }
        }
        if (!best || bestCoverage === 0) break;
        picked.push({ id: best.id, region: best.region, seaZone: best.seaZone, taxon: best.taxon ?? null, sizeBytes: best.sizeBytes, covers: bestCoverage });
        for (const name of best.scientificNames) remaining.delete(name);
      }

      return { recommended: picked, uncovered: [...remaining] };
    } catch (err) {
      return reply.code(503).send({ error: (err as Error).message });
    }
  });

  app.get("/offline-packs/download/status", { preHandler: requireAuth }, async () => downloadJob.status);

  app.post<{ Body: { packIds?: string[]; force?: boolean } }>(
    "/offline-packs/download",
    { preHandler: requireAuth },
    async (request, reply) => {
      const packIds = request.body?.packIds;
      if (!packIds || packIds.length === 0) {
        return reply.code(400).send({ error: "packIds is required" });
      }
      // Runs in the background (a large download shouldn't hold one HTTP request open).
      if (!startDownloadJob(packIds, request.body?.force ?? false)) {
        return reply.code(409).send({ error: "A pack download is already in progress" });
      }
      return { started: true };
    },
  );

  // Cancels the CURRENT pack's in-flight download (via the job's AbortSignal) and stops the job
  // from starting any further packs in its queue. A no-op (200, not an error) when nothing is running, so a client
  // racing the job's own natural completion doesn't need to handle a 404/409 specially.
  app.post("/offline-packs/download/cancel", { preHandler: requireAuth }, async () => ({ cancelled: downloadJob.cancel() }));

  // Resolves a (countries × taxa) selection to a set of pack ids and starts the same download
  // job as /offline-packs/download — a convenience layer for the map-based picker (multi-select
  // countries, pick taxa once, one download action) rather than pack-id-by-pack-id. "All of
  // Europe" is handled entirely client-side (the UI expands a continent pill to every country
  // under it and sends the full regionNames list here) — no continent-level pack exists.
  app.post<{ Body: { regionNames?: string[]; taxa?: string[] | "all"; variant?: "full" | "small" } }>(
    "/offline-packs/download-batch",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (downloadJob.status.running) {
        return reply.code(409).send({ error: "A pack download is already in progress" });
      }
      const regionNames = request.body?.regionNames;
      const taxa = request.body?.taxa;
      const variant = request.body?.variant ?? "full";
      if (!regionNames || regionNames.length === 0) {
        return reply.code(400).send({ error: "regionNames is required" });
      }
      try {
        const statuses = await computePackStatuses();
        const regionSet = new Set(regionNames);
        const taxaSet = taxa === "all" ? null : new Set(taxa ?? []);
        const packIds = statuses.packs
          .filter((p) => {
            const region = p.region ?? p.seaZone;
            if (!region || !regionSet.has(region)) return false;
            // A pack with no taxon (covers every taxon for its region) always matches; otherwise
            // the pack's own taxon must be one of the requested ones.
            if (taxaSet && p.taxon && !taxaSet.has(p.taxon)) return false;
            // Full and small variants of the same region/taxon both pass every filter above, so
            // without this a batch would try to download both at once.
            if ((p.variant ?? "full") !== variant) return false;
            return !p.downloaded || p.updateAvailable;
          })
          .map((p) => p.id);

        if (packIds.length === 0) return { started: false, packIds: [] };

        if (!startDownloadJob(packIds)) return reply.code(409).send({ error: "A pack download is already in progress" });

        return { started: true, packIds };
      } catch (err) {
        return reply.code(503).send({ error: (err as Error).message });
      }
    },
  );

  // Read-only dry run of DELETE's own impact computation — lets the UI show a real warning
  // ("N species' photos removed, M kept because you photographed them or another pack needs
  // them") before the user commits, per the explicit ask that this be surfaced up front, not
  // just described in the abstract.
  app.get<{ Params: { packId: string } }>("/offline-packs/:packId/delete-preview", { preHandler: requireAuth }, async (request, reply) => {
    try {
      const impact = await computeDeleteImpact(request.params.packId);
      if (!impact) return reply.code(404).send({ error: "No downloaded pack found with that id" });
      return {
        checklistRegionsAffectedCount: impact.checklistRegionsAffected.length,
        speciesToRemoveCount: impact.speciesToRemove.length,
        speciesKeptCount: impact.speciesKeptCount,
        bytesToFree: impact.bytesToFree,
        isEstimate: impact.isEstimate,
      };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.delete<{ Params: { packId: string } }>("/offline-packs/:packId", { preHandler: requireAuth }, async (request, reply) => {
    try {
      const result = await deletePack(request.params.packId);
      return result;
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  // Fix 8: province-level selection within a country pack. Always downloads/applies the full
  // country archive (unchanged network behavior — no per-province artifacts exist), but lets a
  // user pick which provinces stay applied locally, offloading the rest to avoid cluttering the
  // checklist/browsing UI with dozens of unwanted provinces. `applied_province_region_ids` NULL
  // means "every province applied" (today's behavior for every existing pack).
  app.get<{ Params: { packId: string } }>("/offline-packs/:packId/provinces", { preHandler: requireAuth }, async (request, reply) => {
    try {
      const packRes = await pool.query<{ region: string | null; applied_province_region_ids: string[] | null }>(
        `SELECT region, applied_province_region_ids FROM downloaded_packs WHERE pack_id = $1`,
        [request.params.packId],
      );
      if (packRes.rows.length === 0) return reply.code(404).send({ error: "No downloaded pack found with that id" });
      const { region, applied_province_region_ids: appliedIds } = packRes.rows[0];
      if (!region) return { provinces: [], subdivisionLabel: "Provinces" };
      const regionRes = await pool.query<{ id: string }>(`SELECT id FROM regions WHERE name = $1`, [region]);
      const regionId = regionRes.rows[0]?.id;
      if (!regionId) return { provinces: [], subdivisionLabel: "Provinces" };
      const childrenRes = await pool.query<{ id: string; name: string; subdivision_type: string | null }>(
        `SELECT id, name, subdivision_type FROM regions WHERE parent_id = $1 ORDER BY name`,
        [regionId],
      );
      return {
        provinces: childrenRes.rows.map((c) => ({ id: c.id, name: c.name, applied: !appliedIds || appliedIds.includes(c.id) })),
        subdivisionLabel: subdivisionLabelFor(childrenRes.rows.map((c) => c.subdivision_type)),
      };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // Immediately offloads exactly these provinces (removing their region_species rows for this
  // pack's own species — never touching reference photos/pack_species, which stay owned at the
  // country level since other provinces or the country pack itself may still need them) and
  // narrows applied_province_region_ids down to whatever's left. To bring a removed province
  // back later, re-download the pack (POST /offline-packs/download restores every child
  // unconditionally, see applyPack's own children loop) then offload whichever ones should stay
  // excluded again — no separate "reapply just this one" pathway exists, matching the tradeoff
  // this feature explicitly accepted (redownloading the whole archive again is fine).
  app.post<{ Params: { packId: string }; Body: { regionIds?: string[] } }>(
    "/offline-packs/:packId/provinces/offload",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { packId } = request.params;
      const toOffload = request.body?.regionIds;
      if (!toOffload || toOffload.length === 0) return reply.code(400).send({ error: "regionIds is required" });
      try {
        const packRes = await pool.query<{ region: string | null; applied_province_region_ids: string[] | null }>(
          `SELECT region, applied_province_region_ids FROM downloaded_packs WHERE pack_id = $1`,
          [packId],
        );
        if (packRes.rows.length === 0) return reply.code(404).send({ error: "No downloaded pack found with that id" });
        const { region, applied_province_region_ids: appliedIds } = packRes.rows[0];
        if (!region) return reply.code(400).send({ error: "This pack has no provinces" });
        const regionRes = await pool.query<{ id: string }>(`SELECT id FROM regions WHERE name = $1`, [region]);
        const regionId = regionRes.rows[0]?.id;
        if (!regionId) return reply.code(400).send({ error: "This pack's region no longer exists" });

        const allChildrenRes = await pool.query<{ id: string }>(`SELECT id FROM regions WHERE parent_id = $1`, [regionId]);
        const allChildIds = allChildrenRes.rows.map((r) => r.id);
        const currentlyApplied = appliedIds ?? allChildIds;

        const speciesRes = await pool.query<{ species_id: string }>(`SELECT species_id FROM pack_species WHERE pack_id = $1`, [packId]);
        const speciesIds = speciesRes.rows.map((r) => r.species_id);
        if (speciesIds.length > 0) {
          for (const regionIdToOffload of toOffload) {
            await pool.query(`DELETE FROM region_species WHERE region_id = $1 AND species_id = ANY($2)`, [
              regionIdToOffload,
              speciesIds,
            ]);
          }
        }

        const remaining = currentlyApplied.filter((id) => !toOffload.includes(id));
        await pool.query(`UPDATE downloaded_packs SET applied_province_region_ids = $1 WHERE pack_id = $2`, [
          JSON.stringify(remaining),
          packId,
        ]);

        return { ok: true, remainingApplied: remaining.length };
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    },
  );

  // Combined dry-run impact across several packs at once, for the offload screen's multi-select
  // — sums each pack's own computeDeleteImpact rather than trying to dedupe overlapping species
  // across packs (a species kept-or-removed determination already accounts for every OTHER
  // downloaded pack, including ones also in this same batch, since computeDeleteImpact checks
  // pack_species directly rather than assuming a single-pack context).
  app.post<{ Body: { packIds?: string[] } }>("/offline-packs/offload-preview", { preHandler: requireAuth }, async (request, reply) => {
    const packIds = request.body?.packIds;
    if (!packIds || packIds.length === 0) return reply.code(400).send({ error: "packIds is required" });
    try {
      let checklistRegionsAffectedCount = 0;
      let speciesToRemoveCount = 0;
      let speciesKeptCount = 0;
      let bytesToFree = 0;
      let isEstimate = false;
      for (const packId of packIds) {
        const impact = await computeDeleteImpact(packId);
        if (!impact) continue;
        checklistRegionsAffectedCount += impact.checklistRegionsAffected.length;
        speciesToRemoveCount += impact.speciesToRemove.length;
        speciesKeptCount += impact.speciesKeptCount;
        bytesToFree += impact.bytesToFree;
        isEstimate = isEstimate || impact.isEstimate;
      }
      return { checklistRegionsAffectedCount, speciesToRemoveCount, speciesKeptCount, bytesToFree, isEstimate };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.post<{ Body: { packIds?: string[] } }>("/offline-packs/offload-batch", { preHandler: requireAuth }, async (request, reply) => {
    const packIds = request.body?.packIds;
    if (!packIds || packIds.length === 0) return reply.code(400).send({ error: "packIds is required" });
    try {
      let deletedSpeciesFiles = 0;
      let keptSpeciesCount = 0;
      const regions: string[] = [];
      for (const packId of packIds) {
        const result = await deletePack(packId);
        deletedSpeciesFiles += result.deletedSpeciesFiles;
        keptSpeciesCount += result.keptSpeciesCount;
        regions.push(...result.regions);
      }
      return { deletedSpeciesFiles, keptSpeciesCount, regions };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });
}
