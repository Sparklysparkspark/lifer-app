import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { pool } from "@lifer/core/db.js";
import { IdParams, Nullable, Ok, Uuid, notFoundOnInvalidId, replies, withSchemas } from "../lib/schema.js";
import { requireAuth, requireScope } from "../auth/session.js";
import { assertAllowedPath, isDirectory } from "@lifer/core/lib/allowedPaths.js";
import { sanitizeForFilesystem } from "../uploads/speciesFolderName.js";
import { photoSetSpeciesCards, type SetPhoto } from "../collection/photoSetSpecies.js";
import { MAX_NAME_LENGTH, NAME_TOO_LONG, nextDefaultName } from "../lib/defaultName.js";
import { isValidCrop } from "../lib/crop.js";
import { isTripBusy, tripJobRoutes } from "./jobs.js";
import { TripDetail, TripList, TripPhotos, TripSpecies, TripSummary } from "./responses.js";
import { removeTripRecord } from "../lib/libraryRecords.js";
import { ORIGINALS_DIR } from "@lifer/core/config.js";
import { tripMembershipRoutes } from "./membership.js";
import { tripFileMoveRoutes } from "./moveFiles.js";
import { GALLERY_TIER_SQL } from "../gallery/routes.js";
import { filesCaptureOf } from "../lib/versionFiles.js";
import { BEST_PHOTO_ORDER, rawPreviewOf } from "../lib/bestPhotoOrder.js";
import { sensitiveForKey } from "../companion/privacy.js";

// The shared pick order under this file's `cc` alias.
const BEST_PHOTO_ORDER_CC = BEST_PHOTO_ORDER.replaceAll("c.", "cc.");

/** Checks a trip's destination folder and creates it if needed. It must be an absolute path whose
 * parent Lifer is allowed to use (assertAllowedPath); the folder itself may not exist yet. */
async function prepareDestinationFolder(folder: string): Promise<{ path: string } | { error: string }> {
  if (!path.isAbsolute(folder)) return { error: "destinationFolder must be an absolute folder path" };
  // Resolved first, so the last segment can't be ".." stepping back out of the checked parent.
  const resolved = path.resolve(folder);
  const parent = assertAllowedPath(path.dirname(resolved));
  const destination = path.join(parent, path.basename(resolved));
  const existing = await stat(destination).catch(() => null);
  if (existing && !existing.isDirectory()) return { error: "destinationFolder is a file, not a folder" };
  await mkdir(destination, { recursive: true });
  // The folder itself checked too: an existing symlink there must not lead outside.
  assertAllowedPath(destination);
  return { path: destination };
}

const tripNotFound = notFoundOnInvalidId("Trip not found");
// Folder paths are checked against the allowed roots in the handlers, not here.
const FolderPath = Type.String({ minLength: 1 });
const TripDate = Type.String({ format: "date" });

// The date, region and active columns every trip answer carries (TripSummary in @lifer/shared).
const DATE_COLUMNS = `t.start_date::text AS start_date, t.end_date::text AS end_date, t.region_id, t.active_override`;
const dateFields = (r: {
  start_date: string | null;
  end_date: string | null;
  region_id: string | null;
  active_override: boolean | null;
}) => ({ startDate: r.start_date, endDate: r.end_date, regionId: r.region_id, activeOverride: r.active_override });

/** A 400 message for a database refusal of the trip's dates or region, else null. */
function tripFieldError(err: unknown): string | null {
  const code = (err as { code?: string }).code;
  if (code === "23514") return "The end date can't be before the start date";
  if (code === "23503") return "Unknown region";
  return null;
}

