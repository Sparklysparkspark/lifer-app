import type { FastifyInstance } from "fastify";
import { createReadStream, existsSync, statSync } from "node:fs";
import { pool } from "../db.js";
import { requireAuth } from "../auth/session.js";
import { requireDesktopMode } from "../settings/routes.js";
import { scanTrip, resolveWithinTripFolder } from "./scan.js";
import { importTripFile } from "./import.js";
import { mapWithConcurrency } from "data-pipeline/src/concurrency.js";
import { toCollectionItem } from "../collection/collectionItem.js";

// Same concurrency BulkImportPage's own client-side upload loop uses — each file pays a real
// exiftool round-trip plus a sharp resize, so importing even a handful sequentially (the
// original bug here) was slow purely from that per-file I/O latency stacking up.
const IMPORT_CONCURRENCY = 4;

// In-memory, per-trip scan job state — same pattern as settings/routes.ts's migrate-to-server
// job: not persisted across a server restart, one job at a time (409 on re-entry), a POST to
// start and a GET to poll. A folder scan/rescan is I/O-heavy (reads every candidate file's
// bytes to fingerprint it) but not something the DB needs to remember progress on — a
// restarted server just re-scans from scratch next time, which is cheap and correct.
interface ScanJobState {
  running: boolean;
  tripId: string | null;
  error: string | null;
  finishedAt: number | null;
  relinked: number;
  markedStale: number;
  collisions: number;
  recovered: number;
  rawsLinked: number;
  newFiles: Array<{ relativePath: string }>;
}
const scanJobs = new Map<string, ScanJobState>();

function jobFor(tripId: string): ScanJobState {
  let job = scanJobs.get(tripId);
  if (!job) {
    job = {
      running: false,
      tripId,
      error: null,
      finishedAt: null,
      relinked: 0,
      markedStale: 0,
      collisions: 0,
      recovered: 0,
      rawsLinked: 0,
      newFiles: [],
    };
    scanJobs.set(tripId, job);
  }
  return job;
}

async function runScanJob(tripId: string, userId: string, sourceFolder: string): Promise<void> {
  const job = jobFor(tripId);
  try {
    const result = await scanTrip(tripId, userId, sourceFolder);
    job.relinked = result.relinked;
    job.markedStale = result.markedStale;
    job.collisions = result.collisions;
    job.recovered = result.recovered;
    job.rawsLinked = result.rawsLinked;
    job.newFiles = result.newFiles.map((f) => ({ relativePath: f.relativePath }));
  } catch (err) {
    job.error = (err as Error).message;
  } finally {
    job.running = false;
    job.finishedAt = Date.now();
  }
}

// Same background-job pattern as the scan job above, for the same reason: even with
// IMPORT_CONCURRENCY, each file still pays a real exiftool round-trip + sharp resize, so a
// synchronous POST that the client awaits directly would hang the UI on the whole batch
// instead of letting it show live progress (or just not block at all).
interface ImportJobState {
  running: boolean;
  tripId: string | null;
  processed: number;
  total: number;
  error: string | null;
  finishedAt: number | null;
  results: Array<{ relativePath: string; captureId?: string; error?: string }>;
}
const importJobs = new Map<string, ImportJobState>();

function importJobFor(tripId: string): ImportJobState {
  let job = importJobs.get(tripId);
  if (!job) {
    job = { running: false, tripId, processed: 0, total: 0, error: null, finishedAt: null, results: [] };
    importJobs.set(tripId, job);
  }
  return job;
}

// Used by GET /trips to show a loading state on a trip's card while either job is still
// working, instead of a cover photo that may not exist yet or a stale one mid-update.
function isTripBusy(tripId: string): boolean {
  return jobFor(tripId).running || importJobFor(tripId).running;
}

async function runImportJob(
  tripId: string,
  userId: string,
  sourceFolder: string,
  files: Array<{ relativePath: string; speciesId: string }>,
): Promise<void> {
  const job = importJobFor(tripId);
  try {
    await mapWithConcurrency(files, IMPORT_CONCURRENCY, async (file) => {
      const absolutePath = resolveWithinTripFolder(sourceFolder, file.relativePath);
      let result: { relativePath: string; captureId?: string; error?: string };
      if (!absolutePath) {
        result = { relativePath: file.relativePath, error: "File not found" };
      } else {
        try {
          const { captureId } = await importTripFile(tripId, userId, file.speciesId, absolutePath, sourceFolder, file.relativePath);
          result = { relativePath: file.relativePath, captureId };
        } catch (err) {
          result = { relativePath: file.relativePath, error: (err as Error).message };
        }
      }
      job.results.push(result);
      job.processed++;
      return result;
    });
  } catch (err) {
    job.error = (err as Error).message;
  } finally {
    job.running = false;
    job.finishedAt = Date.now();
  }
}

