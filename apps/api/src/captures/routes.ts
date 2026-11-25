// Capture edits: species tags, reassigning, date, location, rating and appearance. Removing a
// capture never touches its original file, only Lifer's records and generated derivatives.
import { APPEARANCE_TEXT_MAX, LIFE_STAGES, SEXES, appearanceText, dateOnlyToTakenAt } from "@lifer/shared";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import type { PoolClient } from "pg";
import { pool, withTransaction } from "@lifer/core/db.js";
import { SINGLE_USER_MODE } from "@lifer/core/config.js";
import { IdParams, Nullable, Ok, Uuid, notFoundOnInvalidId, replies, withSchemas } from "../lib/schema.js";
import { requireScope } from "../auth/session.js";
import { syncCaptureXmpSidecarsLogged } from "../uploads/xmpSidecarSync.js";
import { invalidateUserVectors } from "@lifer/core/species/embeddings.js";
import { ensureDefaultCardCropLater } from "../collection/defaultCardCrop.js";
import { moveManagedOriginalToSpeciesFolder } from "../uploads/routes.js";
import { moveToFolder } from "@lifer/core/lib/safeFs.js";
import { markCollected } from "../lib/userSpecies.js";
import { followPlaceChange } from "../uploads/reorganizeOriginals.js";
import { captureTagRoutes } from "./tags.js";
import { PLACE_NAME_MAX, capturePlaceRoutes } from "./places.js";
import { trashRoutes } from "./trash.js";
import { hiddenCaptureRoutes } from "./hidden.js";
import { captureVersionRoutes } from "./versions.js";
import { speciesSuggestRoutes } from "./suggest.js";
import { queueRecheck, recheckRoutes } from "./recheck.js";
import { takenAtShiftRoutes } from "./takenAtShift.js";
import {
  PLACE_MAX,
  SYNC_PLACE_MAX,
  applyLocation,
  locationJobRunningFor,
  locationRoutes,
  startLocationJob,
} from "./locationHistory.js";

type Queryable = Pick<PoolClient, "query">;

interface SpeciesRow {
  id: string;
  common_name: string | null;
  scientific_name: string;
  taxon_class: string | null;
  family: string | null;
  aba_code: string | null;
  ebird_code: string | null;
}

/** Clears a species' user_species row once no capture evidences it, after a reassign moves a
 *  capture away. `vacatedPhotoId` is the photo that stopped counting, so a cover on it is
 *  repointed. Returns whether the cover moved. */
async function cleanupStaleUserSpecies(
  db: Queryable,
  userId: string,
  speciesId: string,
  vacatedPhotoId: string | null,
): Promise<boolean> {
  const userSpeciesRes = await db.query<{ cover_photo_id: string | null; is_target: boolean }>(
    `SELECT cover_photo_id, is_target FROM user_species WHERE user_id = $1 AND species_id = $2`,
    [userId, speciesId],
  );
  const row = userSpeciesRes.rows[0];
  if (!row) return false;

  // Primary captures and secondary (capture_species) tags both count as evidence for a species.
  const remainingRes = await db.query<{ current_photo_id: string | null }>(
    `SELECT current_photo_id, taken_at FROM captures WHERE user_id = $1 AND species_id = $2
     UNION ALL
     SELECT c.current_photo_id, c.taken_at FROM capture_species cs
       JOIN captures c ON c.id = cs.capture_id
       WHERE cs.species_id = $2 AND c.user_id = $1
     ORDER BY taken_at DESC NULLS LAST LIMIT 1`,
    [userId, speciesId],
  );
  const newestRemaining = remainingRes.rows[0] ?? null;

  if (!newestRemaining) {
    // Nothing justifies 'collected' any more. A target keeps its row (is_target is independent
    // of photos), stripped of state, cover and crop.
    if (row.is_target) {
      await db.query(
        `UPDATE user_species SET state = NULL, cover_photo_id = NULL, card_crop_x = NULL, card_crop_y = NULL,
           card_crop_size = NULL, best_quality = NULL WHERE user_id = $1 AND species_id = $2`,
        [userId, speciesId],
      );
    } else {
      await db.query(`DELETE FROM user_species WHERE user_id = $1 AND species_id = $2`, [userId, speciesId]);
    }
    return false;
  }

  // The cover may have been the photo that left: repoint it at the newest remaining photo and
  // clear the crop (a trigger brings in that photo's own crop, migration 197).
  const coverMoved = !!vacatedPhotoId && row.cover_photo_id === vacatedPhotoId;
  if (coverMoved) {
    await db.query(
      `UPDATE user_species SET cover_photo_id = $1, card_crop_x = NULL, card_crop_y = NULL, card_crop_size = NULL
       WHERE user_id = $2 AND species_id = $3`,
      [newestRemaining.current_photo_id, userId, speciesId],
    );
  }
  // Losing a capture can remove the best-rated photo, so recompute the max.
  await db.query(
    `UPDATE user_species SET best_quality = (
       SELECT MAX(quality_rating) FROM captures WHERE user_id = $1 AND species_id = $2
     ) WHERE user_id = $1 AND species_id = $2`,
    [userId, speciesId],
  );
  // The caller frames the new cover after COMMIT, once the repoint is visible to other queries.
  return coverMoved;
}

