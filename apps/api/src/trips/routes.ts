import type { FastifyInstance } from "fastify";
import { existsSync, statSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pool } from "../db.js";
import { isUuid } from "../lib/validate.js";
import { requireAuth, requireScope } from "../auth/session.js";
import { assertAllowedPath } from "../lib/allowedPaths.js";
import { sanitizeForFilesystem } from "../uploads/speciesFolderName.js";
import { toCollectionItem } from "../collection/collectionItem.js";
import { markNameChanged } from "../species/speciesSplits.js";
import { nextDefaultName } from "../lib/defaultName.js";
import { isValidCrop } from "../lib/crop.js";
import { isTripBusy, tripJobRoutes } from "./jobs.js";

/** Checks a trip's destination folder and creates it if needed. It must be an absolute path whose
 * parent Lifer is allowed to use (assertAllowedPath); the folder itself may not exist yet. */
function prepareDestinationFolder(folder: string): { path: string } | { error: string } {
  if (!path.isAbsolute(folder)) return { error: "destinationFolder must be an absolute folder path" };
  const parent = assertAllowedPath(path.dirname(path.resolve(folder)));
  const destination = path.join(parent, path.basename(folder));
  if (existsSync(destination) && !statSync(destination).isDirectory()) return { error: "destinationFolder is a file, not a folder" };
  mkdirSync(destination, { recursive: true });
  return { path: destination };
}

