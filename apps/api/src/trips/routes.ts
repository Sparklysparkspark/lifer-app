import type { FastifyInstance } from "fastify";
import { createReadStream, existsSync, statSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pool } from "../db.js";
import { requireAuth, requireScope } from "../auth/session.js";
import { requireDesktopMode } from "../settings/routes.js";
import { scanTrip, resolveWithinTripFolder } from "./scan.js";
import { sanitizeForFilesystem } from "../uploads/speciesFolderName.js";
import { importTripFile } from "./import.js";
import { mapWithConcurrency } from "data-pipeline/src/concurrency.js";
import { toCollectionItem } from "../collection/collectionItem.js";
import { nextDefaultName } from "../lib/defaultName.js";
import { createJob, type Job, type JobContext } from "../lib/job.js";
import { idleJobStatus, type JobStatus } from "@lifer/shared";

// Same concurrency BulkImportPage's own client-side upload loop uses — each file pays a real
// exiftool round-trip plus a sharp resize, so importing even a handful sequentially (the
// original bug here) was slow purely from that per-file I/O latency stacking up.
const IMPORT_CONCURRENCY = 4;

// In-memory, per-trip scan and import jobs (createJob), not persisted across a restart: a
// restarted server just re-scans from scratch next time, which is cheap and correct. Finished
// entries are pruned after JOB_TTL_MS, and polling an unknown trip id never creates one.
const JOB_TTL_MS = 60 * 60_000;

interface ScanSummary {
  relinked: number;
  markedStale: number;
  collisions: number;
  recovered: number;
  rawsLinked: number;
  newFiles: Array<{ relativePath: string }>;
}
// The summary fields are also mirrored top-level for clients that predate `result`.
type ScanExtra = { tripId: string } & ScanSummary;
function emptyScanSummary(): ScanSummary {
  return { relinked: 0, markedStale: 0, collisions: 0, recovered: 0, rawsLinked: 0, newFiles: [] };
}

type ImportFileResult = { relativePath: string; captureId?: string; error?: string };
interface ImportExtra {
  tripId: string;
  // Grows live as files finish.
  results: ImportFileResult[];
}

type ScanJob = Job<ScanSummary, ScanExtra>;
type ImportJob = Job<{ imported: number; failed: number }, ImportExtra>;
const scanJobs = new Map<string, ScanJob>();
const importJobs = new Map<string, ImportJob>();

function pruneFinished<T extends Job<unknown, object>>(jobs: Map<string, T>): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (!job.status.running && job.status.finishedAt != null && job.status.finishedAt < cutoff) jobs.delete(id);
  }
}

function scanJobFor(tripId: string): ScanJob {
  let job = scanJobs.get(tripId);
  if (!job) {
    pruneFinished(scanJobs);
    job = createJob<ScanSummary, ScanExtra>(`trip-scan:${tripId}`, { tripId, ...emptyScanSummary() });
    scanJobs.set(tripId, job);
  }
  return job;
}

function importJobFor(tripId: string): ImportJob {
  let job = importJobs.get(tripId);
  if (!job) {
    pruneFinished(importJobs);
    job = createJob<{ imported: number; failed: number }, ImportExtra>(`trip-import:${tripId}`, { tripId, results: [] });
    importJobs.set(tripId, job);
  }
  return job;
}

function idleScanStatus(tripId: string): JobStatus<ScanSummary> & ScanExtra {
  return { ...idleJobStatus<ScanSummary>(), tripId, ...emptyScanSummary() };
}

function idleImportStatus(tripId: string): JobStatus<{ imported: number; failed: number }> & ImportExtra {
  return { ...idleJobStatus<{ imported: number; failed: number }>(), tripId, results: [] };
}

// Used by GET /trips to show a loading state on a trip's card while either job is still
// working, instead of a cover photo that may not exist yet or a stale one mid-update.
function isTripBusy(tripId: string): boolean {
  return Boolean(scanJobs.get(tripId)?.status.running || importJobs.get(tripId)?.status.running);
}