/** Corrects a capture's primary species: moves managed originals into the new species' folder,
 *  moves collected state, and rewrites the embedded species metadata. Shared by the reassign
 *  route and split re-filing (species/speciesSplits.ts). */
export async function reassignCaptureSpecies(
  userId: string,
  captureId: string,
  speciesId: string,
  log: { error: (obj: object, msg: string) => void },
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const captureRes = await pool.query<{ species_id: string; current_photo_id: string | null; taken_at: string | null }>(
    `SELECT species_id, current_photo_id, taken_at FROM captures WHERE id = $1 AND user_id = $2`,
    [captureId, userId],
  );
  const capture = captureRes.rows[0];
  if (!capture) return { ok: false, status: 404, error: "Capture not found" };
  if (capture.species_id === speciesId) return { ok: false, status: 400, error: "That's already this photo's species" };

  const newSpeciesRes = await pool.query<SpeciesRow>(
    `SELECT id, common_name, scientific_name, taxon_class, family FROM species WHERE id = $1`,
    [speciesId],
  );
  const newSpecies = newSpeciesRes.rows[0];
  if (!newSpecies) return { ok: false, status: 400, error: "Unknown species" };

  const originalsRes = await pool.query<{ id: string }>(`SELECT id FROM originals WHERE capture_id = $1`, [captureId]);
  // Files move first (each within the folder it was filed under: the library, its drive or its
  // trip's folder), then DB changes commit together; a failed transaction moves the files back
  // so no original is left where its row doesn't point.
  const moved: Array<{ id: string; from: string; to: string; volumeRelativePath: string | null }> = [];
  const undoMoves = async () => {
    for (const m of moved.reverse()) {
      await moveToFolder(m.to, path.dirname(m.from), path.basename(m.from)).catch((err) =>
        log.error({ err, from: m.to, to: m.from }, "Couldn't move an original back after a failed reassign"),
      );
    }
  };
  try {
    for (const original of originalsRes.rows) {
      const move = await moveManagedOriginalToSpeciesFolder(userId, original.id, newSpecies.id);
      if (move) moved.push({ id: original.id, ...move });
    }
  } catch (err) {
    await undoMoves();
    throw err;
  }

  const oldSpeciesId = capture.species_id;
  let coverMoved: boolean;
  try {
    coverMoved = await withTransaction(async (client) => {
      for (const m of moved) {
        // A file on a drive or library root keeps its volume; its path on it follows the move.
        await client.query(
          `UPDATE originals SET ref = $1, volume_relative_path = COALESCE($2, volume_relative_path) WHERE id = $3`,
          [m.to, m.volumeRelativePath, m.id],
        );
      }
      // Choosing a species is confirming it, whatever filed the photo before.
      await client.query(
        `UPDATE captures SET species_id = $1, identification_state = 'confirmed', suggestion_percent = NULL WHERE id = $2`,
        [speciesId, captureId],
      );
      await markCollected(client, userId, speciesId, capture.current_photo_id, capture.taken_at);
      // If the old species' cover becomes the new species' cover, its framing comes with it.
      await client.query(
        `UPDATE user_species ns SET card_crop_x = os.card_crop_x, card_crop_y = os.card_crop_y, card_crop_size = os.card_crop_size
         FROM user_species os
         WHERE ns.user_id = $1 AND ns.species_id = $2 AND ns.cover_photo_id = $4 AND ns.card_crop_x IS NULL
           AND os.user_id = $1 AND os.species_id = $3 AND os.cover_photo_id = $4 AND os.card_crop_x IS NOT NULL`,
        [userId, speciesId, oldSpeciesId, capture.current_photo_id],
      );
      // The old species may have had only this capture backing it.
      return cleanupStaleUserSpecies(client, userId, oldSpeciesId, capture.current_photo_id);
    });
  } catch (err) {
    await undoMoves();
    throw err;
  }
  invalidateUserVectors(userId);
  if (coverMoved) ensureDefaultCardCropLater(userId, oldSpeciesId);
  // A new cover with no framing to carry over is framed on the animal, like any first photo.
  ensureDefaultCardCropLater(userId, speciesId);

  await syncCaptureXmpSidecarsLogged(userId, captureId);
  return { ok: true };
}