export async function tripsRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { name?: string; sourceFolder?: string; destinationFolder?: string } }>("/trips", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.user!.id;
    const { sourceFolder, destinationFolder } = request.body ?? {};
    let name = request.body?.name?.trim();
    if (!sourceFolder) return reply.code(400).send({ error: "sourceFolder is required" });
    if (!path.isAbsolute(sourceFolder)) return reply.code(400).send({ error: "sourceFolder must be an absolute folder path" });
    const allowedSource = assertAllowedPath(sourceFolder);
    if (!existsSync(allowedSource) || !statSync(allowedSource).isDirectory()) {
      return reply.code(400).send({ error: "That folder doesn't exist on this server" });
    }
    if (!name) {
      const countRes = await pool.query(
        `SELECT count(*) FROM trips WHERE user_id = $1 AND name ~ '^Untitled Trip( [A-Za-z-]+)?$'`,
        [userId],
      );
      name = nextDefaultName("Trip", Number(countRes.rows[0].count));
    }

    const destination = prepareDestinationFolder(destinationFolder ?? path.join(allowedSource, "Wildlife"));
    if ("error" in destination) return reply.code(400).send({ error: destination.error });

    const res = await pool.query<{ id: string }>(
      `INSERT INTO trips (user_id, name, source_folder, destination_folder) VALUES ($1, $2, $3, $4) RETURNING id`,
      [userId, name, allowedSource, destination.path],
    );
    return reply.code(201).send({ id: res.rows[0].id, destinationFolder: destination.path });
  });

  // "Build a Trip": creates a new trip folder with an empty "Wildlife" destination inside it.
  // Photos arrive through the normal upload flow (filed into the destination by tripId) rather
  // than a scan; every other trip route works as usual.
  app.post<{ Body: { name?: string; parentDir?: string } }>("/trips/build", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.user!.id;
    const { parentDir } = request.body ?? {};
    let name = request.body?.name?.trim();
    if (!parentDir) return reply.code(400).send({ error: "parentDir is required" });
    if (!path.isAbsolute(parentDir)) return reply.code(400).send({ error: "parentDir must be an absolute folder path" });
    const allowedParent = assertAllowedPath(parentDir);
    if (!name) {
      const countRes = await pool.query(
        `SELECT count(*) FROM trips WHERE user_id = $1 AND name ~ '^Untitled Trip( [A-Za-z-]+)?$'`,
        [userId],
      );
      name = nextDefaultName("Trip", Number(countRes.rows[0].count));
    }

    const folderName = sanitizeForFilesystem(name);
    if (!folderName) return reply.code(400).send({ error: "That name can't be used as a folder name" });
    const sourceFolder = path.join(allowedParent, folderName);
    const destinationFolder = path.join(sourceFolder, "Wildlife");
    mkdirSync(destinationFolder, { recursive: true });

    const res = await pool.query<{ id: string }>(
      `INSERT INTO trips (user_id, name, source_folder, destination_folder) VALUES ($1, $2, $3, $4) RETURNING id`,
      [userId, name, sourceFolder, destinationFolder],
    );
    return reply.code(201).send({ id: res.rows[0].id, sourceFolder, destinationFolder });
  });

  app.get("/trips", { preHandler: requireScope("trips.read") }, async (request, reply) => {
    const userId = request.user!.id;
    const res = await pool.query(
      `SELECT
         t.id, t.name, t.source_folder, t.destination_folder, t.cover_layout,
         count(DISTINCT c.species_id) AS species_count,
         count(c.id) AS capture_count,
         min(c.taken_at) AS earliest_taken_at,
         max(c.taken_at) AS latest_taken_at,
         -- The user's explicit pick (trips.cover_capture_id) wins when set; otherwise falls
         -- back to the most recent capture with a photo.
         cover_c.current_photo_id AS cover_photo_id,
         -- The crop was framed for the SPECIFIC photo the user manually picked, if that
         -- capture got trashed (soft-deleted, so cover_capture_id itself is still a valid FK and
         -- wasn't auto-cleared) and cover_c fell back to a different photo instead, applying the
         -- old crop to a completely different image would be wrong, not just stale. Only surface
         -- it when cover_c actually resolved to the real manual pick.
         CASE WHEN cover_c.id = t.cover_capture_id THEN t.cover_crop_x ELSE NULL END AS cover_crop_x,
         CASE WHEN cover_c.id = t.cover_capture_id THEN t.cover_crop_y ELSE NULL END AS cover_crop_y,
         CASE WHEN cover_c.id = t.cover_capture_id THEN t.cover_crop_size ELSE NULL END AS cover_crop_size,
         -- Only actually read when cover_layout = 'quad' (see TripsPage), parity with Albums'
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
        destinationFolder: r.destination_folder,
        speciesCount: Number(r.species_count),
        captureCount: Number(r.capture_count),
        earliestTakenAt: r.earliest_taken_at,
        latestTakenAt: r.latest_taken_at,
        coverPhotoUrl: r.cover_photo_id ? `/api/photos/${r.cover_photo_id}/thumb` : null,
        // Set only for a manually picked cover; null renders a centered object-fit:cover.
        coverCropX: r.cover_crop_x == null ? null : Number(r.cover_crop_x),
        coverCropY: r.cover_crop_y == null ? null : Number(r.cover_crop_y),
        coverCropSize: r.cover_crop_size == null ? null : Number(r.cover_crop_size),
        coverLayout: r.cover_layout,
        quadPhotoIds: r.quad_photo_ids ?? [],
        // A scan or import is running: the card shows a loading state instead of a cover.
        processing: isTripBusy(r.id),
      })),
    };
  });

  app.get<{ Params: { id: string } }>("/trips/:id", { preHandler: requireScope("trips.read") }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(404).send({ error: "Trip not found" });
    const userId = request.user!.id;
    const res = await pool.query(
      `SELECT id, name, description, source_folder, destination_folder, cover_capture_id, cover_crop_x, cover_crop_y, cover_crop_size, cover_layout
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
      destinationFolder: trip.destination_folder,
      coverCaptureId: trip.cover_capture_id,
      coverCropX: trip.cover_crop_x == null ? null : Number(trip.cover_crop_x),
      coverCropY: trip.cover_crop_y == null ? null : Number(trip.cover_crop_y),
      coverCropSize: trip.cover_crop_size == null ? null : Number(trip.cover_crop_size),
      coverLayout: trip.cover_layout,
    };
  });

  // Points a trip at a new source or destination folder (a moved drive or restored backup). No
  // files move and no rows change here: the next scan relinks the destination's copies by
  // content hash, as when a file moves within the folder.
  app.patch<{
    Params: { id: string };
    Body: { sourceFolder?: string; destinationFolder?: string; name?: string; description?: string | null; coverLayout?: "single" | "quad" };
  }>(
    "/trips/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!isUuid(request.params.id)) return reply.code(404).send({ error: "Trip not found" });
      const userId = request.user!.id;
      const { sourceFolder, destinationFolder, name, description, coverLayout } = request.body ?? {};
      if (
        sourceFolder === undefined &&
        destinationFolder === undefined &&
        name === undefined &&
        description === undefined &&
        coverLayout === undefined
      ) {
        return reply.code(400).send({ error: "sourceFolder, destinationFolder, name, description, or coverLayout is required" });
      }
      let allowedDestination: string | undefined;
      if (destinationFolder !== undefined) {
        const destination = prepareDestinationFolder(destinationFolder);
        if ("error" in destination) return reply.code(400).send({ error: destination.error });
        allowedDestination = destination.path;
      }
      let allowedSource: string | undefined;
      if (sourceFolder !== undefined) {
        if (!path.isAbsolute(sourceFolder)) return reply.code(400).send({ error: "sourceFolder must be an absolute folder path" });
        allowedSource = assertAllowedPath(sourceFolder);
        if (!existsSync(allowedSource) || !statSync(allowedSource).isDirectory()) {
          return reply.code(400).send({ error: "That folder doesn't exist on this server" });
        }
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
           cover_layout = COALESCE($6, cover_layout),
           destination_folder = COALESCE($7, destination_folder)
         WHERE id = $1`,
        [
          request.params.id,
          allowedSource ?? null,
          name?.trim() ?? null,
          description !== undefined,
          description?.trim() || null,
          coverLayout ?? null,
          allowedDestination ?? null,
        ],
      );
      return { ok: true };
    },
  );

  // Deletes the trip only; its captures are detached (ON DELETE SET NULL), never deleted.
  app.delete<{ Params: { id: string } }>("/trips/:id", { preHandler: requireAuth }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(404).send({ error: "Trip not found" });
    const res = await pool.query(`DELETE FROM trips WHERE id = $1 AND user_id = $2`, [request.params.id, request.user!.id]);
    if (res.rowCount === 0) return reply.code(404).send({ error: "Trip not found" });
    return { ok: true };
  });

  // Manual cover pick. captureId=null goes back to the default, the most recent capture with a
  // photo.
  app.put<{ Params: { id: string }; Body: { captureId: string | null } }>(
    "/trips/:id/cover",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!isUuid(request.params.id)) return reply.code(404).send({ error: "Trip not found" });
      const userId = request.user!.id;
      const { captureId } = request.body ?? {};
      const tripRes = await pool.query(`SELECT id FROM trips WHERE id = $1 AND user_id = $2`, [request.params.id, userId]);
      if (tripRes.rows.length === 0) return reply.code(404).send({ error: "Trip not found" });

      if (captureId != null && !isUuid(captureId)) return reply.code(400).send({ error: "That photo isn't part of this trip" });
      if (captureId) {
        const captureRes = await pool.query(`SELECT id FROM captures WHERE id = $1 AND trip_id = $2 AND user_id = $3`, [
          captureId,
          request.params.id,
          userId,
        ]);
        if (captureRes.rows.length === 0) return reply.code(400).send({ error: "That photo isn't part of this trip" });
      }

      // Clears the saved crop, which was framed for the previous cover photo.
      await pool.query(
        `UPDATE trips SET cover_capture_id = $1, cover_crop_x = NULL, cover_crop_y = NULL, cover_crop_size = NULL WHERE id = $2`,
        [captureId, request.params.id],
      );
      return { ok: true };
    },
  );

  // Same request shape as /species/:id/card-crop.
  app.patch<{ Params: { id: string }; Body: { x?: number; y?: number; size?: number; reset?: boolean } }>(
    "/trips/:id/cover-crop",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!isUuid(request.params.id)) return reply.code(404).send({ error: "Trip not found" });
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

      if (!isValidCrop(x, y, size)) return reply.code(400).send({ error: "x, y, size must each be within 0-100" });

      await pool.query(`UPDATE trips SET cover_crop_x = $1, cover_crop_y = $2, cover_crop_size = $3 WHERE id = $4`, [
        x,
        y,
        size,
        request.params.id,
      ]);
      return { ok: true };
    },
  );

  // The trip's species as collection items (same shape as /collection), for the Species view.
  app.get<{ Params: { id: string } }>("/trips/:id/species", { preHandler: requireScope("trips.read") }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(404).send({ error: "Trip not found" });
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
         s.taxon_order,
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
    return { items: await markNameChanged(userId, res.rows.map((row) => toCollectionItem(row))) };
  });

  // Lifers gained and notable species on this trip. A lifer is a species whose first-ever capture
  // is one of this trip's captures (not just on the same dates).
  app.get<{ Params: { id: string } }>("/trips/:id/summary", { preHandler: requireScope("trips.read") }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(404).send({ error: "Trip not found" });
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
            WHERE r.tier IN ('uncommon', 'rare', 'legendary')) AS rare_count,
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

  // Every photo from the trip, in the same shape as /gallery items so the web can reuse its grid.
  app.get<{ Params: { id: string } }>("/trips/:id/photos", { preHandler: requireScope("trips.read") }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(404).send({ error: "Trip not found" });
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

  await app.register(tripJobRoutes);
}