export async function tripsRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { name?: string; sourceFolder?: string } }>("/trips", { preHandler: requireAuth }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    const userId = request.user!.id;
    const { name, sourceFolder } = request.body ?? {};
    if (!name || !sourceFolder) return reply.code(400).send({ error: "name and sourceFolder are required" });

    const res = await pool.query<{ id: string }>(
      `INSERT INTO trips (user_id, name, source_folder) VALUES ($1, $2, $3) RETURNING id`,
      [userId, name, sourceFolder],
    );
    return reply.code(201).send({ id: res.rows[0].id });
  });

  app.get("/trips", { preHandler: requireAuth }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    const userId = request.user!.id;
    const res = await pool.query(
      `SELECT
         t.id, t.name, t.source_folder, t.cover_crop_x, t.cover_crop_y, t.cover_crop_size,
         count(DISTINCT c.species_id) AS species_count,
         count(c.id) AS capture_count,
         min(c.taken_at) AS earliest_taken_at,
         max(c.taken_at) AS latest_taken_at,
         -- The user's explicit pick (trips.cover_capture_id) wins when set; otherwise falls
         -- back to the most recent capture with a photo.
         cover_c.current_photo_id AS cover_photo_id
       FROM trips t
       LEFT JOIN captures c ON c.trip_id = t.id
       LEFT JOIN LATERAL (
         SELECT cc.current_photo_id FROM captures cc
         WHERE cc.trip_id = t.id AND cc.current_photo_id IS NOT NULL
         ORDER BY (cc.id = t.cover_capture_id) DESC, cc.taken_at DESC NULLS LAST
         LIMIT 1
       ) cover_c ON true
       WHERE t.user_id = $1
       GROUP BY t.id, cover_c.current_photo_id
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
        // A scan or import still running for this trip — the card shows a loading state
        // instead of a cover photo that may not exist yet (or is about to change).
        processing: isTripBusy(r.id),
      })),
    };
  });

  app.get<{ Params: { id: string } }>("/trips/:id", { preHandler: requireAuth }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    const userId = request.user!.id;
    const res = await pool.query(
      `SELECT id, name, source_folder, cover_capture_id, cover_crop_x, cover_crop_y, cover_crop_size
       FROM trips WHERE id = $1 AND user_id = $2`,
      [request.params.id, userId],
    );
    if (res.rows.length === 0) return reply.code(404).send({ error: "Trip not found" });
    const trip = res.rows[0];
    return {
      id: trip.id,
      name: trip.name,
      sourceFolder: trip.source_folder,
      coverCaptureId: trip.cover_capture_id,
      coverCropX: trip.cover_crop_x == null ? null : Number(trip.cover_crop_x),
      coverCropY: trip.cover_crop_y == null ? null : Number(trip.cover_crop_y),
      coverCropSize: trip.cover_crop_size == null ? null : Number(trip.cover_crop_size),
    };
  });

  // Re-points an existing trip at a new folder — for when the external drive/folder this
  // trip's photos live in moves (a new machine, a restored backup with a different mount
  // path, reorganizing where the library itself lives). Doesn't touch any capture/original
  // row directly: the very next scan naturally relinks everything by content hash against
  // whatever's now in the new folder, the exact same matchAgainstKnownOriginals logic that
  // already handles a file moving WITHIN a trip's own folder (scan.ts) — a relocated folder
  // is really just every file "moving" at once.
  app.patch<{ Params: { id: string }; Body: { sourceFolder?: string } }>(
    "/trips/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!requireDesktopMode(reply)) return;
      const userId = request.user!.id;
      const { sourceFolder } = request.body ?? {};
      if (!sourceFolder) return reply.code(400).send({ error: "sourceFolder is required" });
      if (!existsSync(sourceFolder) || !statSync(sourceFolder).isDirectory()) {
        return reply.code(400).send({ error: "That folder doesn't exist on this server" });
      }
      const tripRes = await pool.query(`SELECT id FROM trips WHERE id = $1 AND user_id = $2`, [request.params.id, userId]);
      if (tripRes.rows.length === 0) return reply.code(404).send({ error: "Trip not found" });

      await pool.query(`UPDATE trips SET source_folder = $1 WHERE id = $2`, [sourceFolder, request.params.id]);
      return { ok: true };
    },
  );

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
  app.get<{ Params: { id: string } }>("/trips/:id/species", { preHandler: requireAuth }, async (request, reply) => {
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
         us.cover_photo_id,
         us.card_crop_x,
         us.card_crop_y,
         us.card_crop_size,
         p.thumb_path IS NOT NULL AS has_cover_photo
       FROM species s
       LEFT JOIN species_rarity r ON r.species_id = s.id
       LEFT JOIN species_traits t ON t.species_id = s.id
       LEFT JOIN user_species us ON us.user_id = $1 AND us.species_id = s.id
       LEFT JOIN photos p ON p.id = us.cover_photo_id
       WHERE EXISTS (SELECT 1 FROM captures tc WHERE tc.trip_id = $2 AND tc.species_id = s.id)
       ORDER BY s.scientific_name`,
      [userId, request.params.id],
    );
    return { items: res.rows.map(toCollectionItem) };
  });

  // The trip's default view is a plain photo grid (every capture from this trip, like
  // GalleryPage.tsx's own /gallery — not the collection page's per-species cards, since a trip
  // is "what did I photograph on this trip," not "what have I ever collected"). Same shape as
  // GalleryPage's GalleryItem so the frontend can reuse its MasonryGrid/ProgressiveImg/Lightbox
  // rendering as-is.
  app.get<{ Params: { id: string } }>("/trips/:id/photos", { preHandler: requireAuth }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    const userId = request.user!.id;
    const tripRes = await pool.query(`SELECT id FROM trips WHERE id = $1 AND user_id = $2`, [request.params.id, userId]);
    if (tripRes.rows.length === 0) return reply.code(404).send({ error: "Trip not found" });

    const res = await pool.query(
      `SELECT p.id AS photo_id, c.id AS capture_id, c.species_id, s.scientific_name, s.common_name, c.taken_at, c.created_at,
              c.camera_model, c.lens, c.focal_length_mm, c.aperture, c.shutter, c.iso,
              EXISTS (SELECT 1 FROM originals ro WHERE ro.capture_id = c.id AND ro.kind = 'raw') AS has_raw
       FROM captures c
       JOIN photos p ON p.id = c.current_photo_id
       JOIN species s ON s.id = c.species_id
       WHERE c.trip_id = $1 AND c.user_id = $2
       ORDER BY c.taken_at DESC NULLS LAST, c.created_at DESC`,
      [request.params.id, userId],
    );

    return {
      items: res.rows.map((row) => ({
        photoId: row.photo_id,
        captureId: row.capture_id,
        speciesId: row.species_id,
        scientificName: row.scientific_name,
        commonName: row.common_name,
        takenAt: row.taken_at,
        hasRaw: row.has_raw,
        cameraModel: row.camera_model,
        lens: row.lens,
        focalLengthMm: row.focal_length_mm,
        aperture: row.aperture,
        shutter: row.shutter,
        iso: row.iso,
      })),
    };
  });

  app.post<{ Params: { id: string } }>("/trips/:id/scan", { preHandler: requireAuth }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    const userId = request.user!.id;
    const tripId = request.params.id;
    const job = jobFor(tripId);
    if (job.running) return reply.code(409).send({ error: "A scan is already running for this trip" });

    const tripRes = await pool.query<{ source_folder: string }>(`SELECT source_folder FROM trips WHERE id = $1 AND user_id = $2`, [
      tripId,
      userId,
    ]);
    if (tripRes.rows.length === 0) return reply.code(404).send({ error: "Trip not found" });

    job.running = true;
    job.error = null;
    job.finishedAt = null;
    job.relinked = 0;
    job.markedStale = 0;
    job.collisions = 0;
    job.recovered = 0;
    job.rawsLinked = 0;
    job.newFiles = [];

    // Deliberately not awaited — same pattern as settings/routes.ts's migrate-to-server job.
    void runScanJob(tripId, userId, tripRes.rows[0].source_folder);

    return { started: true };
  });

  app.get<{ Params: { id: string } }>("/trips/:id/scan/status", { preHandler: requireAuth }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    return jobFor(request.params.id);
  });

  app.get<{ Params: { id: string }; Querystring: { file?: string } }>(
    "/trips/:id/scan-preview",
    { preHandler: requireAuth },
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

  app.post<{ Params: { id: string }; Body: { files?: Array<{ relativePath: string; speciesId: string }> } }>(
    "/trips/:id/import",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!requireDesktopMode(reply)) return;
      const userId = request.user!.id;
      const tripId = request.params.id;
      const job = importJobFor(tripId);
      if (job.running) return reply.code(409).send({ error: "An import is already running for this trip" });

      const tripRes = await pool.query<{ source_folder: string }>(
        `SELECT source_folder FROM trips WHERE id = $1 AND user_id = $2`,
        [tripId, userId],
      );
      if (tripRes.rows.length === 0) return reply.code(404).send({ error: "Trip not found" });
      const files = request.body?.files;
      if (!files || files.length === 0) return reply.code(400).send({ error: "files is required" });

      job.running = true;
      job.processed = 0;
      job.total = files.length;
      job.error = null;
      job.finishedAt = null;
      job.results = [];

      // Not awaited — same reasoning as the scan job above: this can take a real amount of
      // time (exiftool + a sharp resize per file), and a client awaiting one giant request
      // directly has no way to show live progress or stay responsive in the meantime.
      void runImportJob(tripId, userId, tripRes.rows[0].source_folder, files);

      return { started: true };
    },
  );

  app.get<{ Params: { id: string } }>("/trips/:id/import/status", { preHandler: requireAuth }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    return importJobFor(request.params.id);
  });
}