const SpeciesBody = Type.Object({ speciesId: Uuid() }, { additionalProperties: false });
const captureNotFound = notFoundOnInvalidId("Capture not found");

const MAX_LOCATION_BATCH = 5000;

/** Sets the region and/or location label of this user's captures; a field left undefined stays
 *  as it is. Trashed captures are skipped by the `captures` view. Returns how many changed. */
async function setCaptureLocation(
  userId: string,
  captureIds: string[],
  regionId: string | null | undefined,
  locationLabel: string | null | undefined,
): Promise<number> {
  const res = await pool.query<{ id: string }>(
    `UPDATE captures SET
       region_id = CASE WHEN $4::boolean THEN $1 ELSE region_id END,
       location_label = CASE WHEN $5::boolean THEN $2 ELSE location_label END
     WHERE id = ANY($3::uuid[]) AND user_id = $6
     RETURNING id`,
    [
      regionId ?? null,
      locationLabel?.trim() || null,
      captureIds,
      regionId !== undefined,
      locationLabel !== undefined,
      userId,
    ],
  );
  // The files' province, country and place name follow the change, and with place folders
  // in the folder layout so do their folders. In the background: exiftool is slow.
  if (regionId !== undefined || locationLabel !== undefined) {
    await followPlaceChange(
      userId,
      res.rows.map((r) => r.id),
      { replacePlace: !!regionId, replaceLabel: locationLabel !== undefined },
    );
  }
  // A new region changes which species suit the photos still waiting as suggestions.
  if (regionId)
    queueRecheck(
      userId,
      res.rows.map((r) => r.id),
    );
  return res.rows.length;
}