async function runScanJob(ctx: JobContext<ScanSummary, ScanExtra>, tripId: string, userId: string, sourceFolder: string): Promise<ScanSummary> {
  const result = await scanTrip(tripId, userId, sourceFolder, {
    signal: ctx.signal,
    onPhase: (phase) => ctx.update({ phase }),
  });
  const summary: ScanSummary = {
    relinked: result.relinked,
    markedStale: result.markedStale,
    collisions: result.collisions,
    recovered: result.recovered,
    rawsLinked: result.rawsLinked,
    newFiles: result.newFiles.map((f) => ({ relativePath: f.relativePath })),
  };
  ctx.update(summary);
  return summary;
}

async function runImportJob(
  ctx: JobContext<{ imported: number; failed: number }, ImportExtra>,
  job: ImportJob,
  tripId: string,
  userId: string,
  sourceFolder: string,
  files: Array<{ relativePath: string; speciesId: string }>,
  regionId: string | null,
): Promise<{ imported: number; failed: number }> {
  let imported = 0;
  let failed = 0;
  // Same concurrency as Bulk Import; cancel stops new files from starting.
  await mapWithConcurrency(files, IMPORT_CONCURRENCY, async (file) => {
    if (ctx.signal.aborted) return;
    ctx.update({ currentItem: file.relativePath });
    const absolutePath = resolveWithinTripFolder(sourceFolder, file.relativePath);
    let result: ImportFileResult;
    if (!absolutePath) {
      result = { relativePath: file.relativePath, error: "File not found" };
    } else {
      try {
        const { captureId } = await importTripFile(tripId, userId, file.speciesId, absolutePath, sourceFolder, file.relativePath, regionId);
        result = { relativePath: file.relativePath, captureId };
      } catch (err) {
        result = { relativePath: file.relativePath, error: (err as Error).message };
      }
    }
    if (result.error) failed++;
    else imported++;
    job.status.results.push(result);
    ctx.update({ processed: (job.status.processed ?? 0) + 1 });
    return result;
  });
  ctx.throwIfCancelled();
  return { imported, failed };
}

