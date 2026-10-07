import { readdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool, withTransaction } from "@lifer/core/db.js";
import { requireAuth } from "../auth/session.js";
import { metadataGoesInFile, sidecarPathFor } from "../uploads/exif.js";
import { invalidateUserVectors } from "@lifer/core/species/embeddings.js";
import { ensureDefaultCardCropLater } from "../collection/defaultCardCrop.js";
import { repointCoversOffTrashedCaptures, restoreCoversForCapture } from "../lib/userSpecies.js";
import { APP_DATA_DIR, ORIGINALS_DIR } from "@lifer/core/config.js";
import { removeEmptyDirsUpward } from "../lib/fsCleanup.js";
import { canonicalPath, isWithinResolved } from "@lifer/core/lib/pathContainment.js";
import { resolveOriginalPath } from "../storageVolumes/resolve.js";
import { Flag, IdParams, Ok, Uuid, notFoundOnInvalidId, replies, withSchemas } from "../lib/schema.js";

// Trash: deleting a capture hides it for TRASH_RETENTION_DAYS, then it's purged for good.
export async function trashRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  // Sets deleted_at, which hides the capture everywhere via the `captures` view. deleteRaw is
  // recorded as intent and acted on at purge time. Returns the ids actually trashed.
  async function trashCaptures(userId: string, captureIds: string[], deleteRaw: boolean): Promise<string[]> {
    const recropSpecies: string[] = [];
    const trashed = await withTransaction(async (client) => {
      const res = await client.query<{ id: string }>(
        `UPDATE captures_all SET deleted_at = now(), pending_delete_raw = $1
         WHERE id = ANY($2::uuid[]) AND user_id = $3 AND deleted_at IS NULL RETURNING id`,
        [deleteRaw, captureIds, userId],
      );
      const ids = res.rows.map((r) => r.id);
      // Soft delete leaves user_species.cover_photo_id alone, so without this a trashed featured
      // photo stays the species cover and every card that reads it shows a missing thumbnail.
      recropSpecies.push(...(await repointCoversOffTrashedCaptures(client, userId, ids)));
      return ids;
    });
    if (trashed.length > 0) invalidateUserVectors(userId);
    for (const speciesId of recropSpecies) ensureDefaultCardCropLater(userId, speciesId);
    return trashed;
  }

  /** Un-trashes a capture, clearing deleted_at and the pending RAW delete. */
  async function restoreCapture(userId: string, captureId: string): Promise<{ notFound?: true }> {
    const recropSpecies: string[] = [];
    const restored = await withTransaction(async (client) => {
      const res = await client.query(
        `UPDATE captures_all SET deleted_at = NULL, pending_delete_raw = false WHERE id = $1 AND user_id = $2 AND deleted_at IS NOT NULL`,
        [captureId, userId],
      );
      if ((res.rowCount ?? 0) === 0) return false;
      recropSpecies.push(...(await restoreCoversForCapture(client, userId, captureId)));
      return true;
    });
    if (!restored) return { notFound: true };
    invalidateUserVectors(userId);
    for (const speciesId of recropSpecies) ensureDefaultCardCropLater(userId, speciesId);
    return {};
  }

  // Permanent removal, after the retention window or when the trash is emptied. Managed files
  // are deleted (the RAW only if deleteRaw was chosen); linked files are never touched.
  async function purgeCaptures(
    userId: string,
    items: Array<{ id: string; deleteRaw: boolean }>,
  ): Promise<{ purged: number }> {
    if (items.length === 0) return { purged: 0 };
    const requestedIds = items.map((i) => i.id);
    // captures_all, since trashed captures are invisible via the `captures` view.
    const capturesRes = await pool.query<{ id: string; species_id: string }>(
      `SELECT id, species_id FROM captures_all WHERE id = ANY($1::uuid[]) AND user_id = $2`,
      [requestedIds, userId],
    );
    if (capturesRes.rows.length === 0) return { purged: 0 };
    const found = new Set(capturesRes.rows.map((c) => c.id));
    const rawCaptureIds = items.filter((i) => i.deleteRaw && found.has(i.id)).map((i) => i.id);

    // A capture whose file is on a disconnected drive stays in the Trash so the file isn't
    // orphaned; the next purge retries it.
    const managedRes = await pool.query<{ capture_id: string; kind: string; ref: string; volume_id: string | null; volume_relative_path: string | null }>(
      `SELECT capture_id, kind, ref, volume_id, volume_relative_path FROM originals
       WHERE capture_id = ANY($1::uuid[]) AND managed = true
         AND (kind IN ('jpeg', 'video') OR (kind = 'raw' AND capture_id = ANY($2::uuid[])))`,
      [[...found], rawCaptureIds],
    );
    const originalFiles: Array<{ captureId: string; path: string }> = [];
    const waitingForDrive = new Set<string>();
    for (const row of managedRes.rows) {
      const resolved = await resolveOriginalPath(row);
      if (resolved.path) originalFiles.push({ captureId: row.capture_id, path: resolved.path });
      else waitingForDrive.add(row.capture_id);
    }
    const captureIds = [...found].filter((id) => !waitingForDrive.has(id));
    if (captureIds.length === 0) return { purged: 0 };
    const filesToDelete = originalFiles.filter((f) => !waitingForDrive.has(f.captureId)).map((f) => f.path);
    const purgedCaptures = capturesRes.rows.filter((c) => !waitingForDrive.has(c.id));

    const photosRes = await pool.query<{ id: string; display_path: string; thumb_path: string }>(
      `SELECT id, display_path, thumb_path FROM photos WHERE capture_id = ANY($1::uuid[])`,
      [captureIds],
    );
    const photoIds = photosRes.rows.map((p) => p.id);

    const recropSpecies: string[] = [];
    await withTransaction(async (client) => {
      // Fix up user_species before deleting: cover_photo_id's FK has no cascade, so affected
      // species are repointed at their newest remaining capture, or drop back to "unseen".
      const coversRes = await client.query<{ species_id: string; is_target: boolean }>(
        `SELECT species_id, is_target FROM user_species WHERE user_id = $1 AND cover_photo_id = ANY($2::uuid[])`,
        [userId, photoIds],
      );
      for (const cover of coversRes.rows) {
        // A secondary (capture_species) tag on another capture is evidence for this species too.
        const remaining = await client.query<{ current_photo_id: string | null }>(
          `SELECT current_photo_id, taken_at FROM captures WHERE user_id = $1 AND species_id = $2 AND id <> ALL($3::uuid[])
           UNION ALL
           SELECT c.current_photo_id, c.taken_at FROM capture_species cs
             JOIN captures c ON c.id = cs.capture_id
             WHERE cs.species_id = $2 AND c.user_id = $1 AND c.id <> ALL($3::uuid[])
           ORDER BY taken_at DESC NULLS LAST LIMIT 1`,
          [userId, cover.species_id, captureIds],
        );
        if (remaining.rows[0]?.current_photo_id) {
          await client.query(
            `UPDATE user_species SET cover_photo_id = $1, card_crop_x = NULL, card_crop_y = NULL, card_crop_size = NULL
             WHERE user_id = $2 AND species_id = $3`,
            [remaining.rows[0].current_photo_id, userId, cover.species_id],
          );
          recropSpecies.push(cover.species_id);
        } else if (cover.is_target) {
          // is_target is independent of photos, so only state, cover and crop are cleared.
          await client.query(
            `UPDATE user_species SET state = NULL, cover_photo_id = NULL, card_crop_x = NULL, card_crop_y = NULL,
               card_crop_size = NULL, best_quality = NULL WHERE user_id = $1 AND species_id = $2`,
            [userId, cover.species_id],
          );
        } else {
          await client.query(`DELETE FROM user_species WHERE user_id = $1 AND species_id = $2`, [userId, cover.species_id]);
        }
      }

      // albums.cover_photo_id has no ON DELETE either: repoint each affected album at its newest
      // remaining capture, or clear it.
      if (photoIds.length > 0) {
        await client.query(
          `UPDATE albums a SET cover_photo_id = (
             SELECT c.current_photo_id FROM album_captures ac
               JOIN captures c ON c.id = ac.capture_id
               WHERE ac.album_id = a.id AND ac.capture_id <> ALL($3::uuid[]) AND c.current_photo_id IS NOT NULL
               ORDER BY c.taken_at DESC NULLS LAST LIMIT 1
           ), cover_crop_x = NULL, cover_crop_y = NULL, cover_crop_size = NULL
           WHERE a.user_id = $1 AND a.cover_photo_id = ANY($2::uuid[])`,
          [userId, photoIds, captureIds],
        );
      }

      // captures_all again: DELETE FROM the view would filter out these trashed rows and delete
      // nothing.
      await client.query(`DELETE FROM captures_all WHERE id = ANY($1::uuid[])`, [captureIds]);

      // Deleting captures can remove the current best-rated photo for a species: recompute.
      const speciesIds = [...new Set(purgedCaptures.map((c) => c.species_id))];
      await client.query(
        `UPDATE user_species us SET best_quality = (
           SELECT MAX(quality_rating) FROM captures c WHERE c.user_id = $1 AND c.species_id = us.species_id
         ) WHERE us.user_id = $1 AND us.species_id = ANY($2::uuid[])`,
        [userId, speciesIds],
      );
    });
    invalidateUserVectors(userId);
    // A cover may have moved to another photo above: frame the card on the animal.
    for (const speciesId of recropSpecies) ensureDefaultCardCropLater(userId, speciesId);

    // Derivatives are Lifer's own files, safe to delete. Each unlink is independent so one
    // failure can't stop the rest.
    const files: string[] = [];
    for (const p of photosRes.rows) {
      files.push(
        p.display_path,
        p.thumb_path,
        path.join(APP_DATA_DIR, "medium", `${p.id}.webp`),
        path.join(APP_DATA_DIR, "video-preview", `${p.id}.mp4`),
      );
    }
    for (const file of files) await removeFileQuietly(file);
    for (const file of filesToDelete) {
      await removeFileQuietly(file);
      await removeSidecarIfUnshared(file);
      if (isInside(file, ORIGINALS_DIR)) {
        await removeEmptyDirsUpward(path.dirname(file), ORIGINALS_DIR).catch((err) =>
          app.log.warn({ err, file }, "Couldn't tidy an empty library folder"),
        );
      }
    }

    return { purged: captureIds.length };
  }

  // A RAW and its edited copy can share one stem.xmp; keep it while another file with that stem
  // (a kept RAW, say) is still in the folder.
  async function removeSidecarIfUnshared(file: string): Promise<void> {
    if (metadataGoesInFile(file)) return;
    const dir = path.dirname(file);
    const stem = path.basename(file, path.extname(file));
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    const shared = entries.some((name) => path.extname(name).toLowerCase() !== ".xmp" && path.basename(name, path.extname(name)) === stem);
    if (!shared) await removeFileQuietly(sidecarPathFor(file));
  }

  function isInside(file: string, dir: string): boolean {
    return canonicalPath(file) !== canonicalPath(dir) && isWithinResolved(dir, file);
  }

  async function removeFileQuietly(file: string | null): Promise<void> {
    if (!file) return;
    try {
      await unlink(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") app.log.warn({ err, file }, "Couldn't delete a purged file");
    }
  }

  // Purges in chunks; a failed chunk is retried one capture at a time so one bad row can't
  // block the rest.
  async function purgeManyCaptures(userId: string, items: Array<{ id: string; deleteRaw: boolean }>): Promise<number> {
    const CHUNK = 500;
    let purged = 0;
    for (let i = 0; i < items.length; i += CHUNK) {
      const chunk = items.slice(i, i + CHUNK);
      try {
        purged += (await purgeCaptures(userId, chunk)).purged;
      } catch (err) {
        app.log.warn({ err }, "Batch purge failed, retrying one at a time");
        for (const item of chunk) {
          try {
            purged += (await purgeCaptures(userId, [item])).purged;
          } catch (itemErr) {
            app.log.error({ err: itemErr, captureId: item.id }, "Failed to purge a trashed capture");
          }
        }
      }
    }
    return purged;
  }

  app.delete(
    "/captures/:id",
    {
      preValidation: requireAuth,
      config: notFoundOnInvalidId("Capture not found"),
      schema: {
        params: IdParams,
        querystring: Type.Object({ deleteRaw: Flag("1 to also delete the RAW file when the trash is purged") }),
        response: replies(Ok),
      },
    },
    async (request, reply) => {
      const trashed = await trashCaptures(request.user!.id, [request.params.id], request.query.deleteRaw === "1");
      if (trashed.length === 0) return reply.code(404).send({ error: "Capture not found" });
      return { ok: true };
    },
  );

  // Multi-select delete. deleteRaw applies to the whole batch.
  const MAX_BATCH_TRASH = 5000;
  app.post(
    "/captures/batch-delete",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          {
            captureIds: Type.Array(Uuid(), { minItems: 1, maxItems: MAX_BATCH_TRASH }),
            deleteRaw: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
        response: replies(Type.Object({ deleted: Type.Integer(), notFound: Type.Integer() })),
      },
    },
    async (request) => {
      const { captureIds, deleteRaw } = request.body;
      const userId = request.user!.id;
      const deleted = (await trashCaptures(userId, [...new Set(captureIds)], !!deleteRaw)).length;
      const notFound = captureIds.length - deleted;
      return { deleted, notFound };
    },
  );

  // Trashed Photos (Settings), newest first. Reads captures_all, since the `captures` view
  // hides trashed rows.
  const TRASH_RETENTION_DAYS = 7;
  // No response schema: the trash page reads these rows as they are.
  app.get("/trash", { preValidation: requireAuth, schema: {} }, async (request) => {
    const userId = request.user!.id;
    const res = await pool.query<{
      id: string;
      species_id: string;
      common_name: string | null;
      scientific_name: string;
      deleted_at: string;
      pending_delete_raw: boolean;
      photo_id: string | null;
      width: number | null;
      height: number | null;
      has_raw_original: boolean;
      photo_kind: "image" | "video" | null;
      duration_seconds: number | null;
      original_kind: string | null;
    }>(
      `SELECT c.id, c.species_id, s.common_name, s.scientific_name, c.deleted_at, c.pending_delete_raw,
              c.current_photo_id AS photo_id, p.width, p.height, p.kind AS photo_kind, p.duration_seconds,
              EXISTS (SELECT 1 FROM originals o WHERE o.capture_id = c.id AND o.kind = 'raw') AS has_raw_original,
              o.kind AS original_kind
       FROM captures_all c
       JOIN species s ON s.id = c.species_id
       LEFT JOIN photos p ON p.id = c.current_photo_id
       -- One original per capture, preferring the jpeg (same tiebreak as GALLERY_ITEM_JOINS).
       LEFT JOIN LATERAL (
         SELECT * FROM originals lo WHERE lo.capture_id = c.id ORDER BY (lo.kind = 'jpeg') DESC LIMIT 1
       ) o ON true
       WHERE c.user_id = $1 AND c.deleted_at IS NOT NULL
       ORDER BY c.deleted_at DESC`,
      [userId],
    );
    return {
      retentionDays: TRASH_RETENTION_DAYS,
      items: res.rows.map((r) => ({
        captureId: r.id,
        speciesId: r.species_id,
        speciesName: r.common_name ?? r.scientific_name,
        deletedAt: r.deleted_at,
        pendingDeleteRaw: r.pending_delete_raw,
        photoId: r.photo_id,
        width: r.width,
        height: r.height,
        hasRawOriginal: r.has_raw_original,
        kind: r.photo_kind ?? "image",
        durationSeconds: r.duration_seconds,
        originalKind: r.original_kind,
        purgesAt: new Date(new Date(r.deleted_at).getTime() + TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      })),
    };
  });

  // The web app sends `{}`, so no body schema: there's nothing in it to read.
  app.post(
    "/trash/:id/restore",
    {
      preValidation: requireAuth,
      config: notFoundOnInvalidId("Not in trash"),
      schema: { params: IdParams, response: replies(Ok) },
    },
    async (request, reply) => {
      const result = await restoreCapture(request.user!.id, request.params.id);
      if (result.notFound) return reply.code(404).send({ error: "Not in trash" });
      return { ok: true };
    },
  );

  // Purges the whole trash now, whatever its age.
  app.post(
    "/trash/empty",
    { preValidation: requireAuth, schema: { response: replies(Type.Object({ purged: Type.Integer() })) } },
    async (request) => {
      const userId = request.user!.id;
      const res = await pool.query<{ id: string; pending_delete_raw: boolean }>(
        `SELECT id, pending_delete_raw FROM captures_all WHERE user_id = $1 AND deleted_at IS NOT NULL`,
        [userId],
      );
      const purged = await purgeManyCaptures(
        userId,
        res.rows.map((r) => ({ id: r.id, deleteRaw: r.pending_delete_raw })),
      );
      return { purged };
    },
  );

  // Purges every user's trash past its retention window, at startup and then daily.
  async function sweepExpiredTrash(): Promise<void> {
    const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const res = await pool.query<{ id: string; user_id: string; pending_delete_raw: boolean }>(
      `SELECT id, user_id, pending_delete_raw FROM captures_all WHERE deleted_at IS NOT NULL AND deleted_at < $1`,
      [cutoff],
    );
    const byUser = new Map<string, Array<{ id: string; deleteRaw: boolean }>>();
    for (const row of res.rows) {
      const list = byUser.get(row.user_id) ?? [];
      list.push({ id: row.id, deleteRaw: row.pending_delete_raw });
      byUser.set(row.user_id, list);
    }
    for (const [userId, items] of byUser) await purgeManyCaptures(userId, items);
    if (res.rows.length > 0) app.log.info(`[trash] purged ${res.rows.length} expired capture(s)`);
  }
  const TRASH_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
  sweepExpiredTrash().catch((err) => app.log.warn({ err }, "Initial trash sweep failed"));
  setInterval(() => sweepExpiredTrash().catch((err) => app.log.warn({ err }, "Trash sweep failed")), TRASH_SWEEP_INTERVAL_MS);
}