export async function tripsRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.post(
    "/trips",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          {
            name: Type.Optional(Type.String()),
            sourceFolder: FolderPath,
            destinationFolder: Type.Optional(FolderPath),
          },
          { additionalProperties: false },
        ),
        response: replies(Type.Object({ id: Uuid(), destinationFolder: Type.String() }), 201),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const { sourceFolder, destinationFolder } = request.body;
      let name = request.body.name?.trim();
      if (name && name.length > MAX_NAME_LENGTH) return reply.code(400).send({ error: NAME_TOO_LONG });
      if (!path.isAbsolute(sourceFolder))
        return reply.code(400).send({ error: "sourceFolder must be an absolute folder path" });
      const allowedSource = assertAllowedPath(sourceFolder);
      if (!(await isDirectory(allowedSource))) {
        return reply.code(400).send({ error: "That folder doesn't exist on this server" });
      }
      if (!name) {
        const countRes = await pool.query(
          `SELECT count(*) FROM trips WHERE user_id = $1 AND name ~ '^Untitled Trip( [A-Za-z-]+)?$'`,
          [userId],
        );
        name = nextDefaultName("Trip", Number(countRes.rows[0].count));
      }

      const destination = await prepareDestinationFolder(destinationFolder ?? path.join(allowedSource, "Wildlife"));
      if ("error" in destination) return reply.code(400).send({ error: destination.error });

      const res = await pool.query<{ id: string }>(
        `INSERT INTO trips (user_id, name, source_folder, destination_folder) VALUES ($1, $2, $3, $4) RETURNING id`,
        [userId, name, allowedSource, destination.path],
      );
      return reply.code(201).send({ id: res.rows[0].id, destinationFolder: destination.path });
    },
  );

  // "Start a trip": made ahead of its photos, with its dates. Its folder is where its photos are
  // filed: Trips/<name> in the library unless the user picks a folder Lifer may use. That folder is
  // its source too, so a scan only relinks the photos filed there.
  app.post(
    "/trips/start",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          {
            name: Type.String({ minLength: 1 }),
            startDate: TripDate,
            endDate: Type.Optional(Nullable(TripDate)),
            regionId: Type.Optional(Nullable(Uuid())),
            folder: Type.Optional(FolderPath),
          },
          { additionalProperties: false },
        ),
        response: replies(Type.Object({ id: Uuid(), folder: Type.String() }), 201),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const { startDate, endDate, regionId, folder } = request.body;
      const name = request.body.name.trim();
      if (name.length > MAX_NAME_LENGTH) return reply.code(400).send({ error: NAME_TOO_LONG });
      const folderName = sanitizeForFilesystem(name);
      if (!name || (!folder && !folderName))
        return reply.code(400).send({ error: "That name can't be used as a folder name" });
      if (!folder) await mkdir(path.join(ORIGINALS_DIR, "Trips"), { recursive: true });
      const prepared = await prepareDestinationFolder(folder ?? path.join(ORIGINALS_DIR, "Trips", folderName));
      if ("error" in prepared) return reply.code(400).send({ error: prepared.error });
      try {
        const res = await pool.query<{ id: string }>(
          `INSERT INTO trips (user_id, name, source_folder, destination_folder, start_date, end_date, region_id)
           VALUES ($1, $2, $3, $3, $4, $5, $6) RETURNING id`,
          [userId, name, prepared.path, startDate, endDate ?? null, regionId ?? null],
        );
        return reply.code(201).send({ id: res.rows[0].id, folder: prepared.path });
      } catch (err) {
        const message = tripFieldError(err);
        if (message) return reply.code(400).send({ error: message });
        throw err;
      }
    },
  );

  app.get(
    "/trips",
    { preValidation: requireScope("trips.read"), schema: { response: replies(TripList) } },
    async (request) => {
      const userId = request.user!.id;
      const res = await pool.query(
        `SELECT
         t.id, t.name, t.source_folder, t.destination_folder, t.cover_layout, ${DATE_COLUMNS},
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
         ORDER BY (cc.id = t.cover_capture_id) DESC, ${rawPreviewOf("cc")}, ${BEST_PHOTO_ORDER_CC}
         LIMIT 1
       ) cover_c ON true
       LEFT JOIN LATERAL (
         SELECT array_agg(sub.photo_id) AS photo_ids FROM (
           SELECT cc.current_photo_id AS photo_id FROM captures cc
           WHERE cc.trip_id = t.id AND cc.current_photo_id IS NOT NULL
           ORDER BY ${BEST_PHOTO_ORDER_CC}
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
          ...dateFields(r),
        })),
      };
    },
  );

  app.get(
    "/trips/:id",
    {
      preValidation: requireScope("trips.read"),
      config: tripNotFound,
      schema: { params: IdParams, response: replies(TripDetail) },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const res = await pool.query(
        `SELECT id, name, description, source_folder, destination_folder, cover_capture_id, cover_crop_x, cover_crop_y, cover_crop_size, cover_layout,
              ${DATE_COLUMNS}
       FROM trips t WHERE id = $1 AND user_id = $2`,
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
        ...dateFields(trip),
      };
    },
  );

  // Points a trip at a new source or destination folder (a moved drive or restored backup). No
  // files move and no rows change here: the next scan relinks the destination's copies by
  // content hash, as when a file moves within the folder.
  app.patch(
    "/trips/:id",
    {
      preValidation: requireAuth,
      config: tripNotFound,
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            sourceFolder: Type.Optional(FolderPath),
            destinationFolder: Type.Optional(FolderPath),
            name: Type.Optional(Type.String()),
            description: Type.Optional(Nullable(Type.String())),
            coverLayout: Type.Optional(Type.Enum(["single", "quad"])),
            startDate: Type.Optional(Nullable(TripDate)),
            endDate: Type.Optional(Nullable(TripDate)),
            regionId: Type.Optional(Nullable(Uuid())),
            activeOverride: Type.Optional(Nullable(Type.Boolean())),
          },
          { additionalProperties: false },
        ),
        response: replies(Ok),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const { sourceFolder, destinationFolder, name, description, coverLayout } = request.body;
      if (Object.keys(request.body).length === 0) return reply.code(400).send({ error: "Nothing to change" });
      let allowedDestination: string | undefined;
      if (destinationFolder !== undefined) {
        const destination = await prepareDestinationFolder(destinationFolder);
        if ("error" in destination) return reply.code(400).send({ error: destination.error });
        allowedDestination = destination.path;
      }
      let allowedSource: string | undefined;
      if (sourceFolder !== undefined) {
        if (!path.isAbsolute(sourceFolder))
          return reply.code(400).send({ error: "sourceFolder must be an absolute folder path" });
        allowedSource = assertAllowedPath(sourceFolder);
        if (!(await isDirectory(allowedSource))) {
          return reply.code(400).send({ error: "That folder doesn't exist on this server" });
        }
      }
      if (name !== undefined && !name.trim()) {
        return reply.code(400).send({ error: "name can't be empty" });
      }
      if (name && name.trim().length > MAX_NAME_LENGTH) return reply.code(400).send({ error: NAME_TOO_LONG });
      const tripRes = await pool.query(`SELECT id FROM trips WHERE id = $1 AND user_id = $2`, [
        request.params.id,
        userId,
      ]);
      if (tripRes.rows.length === 0) return reply.code(404).send({ error: "Trip not found" });

      // A date, region or override that's sent replaces the stored one, null included.
      const given = (key: "startDate" | "endDate" | "regionId" | "activeOverride") => key in request.body;
      try {
        await pool.query(
          `UPDATE trips SET
             source_folder = COALESCE($2, source_folder),
             name = COALESCE($3, name),
             description = CASE WHEN $4::boolean THEN $5 ELSE description END,
             cover_layout = COALESCE($6, cover_layout),
             destination_folder = COALESCE($7, destination_folder),
             start_date = CASE WHEN $8::boolean THEN $9::date ELSE start_date END,
             end_date = CASE WHEN $10::boolean THEN $11::date ELSE end_date END,
             region_id = CASE WHEN $12::boolean THEN $13::uuid ELSE region_id END,
             active_override = CASE WHEN $14::boolean THEN $15::boolean ELSE active_override END
           WHERE id = $1`,
          [
            request.params.id,
            allowedSource ?? null,
            name?.trim() ?? null,
            description !== undefined,
            description?.trim() || null,
            coverLayout ?? null,
            allowedDestination ?? null,
            given("startDate"),
            request.body.startDate ?? null,
            given("endDate"),
            request.body.endDate ?? null,
            given("regionId"),
            request.body.regionId ?? null,
            given("activeOverride"),
            request.body.activeOverride ?? null,
          ],
        );
      } catch (err) {
        const message = tripFieldError(err);
        if (message) return reply.code(400).send({ error: message });
        throw err;
      }
      return { ok: true };
    },
  );

  // Deletes the trip only; its captures are detached (ON DELETE SET NULL), never deleted.
  app.delete(
    "/trips/:id",
    { preValidation: requireAuth, config: tripNotFound, schema: { params: IdParams, response: replies(Ok) } },
    async (request, reply) => {
      const res = await pool.query<{ source_folder: string; destination_folder: string | null }>(
        `DELETE FROM trips WHERE id = $1 AND user_id = $2 RETURNING source_folder, destination_folder`,
        [request.params.id, request.user!.id],
      );
      const deleted = res.rows[0];
      if (!deleted) return reply.code(404).send({ error: "Trip not found" });
      // Its record goes too, so a library reimport doesn't bring the trip back.
      removeTripRecord(request.params.id, deleted.source_folder, deleted.destination_folder);
      return { ok: true };
    },
  );

  // Manual cover pick. captureId=null goes back to the default, the most recent capture with a
  // photo.
  app.put(
    "/trips/:id/cover",
    {
      preValidation: requireAuth,
      config: tripNotFound,
      schema: {
        params: IdParams,
        body: Type.Object({ captureId: Nullable(Uuid()) }, { additionalProperties: false }),
        response: replies(Ok),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const { captureId } = request.body;
      const tripRes = await pool.query(`SELECT id FROM trips WHERE id = $1 AND user_id = $2`, [
        request.params.id,
        userId,
      ]);
      if (tripRes.rows.length === 0) return reply.code(404).send({ error: "Trip not found" });

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
  app.patch(
    "/trips/:id/cover-crop",
    {
      preValidation: requireAuth,
      config: tripNotFound,
      schema: {
        params: IdParams,
        // Either a crop (all three, checked by isValidCrop below) or reset: true.
        body: Type.Object(
          {
            x: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
            y: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
            size: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 100 })),
            reset: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
        response: replies(Ok),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const { x, y, size, reset } = request.body;
      const tripRes = await pool.query<{ cover_capture_id: string | null }>(
        `SELECT cover_capture_id FROM trips WHERE id = $1 AND user_id = $2`,
        [request.params.id, userId],
      );
      if (tripRes.rows.length === 0) return reply.code(404).send({ error: "Trip not found" });
      if (!tripRes.rows[0].cover_capture_id)
        return reply.code(400).send({ error: "No cover photo set for this trip yet" });

      if (reset) {
        await pool.query(
          `UPDATE trips SET cover_crop_x = NULL, cover_crop_y = NULL, cover_crop_size = NULL WHERE id = $1`,
          [request.params.id],
        );
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
  app.get(
    "/trips/:id/species",
    {
      preValidation: requireScope("trips.read"),
      config: tripNotFound,
      schema: { params: IdParams, response: replies(TripSpecies) },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const tripRes = await pool.query(`SELECT id FROM trips WHERE id = $1 AND user_id = $2`, [
        request.params.id,
        userId,
      ]);
      if (tripRes.rows.length === 0) return reply.code(404).send({ error: "Trip not found" });

      // Every species in the trip, and its photos in the trip's order for picking the best one.
      const [species, photos] = await Promise.all([
        pool.query<{ species_id: string }>(`SELECT DISTINCT species_id FROM captures WHERE trip_id = $1`, [
          request.params.id,
        ]),
        pool.query<SetPhoto>(
          `SELECT c.species_id, p.id AS photo_id, c.quality_rating
           FROM captures c JOIN photos p ON p.id = c.current_photo_id
           WHERE c.trip_id = $1 AND c.user_id = $2
           ORDER BY c.taken_at DESC NULLS LAST, c.created_at DESC`,
          [request.params.id, userId],
        ),
      ]);
      return {
        items: await photoSetSpeciesCards(
          userId,
          species.rows.map((r) => r.species_id),
          photos.rows,
        ),
      };
    },
  );

  // Lifers gained and notable species on this trip. A lifer is a species whose first-ever capture
  // is one of this trip's captures (not just on the same dates).
  app.get(
    "/trips/:id/summary",
    {
      preValidation: requireScope("trips.read"),
      config: tripNotFound,
      schema: { params: IdParams, response: replies(TripSummary) },
    },
    async (request, reply) => {
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
              WHERE c.trip_id = $1 AND c.species_id = ts.species_id AND c.taken_at::date = us.first_collected
            )) AS lifer_count,
         (SELECT COUNT(*) FROM trip_species ts
            JOIN species_rarity r ON r.species_id = ts.species_id
            WHERE r.tier IN ('rare', 'legendary')) AS rare_count,
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
    },
  );

  // Every photo from the trip, in the same shape as /gallery items so the web can reuse its grid.
  app.get(
    "/trips/:id/photos",
    {
      preValidation: requireScope("trips.read"),
      config: tripNotFound,
      schema: { params: IdParams, response: replies(TripPhotos) },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const tripRes = await pool.query(`SELECT id FROM trips WHERE id = $1 AND user_id = $2`, [
        request.params.id,
        userId,
      ]);
      if (tripRes.rows.length === 0) return reply.code(404).send({ error: "Trip not found" });

      const res = await pool.query(
        `SELECT p.id AS photo_id, p.width, p.height, c.id AS capture_id, c.species_id, s.scientific_name, s.common_name, c.taken_at, c.taken_at_zoned, c.created_at,
              c.camera_model, c.lens, c.focal_length_mm, c.aperture, c.shutter, c.iso, c.quality_rating,
              EXISTS (SELECT 1 FROM originals ro WHERE ro.capture_id = ${filesCaptureOf("c")} AND ro.kind = 'raw') AS has_raw,
              o.ref AS original_ref, o.kind AS original_kind, o.managed AS original_managed,
              c.tags, c.region_id, c.location_label, c.lat, c.lon,
              (SELECT io.inat_observation_id FROM capture_inaturalist_observations io WHERE io.capture_id = c.id AND io.photo_sent) AS inat_observation_id,
              -- For the species sorts, as the Gallery's.
              s.taxon_class, s.taxon_order, s.family, s.sort_order, ${GALLERY_TIER_SQL} AS tier
       FROM captures c
       JOIN photos p ON p.id = c.current_photo_id
       JOIN species s ON s.id = c.species_id
       -- jpeg-preferred tiebreak (same as Gallery/species detail's own capture query) - a
       -- capture whose only original is a RAW file has no jpeg to win the tiebreak, so this
       -- resolves to 'raw', which the frontend uses to hide "Download original" (Download RAW
       -- already covers that exact same file).
       LEFT JOIN LATERAL (
         SELECT * FROM originals lo WHERE lo.capture_id = ${filesCaptureOf("c")} ORDER BY (lo.kind = 'jpeg') DESC LIMIT 1
       ) o ON true
       WHERE c.trip_id = $1 AND c.user_id = $2
       ORDER BY c.taken_at DESC NULLS LAST, c.created_at DESC`,
        [request.params.id, userId],
      );

      // A sensitive species' photo comes by region only, as on a share.
      const hidden = await sensitiveForKey(request, res.rows);
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
          takenAtZoned: row.taken_at_zoned,
          hasRaw: row.has_raw,
          originalRef: row.original_ref,
          inatObservationId: row.inat_observation_id,
          originalKind: row.original_kind,
          originalManaged: row.original_managed ?? null,
          tags: row.tags ?? [],
          regionId: row.region_id,
          locationLabel: hidden?.has(row.capture_id) ? null : row.location_label,
          lat: hidden?.has(row.capture_id) ? null : row.lat,
          lon: hidden?.has(row.capture_id) ? null : row.lon,
          cameraModel: row.camera_model,
          lens: row.lens,
          focalLengthMm: row.focal_length_mm,
          aperture: row.aperture,
          shutter: row.shutter,
          iso: row.iso,
          qualityRating: row.quality_rating,
          taxonClass: row.taxon_class,
          taxonOrder: row.taxon_order,
          family: row.family,
          sortOrder: row.sort_order,
          tier: row.tier,
        })),
      };
    },
  );

  await app.register(tripJobRoutes);
  await app.register(tripMembershipRoutes);
  await app.register(tripFileMoveRoutes);
}