export async function tripsRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { name?: string; sourceFolder?: string } }>("/trips", { preHandler: requireAuth }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    const userId = request.user!.id;
    const { sourceFolder } = request.body ?? {};
    let name = request.body?.name?.trim();
    if (!sourceFolder) return reply.code(400).send({ error: "sourceFolder is required" });
    if (!name) {
      const countRes = await pool.query(
        `SELECT count(*) FROM trips WHERE user_id = $1 AND name ~ '^Untitled Trip( [A-Za-z-]+)?$'`,
        [userId],
      );
      name = nextDefaultName("Trip", Number(countRes.rows[0].count));
    }

    const res = await pool.query<{ id: string }>(
      `INSERT INTO trips (user_id, name, source_folder) VALUES ($1, $2, $3) RETURNING id`,
      [userId, name, sourceFolder],
    );
    return reply.code(201).send({ id: res.rows[0].id });
  });

  // "Build a Trip" — the OPPOSITE of the route above: instead of pointing at a folder the user
  // already organized by hand, this creates a brand-new empty one and hands back a trip whose
  // source_folder is that fresh "Wildlife" folder. Every existing trip route (scan/detail/
  // photos/cover) keeps working unchanged from here — as far as the DB is concerned this is
  // just a trip whose folder happens to start empty, not a different kind of trip. Photos land
  // in it via the main upload flow's own tripId destination override (uploads/routes.ts), not
  // via this route or Trips' own scan/import — the client is expected to navigate straight to
  // the normal upload/import UI after this call, scoped to the new trip.
  app.post<{ Body: { name?: string; parentDir?: string } }>("/trips/build", { preHandler: requireAuth }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    const userId = request.user!.id;
    const { parentDir } = request.body ?? {};
    let name = request.body?.name?.trim();
    if (!parentDir) return reply.code(400).send({ error: "parentDir is required" });
    if (!name) {
      const countRes = await pool.query(
        `SELECT count(*) FROM trips WHERE user_id = $1 AND name ~ '^Untitled Trip( [A-Za-z-]+)?$'`,
        [userId],
      );
      name = nextDefaultName("Trip", Number(countRes.rows[0].count));
    }

    const folderName = sanitizeForFilesystem(name);
    if (!folderName) return reply.code(400).send({ error: "That name can't be used as a folder name" });
    const sourceFolder = path.join(parentDir, folderName, "Wildlife");
    mkdirSync(sourceFolder, { recursive: true });

    const res = await pool.query<{ id: string }>(
      `INSERT INTO trips (user_id, name, source_folder) VALUES ($1, $2, $3) RETURNING id`,
      [userId, name, sourceFolder],
    );
    return reply.code(201).send({ id: res.rows[0].id, sourceFolder });
  });

  app.get("/trips", { preHandler: requireScope("trips.read") }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    const userId = request.user!.id;
    const res = await pool.query(
      `SELECT
         t.id, t.name, t.source_folder, t.cover_layout,
         count(DISTINCT c.species_id) AS species_count,
         count(c.id) AS capture_count,
         min(c.taken_at) AS earliest_taken_at,
         max(c.taken_at) AS latest_taken_at,
         -- The user's explicit pick (trips.cover_capture_id) wins when set; otherwise falls
         -- back to the most recent capture with a photo.
         cover_c.current_photo_id AS cover_photo_id,
         -- The crop was framed for the SPECIFIC photo the user manually picked — if that
         -- capture got trashed (soft-deleted, so cover_capture_id itself is still a valid FK and
         -- wasn't auto-cleared) and cover_c fell back to a different photo instead, applying the
         -- old crop to a completely different image would be wrong, not just stale. Only surface
         -- it when cover_c actually resolved to the real manual pick.
         CASE WHEN cover_c.id = t.cover_capture_id THEN t.cover_crop_x ELSE NULL END AS cover_crop_x,
         CASE WHEN cover_c.id = t.cover_capture_id THEN t.cover_crop_y ELSE NULL END AS cover_crop_y,
         CASE WHEN cover_c.id = t.cover_capture_id THEN t.cover_crop_size ELSE NULL END AS cover_crop_size,
         -- Only actually read when cover_layout = 'quad' (see TripsPage) — parity with Albums'
         -- own quad_photo_ids in albums/routes.ts.
         quad.photo_ids AS quad_photo_ids
       FROM trips t
       LEFT JOIN captures c ON c.trip_id = t.id
       LEFT JOIN LATERAL (
         SELECT cc.id, cc.current_photo_id FROM captures cc
         WHERE cc.trip_id = t.id AND cc.current_photo_id IS NOT NULL
         ORDER BY (cc.id = t.cover_capture_id) DESC, cc.taken_at DESC NULLS LAST
         LIMIT 1
       ) cover_c ON true
       LEFT JOIN LATERAL (
         SELECT array_agg(sub.photo_id) AS photo_ids FROM (
           SELECT cc.current_photo_id AS photo_id FROM captures cc
           WHERE cc.trip_id = t.id AND cc.current_photo_id IS NOT NULL
           ORDER BY cc.taken_at DESC NULLS LAST
           LIMIT 4
         ) sub
       ) quad ON true
       WHERE t.user_id = $1
       GROUP BY t.id, cover_c.id, cover_c.current_photo_id, quad.photo_ids
       ORDER BY t.created_at DESC`,
      [userId],
    );
    return {
      trips: res.rows.map((r) => ({
        id: r.id,
        name: r.name,
        sourceFolder: r.source_folder,
        speciesCount: Number(r.species_count),
        captureCount: Number(r.capture_count),
        earliestTakenAt: r.earliest_taken_at,
        latestTakenAt: r.latest_taken_at,
        coverPhotoUrl: r.cover_photo_id ? `/api/photos/${r.cover_photo_id}/thumb` : null,
        // Only meaningful when coverPhotoUrl was manually picked (a photo with a real crop
        // applied, same convention as CollectionItem.cardCropX/Y) — null renders as a plain
        // centered object-fit:cover, same as before this existed.
        coverCropX: r.cover_crop_x == null ? null : Number(r.cover_crop_x),
        coverCropY: r.cover_crop_y == null ? null : Number(r.cover_crop_y),
        coverCropSize: r.cover_crop_size == null ? null : Number(r.cover_crop_size),
        coverLayout: r.cover_layout,
        quadPhotoIds: r.quad_photo_ids ?? [],
        // A scan or import still running for this trip — the card shows a loading state
        // instead of a cover photo that may not exist yet (or is about to change).
        processing: isTripBusy(r.id),
      })),
    };
  });

  app.get<{ Params: { id: string } }>("/trips/:id", { preHandler: requireScope("trips.read") }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    const userId = request.user!.id;
    const res = await pool.query(
      `SELECT id, name, description, source_folder, cover_capture_id, cover_crop_x, cover_crop_y, cover_crop_size, cover_layout
       FROM trips WHERE id = $1 AND user_id = $2`,
      [request.params.id, userId],
    );
    if (res.rows.length === 0) return reply.code(404).send({ error: "Trip not found" });
    const trip = res.rows[0];
    return {
      id: trip.id,
      name: trip.name,
      description: trip.description,
      sourceFolder: trip.source_folder,
      coverCaptureId: trip.cover_capture_id,
      coverCropX: trip.cover_crop_x == null ? null : Number(trip.cover_crop_x),
      coverCropY: trip.cover_crop_y == null ? null : Number(trip.cover_crop_y),
      coverCropSize: trip.cover_crop_size == null ? null : Number(trip.cover_crop_size),
      coverLayout: trip.cover_layout,
    };
  });

  // Re-points an existing trip at a new folder — for when the external drive/folder this
  // trip's photos live in moves (a new machine, a restored backup with a different mount
  // path, reorganizing where the library itself lives). Doesn't touch any capture/original
  // row directly: the very next scan naturally relinks everything by content hash against
  // whatever's now in the new folder, the exact same matchAgainstKnownOriginals logic that
  // already handles a file moving WITHIN a trip's own folder (scan.ts) — a relocated folder
  // is really just every file "moving" at once.
  app.patch<{
    Params: { id: string };
    Body: { sourceFolder?: string; name?: string; description?: string | null; coverLayout?: "single" | "quad" };
  }>(
    "/trips/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!requireDesktopMode(reply)) return;
      const userId = request.user!.id;
      const { sourceFolder, name, description, coverLayout } = request.body ?? {};
      if (sourceFolder === undefined && name === undefined && description === undefined && coverLayout === undefined) {
        return reply.code(400).send({ error: "sourceFolder, name, description, or coverLayout is required" });
      }
      if (sourceFolder !== undefined && (!existsSync(sourceFolder) || !statSync(sourceFolder).isDirectory())) {
        return reply.code(400).send({ error: "That folder doesn't exist on this server" });
      }
      if (name !== undefined && !name.trim()) {
        return reply.code(400).send({ error: "name can't be empty" });
      }
      if (coverLayout !== undefined && coverLayout !== "single" && coverLayout !== "quad") {
        return reply.code(400).send({ error: "coverLayout must be 'single' or 'quad'" });
      }
      const tripRes = await pool.query(`SELECT id FROM trips WHERE id = $1 AND user_id = $2`, [request.params.id, userId]);
      if (tripRes.rows.length === 0) return reply.code(404).send({ error: "Trip not found" });

      await pool.query(
        `UPDATE trips SET
           source_folder = COALESCE($2, source_folder),
           name = COALESCE($3, name),
           description = CASE WHEN $4::boolean THEN $5 ELSE description END,
           cover_layout = COALESCE($6, cover_layout)
         WHERE id = $1`,
        [
          request.params.id,
          sourceFolder ?? null,
          name?.trim() ?? null,
          description !== undefined,
          description?.trim() || null,
          coverLayout ?? null,
        ],
      );
      return { ok: true };
    },
  );

  // Detaches every capture from this trip (ON DELETE SET NULL, migration 046) and removes the
  // trip row itself — never touches the underlying photos, same "delete the grouping, not the
  // content" behavior as an album delete.
  app.delete<{ Params: { id: string } }>("/trips/:id", { preHandler: requireAuth }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    const res = await pool.query(`DELETE FROM trips WHERE id = $1 AND user_id = $2`, [request.params.id, request.user!.id]);
    if (res.rowCount === 0) return reply.code(404).send({ error: "Trip not found" });
    return { ok: true };
  });

  // Manual cover pick — trips.cover_capture_id (migration 046) sat unused until now (the
  // default was always "most recent capture with a photo," same as reference photos'
  // no-manual-UI philosophy elsewhere), but a trip's cover carries more meaning than a
  // species card's does, so it's worth a real control. captureId=null clears the override
  // and reverts to the automatic default.
  app.put<{ Params: { id: string }; Body: { captureId: string | null } }>(
    "/trips/:id/cover",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!requireDesktopMode(reply)) return;
      const userId = request.user!.id;
      const { captureId } = request.body ?? {};
      const tripRes = await pool.query(`SELECT id FROM trips WHERE id = $1 AND user_id = $2`, [request.params.id, userId]);
      if (tripRes.rows.length === 0) return reply.code(404).send({ error: "Trip not found" });

      if (captureId) {
        const captureRes = await pool.query(`SELECT id FROM captures WHERE id = $1 AND trip_id = $2 AND user_id = $3`, [
          captureId,
          request.params.id,
          userId,
        ]);
        if (captureRes.rows.length === 0) return reply.code(400).send({ error: "That photo isn't part of this trip" });
      }

      // Clear any saved crop — it was framed for whichever photo was previously the cover
      // (or the automatic default), and carrying it over onto a different photo would look
      // wrong. Same rule as /species/:id/cover.
      await pool.query(
        `UPDATE trips SET cover_capture_id = $1, cover_crop_x = NULL, cover_crop_y = NULL, cover_crop_size = NULL WHERE id = $2`,
        [captureId, request.params.id],
      );
      return { ok: true };
    },
  );

  // Parity with /species/:id/card-crop — same drag-to-crop UI (CardCropEditor.tsx), same
  // request shape.
  app.patch<{ Params: { id: string }; Body: { x?: number; y?: number; size?: number; reset?: boolean } }>(
    "/trips/:id/cover-crop",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!requireDesktopMode(reply)) return;
      const userId = request.user!.id;
      const { x, y, size, reset } = request.body ?? {};
      const tripRes = await pool.query<{ cover_capture_id: string | null }>(
        `SELECT cover_capture_id FROM trips WHERE id = $1 AND user_id = $2`,
        [request.params.id, userId],
      );
      if (tripRes.rows.length === 0) return reply.code(404).send({ error: "Trip not found" });
      if (!tripRes.rows[0].cover_capture_id) return reply.code(400).send({ error: "No cover photo set for this trip yet" });

      if (reset) {
        await pool.query(`UPDATE trips SET cover_crop_x = NULL, cover_crop_y = NULL, cover_crop_size = NULL WHERE id = $1`, [
          request.params.id,
        ]);
        return { ok: true };
      }

      const valid =
        typeof x === "number" && x >= 0 && x <= 100 && typeof y === "number" && y >= 0 && y <= 100 && typeof size === "number" && size > 0 && size <= 100;
      if (!valid) return reply.code(400).send({ error: "x, y, size must each be within 0-100" });

      await pool.query(`UPDATE trips SET cover_crop_x = $1, cover_crop_y = $2, cover_crop_size = $3 WHERE id = $4`, [
        x,
        y,
        size,
        request.params.id,
      ]);
      return { ok: true };
    },
  );

  // Reuses toCollectionItem as-is (see collection/routes.ts's own /collection query, which
  // this mirrors) — scoped to species with at least one capture on this trip. The "Species
  // view" toggle on the trip page (vs. the default photo-grid gallery view) renders these as
  // plain SpeciesCards, same as the collection page.
  app.get<{ Params: { id: string } }>("/trips/:id/species", { preHandler: requireScope("trips.read") }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    const userId = request.user!.id;
    const tripRes = await pool.query(`SELECT id FROM trips WHERE id = $1 AND user_id = $2`, [request.params.id, userId]);
    if (tripRes.rows.length === 0) return reply.code(404).send({ error: "Trip not found" });

    const res = await pool.query(
      `SELECT
         s.id AS species_id,
         s.scientific_name,
         s.common_name,
         s.taxon_class,
         s.family,
         s.reference_photo,
         s.reference_credit,
         s.reference_thumb_path IS NOT NULL AS has_reference_thumb,
         s.reference_focal_x,
         s.reference_focal_y,
         r.tier,
         t.endemic_country_iso3,
         t.endemic_region_label,
         us.state,
         us.is_target,
         us.cover_photo_id,
         us.card_crop_x,
         us.card_crop_y,
         us.card_crop_size,
         p.thumb_path IS NOT NULL AS has_cover_photo,
         sv.label AS cover_volume_label
       FROM species s
       LEFT JOIN species_rarity r ON r.species_id = s.id
       LEFT JOIN species_traits t ON t.species_id = s.id
       LEFT JOIN user_species us ON us.user_id = $1 AND us.species_id = s.id
       LEFT JOIN photos p ON p.id = us.cover_photo_id
       LEFT JOIN originals o ON o.capture_id = p.capture_id AND o.kind = 'jpeg'
       LEFT JOIN storage_volumes sv ON sv.id = o.volume_id
       WHERE EXISTS (SELECT 1 FROM captures tc WHERE tc.trip_id = $2 AND tc.species_id = s.id)
       ORDER BY s.scientific_name`,
      [userId, request.params.id],
    );
    return { items: res.rows.map(toCollectionItem) };
  });

  // "Lifers gained + rare/endemic species encountered on this trip" — the summary layer the
  // main trip list/species views don't compute (those answer "what's in this trip," not "what
  // was NEW or notable about it"). A species counts as a lifer here when its very first-ever
  // confirmed capture (user_species.first_collected) IS one of this trip's own captures — not
  // just "first_collected falls within the trip's date range," which would also catch a species
  // first seen elsewhere on the same calendar day.
  app.get<{ Params: { id: string } }>("/trips/:id/summary", { preHandler: requireScope("trips.read") }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    const userId = request.user!.id;
    const tripId = request.params.id;
    const tripRes = await pool.query(`SELECT id FROM trips WHERE id = $1 AND user_id = $2`, [tripId, userId]);
    if (tripRes.rows.length === 0) return reply.code(404).send({ error: "Trip not found" });

    const res = await pool.query<{
      species_count: string;
      lifer_count: string;
      rare_count: string;
      endemic_count: string;
    }>(
      `WITH trip_species AS (
         SELECT DISTINCT c.species_id FROM captures c WHERE c.trip_id = $1
       )
       SELECT
         (SELECT COUNT(*) FROM trip_species) AS species_count,
         (SELECT COUNT(*) FROM trip_species ts
            JOIN user_species us ON us.user_id = $2 AND us.species_id = ts.species_id
            WHERE EXISTS (
              SELECT 1 FROM captures c
              WHERE c.trip_id = $1 AND c.species_id = ts.species_id AND c.taken_at = us.first_collected
            )) AS lifer_count,
         (SELECT COUNT(*) FROM trip_species ts
            JOIN species_rarity r ON r.species_id = ts.species_id
            WHERE r.tier IN ('rare', 'epic', 'legendary')) AS rare_count,
         (SELECT COUNT(*) FROM trip_species ts
            JOIN species_traits t ON t.species_id = ts.species_id
            WHERE t.endemic_country_iso3 IS NOT NULL OR t.endemic_region_label IS NOT NULL) AS endemic_count`,
      [tripId, userId],
    );
    const row = res.rows[0];
    return {
      speciesCount: Number(row.species_count),
      liferCount: Number(row.lifer_count),
      rareCount: Number(row.rare_count),
      endemicCount: Number(row.endemic_count),
    };
  });

  // The trip's default view is a plain photo grid (every capture from this trip, like
  // GalleryPage.tsx's own /gallery — not the collection page's per-species cards, since a trip
  // is "what did I photograph on this trip," not "what have I ever collected"). Same shape as
  // GalleryPage's GalleryItem so the frontend can reuse its MasonryGrid/ProgressiveImg/Lightbox
  // rendering as-is.
  app.get<{ Params: { id: string } }>("/trips/:id/photos", { preHandler: requireScope("trips.read") }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    const userId = request.user!.id;
    const tripRes = await pool.query(`SELECT id FROM trips WHERE id = $1 AND user_id = $2`, [request.params.id, userId]);
    if (tripRes.rows.length === 0) return reply.code(404).send({ error: "Trip not found" });

    const res = await pool.query(
      `SELECT p.id AS photo_id, p.width, p.height, c.id AS capture_id, c.species_id, s.scientific_name, s.common_name, c.taken_at, c.created_at,
              c.camera_model, c.lens, c.focal_length_mm, c.aperture, c.shutter, c.iso, c.quality_rating,
              EXISTS (SELECT 1 FROM originals ro WHERE ro.capture_id = c.id AND ro.kind = 'raw') AS has_raw,
              o.ref AS original_ref, o.kind AS original_kind
       FROM captures c
       JOIN photos p ON p.id = c.current_photo_id
       JOIN species s ON s.id = c.species_id
       -- jpeg-preferred tiebreak (same as Gallery/species detail's own capture query) - a
       -- capture whose only original is a RAW file has no jpeg to win the tiebreak, so this
       -- resolves to 'raw', which the frontend uses to hide "Download original" (Download RAW
       -- already covers that exact same file).
       LEFT JOIN LATERAL (
         SELECT * FROM originals lo WHERE lo.capture_id = c.id ORDER BY (lo.kind = 'jpeg') DESC LIMIT 1
       ) o ON true
       WHERE c.trip_id = $1 AND c.user_id = $2
       ORDER BY c.taken_at DESC NULLS LAST, c.created_at DESC`,
      [request.params.id, userId],
    );

    return {
      items: res.rows.map((row) => ({
        photoId: row.photo_id,
        width: row.width,
        height: row.height,
        captureId: row.capture_id,
        speciesId: row.species_id,
        scientificName: row.scientific_name,
        commonName: row.common_name,
        takenAt: row.taken_at,
        hasRaw: row.has_raw,
        originalRef: row.original_ref,
        originalKind: row.original_kind,
        cameraModel: row.camera_model,
        lens: row.lens,
        focalLengthMm: row.focal_length_mm,
        aperture: row.aperture,
        shutter: row.shutter,
        iso: row.iso,
        qualityRating: row.quality_rating,
      })),
    };
  });

  app.post<{ Params: { id: string } }>("/trips/:id/scan", { preHandler: requireAuth }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    const userId = request.user!.id;
    const tripId = request.params.id;
    if (scanJobs.get(tripId)?.status.running) return reply.code(409).send({ error: "A scan is already running for this trip" });

    const tripRes = await pool.query<{ source_folder: string }>(`SELECT source_folder FROM trips WHERE id = $1 AND user_id = $2`, [
      tripId,
      userId,
    ]);
    if (tripRes.rows.length === 0) return reply.code(404).send({ error: "Trip not found" });

    const job = scanJobFor(tripId);
    const sourceFolder = tripRes.rows[0].source_folder;
    const started = job.start((ctx) => runScanJob(ctx, tripId, userId, sourceFolder), {
      tripId,
      ...emptyScanSummary(),
      phase: "checking",
    });
    if (!started) return reply.code(409).send({ error: "A scan is already running for this trip" });
    return { started: true };
  });

  app.post<{ Params: { id: string } }>("/trips/:id/scan/cancel", { preHandler: requireAuth }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    return { cancelled: scanJobs.get(request.params.id)?.cancel() ?? false };
  });

  app.get<{ Params: { id: string } }>("/trips/:id/scan/status", { preHandler: requireScope("trips.read") }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    return scanJobs.get(request.params.id)?.status ?? idleScanStatus(request.params.id);
  });

  app.get<{ Params: { id: string }; Querystring: { file?: string } }>(
    "/trips/:id/scan-preview",
    { preHandler: requireScope("trips.read") },
    async (request, reply) => {
      if (!requireDesktopMode(reply)) return;
      const userId = request.user!.id;
      const tripRes = await pool.query<{ source_folder: string }>(
        `SELECT source_folder FROM trips WHERE id = $1 AND user_id = $2`,
        [request.params.id, userId],
      );
      if (tripRes.rows.length === 0) return reply.code(404).send({ error: "Trip not found" });
      const relativePath = request.query.file;
      if (!relativePath) return reply.code(400).send({ error: "file query param is required" });
      const absolutePath = resolveWithinTripFolder(tripRes.rows[0].source_folder, relativePath);
      if (!absolutePath) return reply.code(404).send({ error: "File not found" });
      reply.header("Cache-Control", "private, max-age=60");
      return reply.send(createReadStream(absolutePath));
    },
  );

  app.post<{ Params: { id: string }; Body: { files?: Array<{ relativePath: string; speciesId: string }>; regionId?: string } }>(
    "/trips/:id/import",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!requireDesktopMode(reply)) return;
      const userId = request.user!.id;
      const tripId = request.params.id;
      if (importJobs.get(tripId)?.status.running) return reply.code(409).send({ error: "An import is already running for this trip" });

      const tripRes = await pool.query<{ source_folder: string }>(
        `SELECT source_folder FROM trips WHERE id = $1 AND user_id = $2`,
        [tripId, userId],
      );
      if (tripRes.rows.length === 0) return reply.code(404).send({ error: "Trip not found" });
      const files = request.body?.files;
      if (!files || files.length === 0) return reply.code(400).send({ error: "files is required" });
      const regionId = request.body?.regionId ?? null;

      // Background job (exiftool + a sharp resize per file), polled via /import/status.
      const job = importJobFor(tripId);
      const sourceFolder = tripRes.rows[0].source_folder;
      const started = job.start((ctx) => runImportJob(ctx, job, tripId, userId, sourceFolder, files, regionId), {
        tripId,
        results: [],
        phase: "importing",
        processed: 0,
        total: files.length,
      });
      if (!started) return reply.code(409).send({ error: "An import is already running for this trip" });
      return { started: true };
    },
  );

  app.post<{ Params: { id: string } }>("/trips/:id/import/cancel", { preHandler: requireAuth }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    return { cancelled: importJobs.get(request.params.id)?.cancel() ?? false };
  });

  app.get<{ Params: { id: string } }>("/trips/:id/import/status", { preHandler: requireScope("trips.read") }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    return importJobs.get(request.params.id)?.status ?? idleImportStatus(request.params.id);
  });
}