export async function captureRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  // Tags a second species in a photo (a hawk catching a fish). It counts as collected too.
  // A connected app's imports.write key may add (never remove) species on photos it imported itself.
  app.post(
    "/captures/:id/species",
    {
      preValidation: requireScope("photos.write", ["imports.write"], { missingScope403: true }),
      config: captureNotFound,
      schema: { params: IdParams, body: SpeciesBody, response: replies(Ok, 201) },
    },
    async (request, reply) => {
      const { id: captureId } = request.params;
      const { speciesId } = request.body;
      const userId = request.user!.id;

      const captureRes = await pool.query<{
        species_id: string;
        current_photo_id: string | null;
        taken_at: string | null;
        imported_by_key_id: string | null;
      }>(
        `SELECT species_id, current_photo_id, taken_at, imported_by_key_id FROM captures_all
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL AND hidden_at IS NULL`,
        [captureId, userId],
      );
      const capture = captureRes.rows[0];
      if (!capture) return reply.code(404).send({ error: "Capture not found" });
      // On the desktop the gate lets any app key through to here, so every key is held to its own imports.
      const keyLimited =
        request.apiKeyId !== undefined && (SINGLE_USER_MODE || !request.apiKeyScopes?.includes("photos.write"));
      if (keyLimited && capture.imported_by_key_id !== request.apiKeyId) {
        return reply.code(403).send({ error: "This key can only tag photos it imported", code: "not_imported_by_key" });
      }
      if (capture.species_id === speciesId) {
        return reply.code(400).send({ error: "That's already this photo's primary species" });
      }

      const speciesRes = await pool.query(`SELECT id FROM species WHERE id = $1`, [speciesId]);
      if (speciesRes.rows.length === 0) return reply.code(400).send({ error: "Unknown species" });

      await pool.query(`INSERT INTO capture_species (capture_id, species_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
        captureId,
        speciesId,
      ]);

      await markCollected(pool, userId, speciesId, capture.current_photo_id, capture.taken_at);

      await syncCaptureXmpSidecarsLogged(userId, captureId);
      return reply.code(201).send({ ok: true });
    },
  );

  app.delete(
    "/captures/:id/species/:speciesId",
    {
      preValidation: requireScope("photos.write"),
      config: notFoundOnInvalidId("Tag not found"),
      schema: { params: Type.Object({ id: Uuid(), speciesId: Uuid() }), response: replies(Ok) },
    },
    async (request, reply) => {
      const { id: captureId, speciesId } = request.params;
      const userId = request.user!.id;

      const res = await pool.query(
        `DELETE FROM capture_species WHERE capture_id = $1 AND species_id = $2
         AND EXISTS (SELECT 1 FROM captures WHERE id = $1 AND user_id = $3)`,
        [captureId, speciesId, userId],
      );
      if (res.rowCount === 0) return reply.code(404).send({ error: "Tag not found" });

      // Collected state is left alone: untagging doesn't decide whether you've seen the species.
      await syncCaptureXmpSidecarsLogged(userId, captureId);
      return { ok: true };
    },
  );

  // Corrects a misidentified capture's primary species.
  app.patch(
    "/captures/:id/reassign",
    {
      preValidation: requireScope("photos.write"),
      config: captureNotFound,
      schema: { params: IdParams, body: SpeciesBody, response: replies(Ok) },
    },
    async (request, reply) => {
      const { id: captureId } = request.params;
      const { speciesId } = request.body;
      const userId = request.user!.id;
      const result = await reassignCaptureSpecies(userId, captureId, speciesId, request.log);
      if (!result.ok) return reply.code(result.status).send({ error: result.error });
      return { ok: true };
    },
  );

  // Sets or clears taken_at, e.g. for a scan with no EXIF date (Stats > Missing date).
  app.patch(
    "/captures/:id/taken-at",
    {
      preValidation: requireScope("photos.write"),
      config: captureNotFound,
      schema: {
        params: IdParams,
        // Not format date-time: that needs a UTC offset, and scripts may send a local time. The
        // handler checks the string parses as a date.
        body: Type.Object({ takenAt: Nullable(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
        response: replies(Ok),
      },
    },
    async (request, reply) => {
      const { id: captureId } = request.params;
      const userId = request.user!.id;

      if (request.body.takenAt !== null && Number.isNaN(new Date(request.body.takenAt).getTime())) {
        return reply.code(400).send({ error: "takenAt must be a valid date, or null to clear" });
      }
      // A bare day ("2026-06-04") is stored as noon UTC so it reads as that day in every time zone.
      const takenAt = dateOnlyToTakenAt(request.body.takenAt) ?? request.body.takenAt;

      const res = await pool.query(`UPDATE captures SET taken_at = $1 WHERE id = $2 AND user_id = $3 RETURNING id`, [
        takenAt,
        captureId,
        userId,
      ]);
      if (res.rows.length === 0) return reply.code(404).send({ error: "Capture not found" });
      // Into the file too, when it has no date of its own, so a reimport brings it back.
      if (takenAt !== null) void syncCaptureXmpSidecarsLogged(userId, captureId);

      return { ok: true };
    },
  );

  /** Corrects a capture's region (catalog country/province) and free-text location label.
   * Each field is optional; one left out stays as it is. */
  app.patch(
    "/captures/:id/region",
    {
      preValidation: requireScope("photos.write"),
      config: captureNotFound,
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            regionId: Type.Optional(Nullable(Uuid())),
            locationLabel: Type.Optional(Nullable(Type.String({ maxLength: PLACE_NAME_MAX }))),
          },
          { additionalProperties: false },
        ),
        response: replies(Ok),
      },
    },
    async (request, reply) => {
      const { regionId, locationLabel } = request.body;
      const updated = await setCaptureLocation(request.user!.id, [request.params.id], regionId, locationLabel);
      if (updated === 0) return reply.code(404).send({ error: "Capture not found" });
      return { ok: true };
    },
  );

  // The same correction for many photos at once, e.g. Stats > Missing a region.
  app.post(
    "/captures/location",
    {
      preValidation: requireScope("photos.write"),
      schema: {
        body: Type.Object(
          {
            captureIds: Type.Array(Uuid(), { minItems: 1, maxItems: MAX_LOCATION_BATCH }),
            regionId: Nullable(Uuid()),
            locationLabel: Type.Optional(Nullable(Type.String({ maxLength: PLACE_NAME_MAX }))),
          },
          { additionalProperties: false },
        ),
        response: replies(Type.Object({ updated: Type.Integer() })),
      },
    },
    async (request) => {
      const { captureIds, regionId, locationLabel } = request.body;
      return { updated: await setCaptureLocation(request.user!.id, captureIds, regionId, locationLabel) };
    },
  );

  // Coordinates typed, pasted or placed on the map. Over SYNC_PLACE_MAX photos it runs in the
  // background (GET /captures/location/status); either way POST /captures/location/undo reverts it.
  app.post(
    "/captures/coordinates",
    {
      preValidation: requireScope("photos.write"),
      schema: {
        body: Type.Object(
          {
            captureIds: Type.Array(Uuid(), { minItems: 1, maxItems: PLACE_MAX }),
            lat: Nullable(Type.Number({ minimum: -90, maximum: 90 })),
            lon: Nullable(Type.Number({ minimum: -180, maximum: 180 })),
            locationLabel: Type.Optional(
              Nullable(
                Type.String({ maxLength: PLACE_NAME_MAX, description: "Also sets the place name; null clears it" }),
              ),
            ),
            regionId: Type.Optional(Uuid({ description: "Also sets the region" })),
            keepPoint: Type.Optional(
              Type.Boolean({ description: "Leave every point as it is: only the place name and region change" }),
            ),
          },
          { additionalProperties: false },
        ),
        response: replies(
          Type.Object({
            updated: Type.Integer({ description: "0 when it runs in the background" }),
            background: Type.Boolean({ description: "More than 5,000 photos: follow GET /captures/location/status" }),
          }),
        ),
      },
    },
    async (request, reply) => {
      const { captureIds, lat, lon, locationLabel, regionId, keepPoint } = request.body;
      const userId = request.user!.id;
      // One undo step for the point, the place name and the region together.
      const edit = {
        lat,
        lon,
        source: "map" as const,
        ...(locationLabel !== undefined ? { label: locationLabel?.trim() || null } : {}),
        ...(regionId ? { regionId } : {}),
        ...(keepPoint ? { keep: "all" as const } : {}),
      };
      if ((lat === null) !== (lon === null)) {
        return reply.code(400).send({ error: "Send both lat and lon, or both null to clear" });
      }
      if (locationJobRunningFor(userId)) return reply.code(409).send({ error: "Wait for the placement to finish" });
      if (captureIds.length > SYNC_PLACE_MAX) {
        if (!startLocationJob(userId, captureIds, edit, null))
          return reply.code(409).send({ error: "Photos are already being placed" });
        return { updated: 0, background: true };
      }
      return { updated: await applyLocation(userId, captureIds, edit), background: false };
    },
  );

  // Per-photo quality rating. user_species.best_quality is recomputed server-side as the max.
  app.patch(
    "/captures/:id/rating",
    {
      preValidation: requireScope("photos.write"),
      config: captureNotFound,
      schema: {
        params: IdParams,
        body: Type.Object(
          { rating: Nullable(Type.Integer({ minimum: 1, maximum: 5, description: "1-5, or null to clear" })) },
          { additionalProperties: false },
        ),
        response: replies(Ok),
      },
    },
    async (request, reply) => {
      const { id: captureId } = request.params;
      const { rating } = request.body;
      const userId = request.user!.id;

      const captureRes = await pool.query<{ species_id: string }>(
        `UPDATE captures SET quality_rating = $1 WHERE id = $2 AND user_id = $3 RETURNING species_id`,
        [rating, captureId, userId],
      );
      const capture = captureRes.rows[0];
      if (!capture) return reply.code(404).send({ error: "Capture not found" });

      await pool.query(
        `UPDATE user_species SET best_quality = (
           SELECT MAX(quality_rating) FROM captures WHERE user_id = $1 AND species_id = $2
         ) WHERE user_id = $1 AND species_id = $2`,
        [userId, capture.species_id],
      );

      await syncCaptureXmpSidecarsLogged(userId, captureId);
      return { ok: true };
    },
  );

  // How the animal looks, for one photo or a selection. A field left out stays as it is; null clears it.
  app.post(
    "/captures/appearance",
    {
      preValidation: requireScope("photos.write"),
      schema: {
        body: Type.Object(
          {
            captureIds: Type.Array(Uuid(), { minItems: 1, maxItems: MAX_LOCATION_BATCH }),
            lifeStage: Type.Optional(Nullable(Type.Enum([...LIFE_STAGES]))),
            sex: Type.Optional(Nullable(Type.Enum([...SEXES]))),
            plumage: Type.Optional(Nullable(Type.String({ maxLength: APPEARANCE_TEXT_MAX }))),
            morph: Type.Optional(Nullable(Type.String({ maxLength: APPEARANCE_TEXT_MAX }))),
          },
          { additionalProperties: false },
        ),
        response: replies(Type.Object({ updated: Type.Integer() })),
      },
    },
    async (request) => {
      const { captureIds, lifeStage, sex, plumage, morph } = request.body;
      const sets: string[] = [];
      const params: unknown[] = [request.user!.id, captureIds];
      const set = (column: string, value: string | null | undefined) => {
        if (value === undefined) return;
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };
      set("life_stage", lifeStage);
      set("sex", sex);
      set("plumage", plumage === undefined ? undefined : appearanceText(plumage));
      set("morph", morph === undefined ? undefined : appearanceText(morph));
      if (sets.length === 0) return { updated: 0 };
      const res = await pool.query(
        `UPDATE captures SET ${sets.join(", ")} WHERE user_id = $1 AND id = ANY($2::uuid[])`,
        params,
      );
      return { updated: res.rowCount ?? 0 };
    },
  );

  await app.register(captureTagRoutes);
  await app.register(capturePlaceRoutes);
  await app.register(trashRoutes);
  await app.register(hiddenCaptureRoutes);
  await app.register(captureVersionRoutes);
  await app.register(speciesSuggestRoutes);
  await app.register(recheckRoutes);
  await app.register(takenAtShiftRoutes);
  await app.register(locationRoutes);
}
