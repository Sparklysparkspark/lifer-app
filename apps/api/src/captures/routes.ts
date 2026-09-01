// "Remove from Lifer" — deletes Lifer's own records and derivative files (display/thumb
// WebPs, which Lifer always generated and always owns) but deliberately never touches the
// original file on disk, even in "store" mode where Lifer wrote it. A UI action to tidy up
// your collection shouldn't be able to destroy your only copy of a photo as a side effect —
// if you want the stored copy gone too, that's a separate, explicit action to add later, not
// a default. (Known tradeoff: a removed "store"-mode original is now an orphaned file with no
// DB reference back to it — acceptable for a personal deployment, worth revisiting if this
// ever needs a "reclaim disk space" story.)
import { existsSync, unlinkSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireAuth } from "../auth/session.js";
import { writeSpeciesMetadata } from "../uploads/exif.js";
import { suggestSpecies } from "../species/embeddings.js";
import { moveManagedOriginalToSpeciesFolder } from "../uploads/routes.js";

interface SpeciesRow {
  id: string;
  common_name: string | null;
  scientific_name: string;
  taxon_class: string | null;
  family: string | null;
}

/** Re-embeds the full, current species list (primary + every tagged secondary) into a
 *  capture's managed JPEG original, if it has one — a linked/external file is never
 *  touched, same rule as the upload flow. Best-effort: a photo with no managed JPEG (RAW-
 *  only, or link/s3 mode) just skips this, nothing to write metadata into. */
async function resyncSpeciesMetadata(captureId: string): Promise<void> {
  const originalRes = await pool.query<{ ref: string }>(
    `SELECT ref FROM originals WHERE capture_id = $1 AND kind = 'jpeg' AND managed = true`,
    [captureId],
  );
  const original = originalRes.rows[0];
  if (!original) return;

  const speciesRes = await pool.query<SpeciesRow>(
    `SELECT s.id, s.common_name, s.scientific_name, s.taxon_class, s.family
     FROM species s WHERE s.id = (SELECT species_id FROM captures WHERE id = $1)
     UNION ALL
     SELECT s.id, s.common_name, s.scientific_name, s.taxon_class, s.family
     FROM species s JOIN capture_species cs ON cs.species_id = s.id WHERE cs.capture_id = $1`,
    [captureId],
  );

  await writeSpeciesMetadata(
    original.ref,
    speciesRes.rows.map((s) => ({
      commonName: s.common_name,
      scientificName: s.scientific_name,
      taxonClass: s.taxon_class,
      family: s.family,
    })),
  );
}

export async function captureRoutes(app: FastifyInstance): Promise<void> {
  // Marks a photo as containing an additional species beyond its primary one (e.g. a hawk
  // catching a fish) — the secondary species counts as fully collected, same as the primary,
  // and shows up on that species' own detail page alongside its other photos.
  app.post<{ Params: { id: string }; Body: { speciesId?: string } }>(
    "/captures/:id/species",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id: captureId } = request.params;
      const { speciesId } = request.body ?? {};
      const userId = request.user!.id;
      if (!speciesId) return reply.code(400).send({ error: "speciesId is required" });

      const captureRes = await pool.query<{ species_id: string; current_photo_id: string | null; taken_at: string | null }>(
        `SELECT species_id, current_photo_id, taken_at FROM captures WHERE id = $1 AND user_id = $2`,
        [captureId, userId],
      );
      const capture = captureRes.rows[0];
      if (!capture) return reply.code(404).send({ error: "Capture not found" });
      if (capture.species_id === speciesId) {
        return reply.code(400).send({ error: "That's already this photo's primary species" });
      }

      const speciesRes = await pool.query(`SELECT id FROM species WHERE id = $1`, [speciesId]);
      if (speciesRes.rows.length === 0) return reply.code(400).send({ error: "Unknown species" });

      await pool.query(
        `INSERT INTO capture_species (capture_id, species_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [captureId, speciesId],
      );

      // Same "counts as collected" upsert the primary species gets on upload (see
      // uploads/routes.ts) — a secondary tag is not a lesser citation of the species.
      await pool.query(
        `INSERT INTO user_species (user_id, species_id, state, cover_photo_id, first_collected)
         VALUES ($1, $2, 'collected', $3, COALESCE($4::date, CURRENT_DATE))
         ON CONFLICT (user_id, species_id) DO UPDATE SET
           state = 'collected',
           cover_photo_id = COALESCE(user_species.cover_photo_id, EXCLUDED.cover_photo_id)`,
        [userId, speciesId, capture.current_photo_id, capture.taken_at],
      );

      await resyncSpeciesMetadata(captureId);
      return reply.code(201).send({ ok: true });
    },
  );

  app.delete<{ Params: { id: string; speciesId: string } }>(
    "/captures/:id/species/:speciesId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id: captureId, speciesId } = request.params;
      const userId = request.user!.id;

      const res = await pool.query(
        `DELETE FROM capture_species WHERE capture_id = $1 AND species_id = $2
         AND EXISTS (SELECT 1 FROM captures WHERE id = $1 AND user_id = $3)`,
        [captureId, speciesId, userId],
      );
      if (res.rowCount === 0) return reply.code(404).send({ error: "Tag not found" });

      // Deliberately NOT touching user_species/collected state here — untagging a photo
      // doesn't retroactively decide whether you've "really" seen that species; that's a
      // separate, explicit decision the collection UI already has its own controls for.
      await resyncSpeciesMetadata(captureId);
      return { ok: true };
    },
  );

  // Corrects a misidentified capture's PRIMARY species — distinct from the secondary-species
  // tagging above (a hawk-catching-a-fish photo genuinely depicts two species; this is "I got
  // the ID wrong, it's actually this one instead"). Moves any managed original(s) into the
  // new species' own folder (photos are organized by species on disk — leaving a Mallard
  // photo sitting in the American Wigeon folder after correcting its ID would be a confusing
  // regression) and re-syncs the embedded XMP/IPTC species metadata, same as the secondary-tag
  // path already does.
  app.patch<{ Params: { id: string }; Body: { speciesId?: string } }>(
    "/captures/:id/reassign",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id: captureId } = request.params;
      const { speciesId } = request.body ?? {};
      const userId = request.user!.id;
      if (!speciesId) return reply.code(400).send({ error: "speciesId is required" });

      const captureRes = await pool.query<{ species_id: string; current_photo_id: string | null; taken_at: string | null }>(
        `SELECT species_id, current_photo_id, taken_at FROM captures WHERE id = $1 AND user_id = $2`,
        [captureId, userId],
      );
      const capture = captureRes.rows[0];
      if (!capture) return reply.code(404).send({ error: "Capture not found" });
      if (capture.species_id === speciesId) {
        return reply.code(400).send({ error: "That's already this photo's species" });
      }

      const newSpeciesRes = await pool.query<SpeciesRow>(
        `SELECT id, common_name, scientific_name, taxon_class, family FROM species WHERE id = $1`,
        [speciesId],
      );
      const newSpecies = newSpeciesRes.rows[0];
      if (!newSpecies) return reply.code(400).send({ error: "Unknown species" });

      const userRes = await pool.query<{ organize_originals_by_year: boolean }>(
        `SELECT organize_originals_by_year FROM users WHERE id = $1`,
        [userId],
      );
      const organizeByYear = userRes.rows[0]?.organize_originals_by_year ?? false;

      const takenAt = capture.taken_at ? new Date(capture.taken_at) : null;
      const originalsRes = await pool.query<{ id: string; kind: "raw" | "jpeg"; ref: string; managed: boolean }>(
        `SELECT id, kind, ref, managed FROM originals WHERE capture_id = $1`,
        [captureId],
      );
      for (const original of originalsRes.rows) {
        const newRef = await moveManagedOriginalToSpeciesFolder(
          original.ref,
          original.managed,
          newSpecies.common_name,
          newSpecies.scientific_name,
          original.kind,
          organizeByYear,
          newSpecies.taxon_class,
          takenAt,
        );
        if (newRef !== original.ref) {
          await pool.query(`UPDATE originals SET ref = $1 WHERE id = $2`, [newRef, original.id]);
        }
      }

      await pool.query(`UPDATE captures SET species_id = $1 WHERE id = $2`, [speciesId, captureId]);
      await pool.query(
        `INSERT INTO user_species (user_id, species_id, state, cover_photo_id, first_collected)
         VALUES ($1, $2, 'collected', $3, COALESCE($4::date, CURRENT_DATE))
         ON CONFLICT (user_id, species_id) DO UPDATE SET
           state = 'collected',
           cover_photo_id = COALESCE(user_species.cover_photo_id, EXCLUDED.cover_photo_id)`,
        [userId, speciesId, capture.current_photo_id, capture.taken_at],
      );

      await resyncSpeciesMetadata(captureId);
      return { ok: true };
    },
  );

  // Per-photo quality self-rating (spec §9 Phase 4: "track best-shot-per-species over
  // time"). user_species.best_quality is kept as a running MAX over the user's own
  // ratings for that species, recomputed here rather than trusted client-side, so it stays
  // correct no matter how many captures get rated/re-rated/cleared over time.
  app.patch<{ Params: { id: string }; Body: { rating: number | null } }>(
    "/captures/:id/rating",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id: captureId } = request.params;
      const { rating } = request.body ?? {};
      const userId = request.user!.id;

      if (rating !== null && (typeof rating !== "number" || rating < 1 || rating > 5 || !Number.isInteger(rating))) {
        return reply.code(400).send({ error: "rating must be an integer 1-5, or null to clear" });
      }

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

      return { ok: true };
    },
  );

  // "Delete Photo" — moves a capture to Trash rather than removing anything: sets
  // captures_all.deleted_at, which is all it takes for the auto-filtering `captures` view
  // (migration 061) to hide it from every existing query across the codebase without any of
  // them needing to change. Deliberately touches NO file on disk and no other DB row — a
  // trashed capture is byte-for-byte identical to before, just invisible, so restoring within
  // the week is always a pure, risk-free no-op. `deleteRaw` (the "also delete matching RAW"
  // checkbox) is only ever recorded as INTENT here (pending_delete_raw) — it's acted on by
  // purgeCapture below, once the trash window actually expires.
  async function trashCapture(userId: string, captureId: string, deleteRaw: boolean): Promise<{ notFound?: true }> {
    const res = await pool.query(
      `UPDATE captures_all SET deleted_at = now(), pending_delete_raw = $1 WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL`,
      [deleteRaw, captureId, userId],
    );
    if ((res.rowCount ?? 0) === 0) return { notFound: true };
    return {};
  }

  /** Un-trashes a capture — clears deleted_at (and the pending-raw-delete intent, since
   *  nothing was ever actually removed) so it's exactly as it was before being trashed. */
  async function restoreCapture(userId: string, captureId: string): Promise<{ notFound?: true }> {
    const res = await pool.query(
      `UPDATE captures_all SET deleted_at = NULL, pending_delete_raw = false WHERE id = $1 AND user_id = $2 AND deleted_at IS NOT NULL`,
      [captureId, userId],
    );
    if ((res.rowCount ?? 0) === 0) return { notFound: true };
    return {};
  }

  // The actual, permanent removal — everything trashCapture above deliberately deferred.
  // Runs once a trashed capture's week is up (see the purge job in index.ts), or immediately
  // for every trashed capture when the user empties the trash themselves. `deleteRaw` here
  // comes from whatever was recorded as intent at trash time (pending_delete_raw), not asked
  // again — scoped to `managed` RAW originals only (Lifer's own "store"-mode copy); a
  // `managed=false` link-mode original just has its DB row cascade away with the capture, its
  // file living wherever the user's own library already has it, never touched, matching the
  // read-only guarantee link mode has always had for every other original type.
  async function purgeCapture(userId: string, captureId: string, deleteRaw: boolean): Promise<{ notFound?: true }> {
    // captures_all, not the captures view — this capture is trashed (invisible via the view)
    // by the time purgeCapture ever runs.
    const captureRes = await pool.query<{ species_id: string; current_photo_id: string | null }>(
      `SELECT species_id, current_photo_id FROM captures_all WHERE id = $1 AND user_id = $2`,
      [captureId, userId],
    );
    const capture = captureRes.rows[0];
    if (!capture) return { notFound: true };

    const photosRes = await pool.query<{ id: string; display_path: string; thumb_path: string }>(
      `SELECT id, display_path, thumb_path FROM photos WHERE capture_id = $1`,
      [captureId],
    );

    const rawFilesToDelete: string[] = [];
    if (deleteRaw) {
      const rawRes = await pool.query<{ ref: string }>(
        `SELECT ref FROM originals WHERE capture_id = $1 AND kind = 'raw' AND managed = true`,
        [captureId],
      );
      rawFilesToDelete.push(...rawRes.rows.map((r) => r.ref));
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Fix up user_species BEFORE deleting the capture — cover_photo_id's FK has no
      // cascade, so it must stop pointing at this capture's photo first, or the delete
      // fails. If the deleted capture's photo was the cover, point it at another remaining
      // capture (most recent, excluding this one), or drop back to "unseen" if none are left.
      const coverRes = await client.query<{ cover_photo_id: string | null }>(
        `SELECT cover_photo_id FROM user_species WHERE user_id = $1 AND species_id = $2`,
        [userId, capture.species_id],
      );
      if (coverRes.rows[0] && photosRes.rows.some((p) => p.id === coverRes.rows[0].cover_photo_id)) {
        const remaining = await client.query<{ current_photo_id: string | null }>(
          `SELECT current_photo_id FROM captures WHERE user_id = $1 AND species_id = $2 AND id != $3
           ORDER BY taken_at DESC NULLS LAST, created_at DESC LIMIT 1`,
          [userId, capture.species_id, captureId],
        );
        if (remaining.rows[0]?.current_photo_id) {
          await client.query(
            `UPDATE user_species SET cover_photo_id = $1, card_crop_x = NULL, card_crop_y = NULL, card_crop_size = NULL
             WHERE user_id = $2 AND species_id = $3`,
            [remaining.rows[0].current_photo_id, userId, capture.species_id],
          );
        } else {
          await client.query(`DELETE FROM user_species WHERE user_id = $1 AND species_id = $2`, [
            userId,
            capture.species_id,
          ]);
        }
      }

      // captures_all again — DELETE FROM the view would apply its own deleted_at IS NULL
      // filter and silently delete zero rows, since this capture is (by design) trashed.
      await client.query(`DELETE FROM captures_all WHERE id = $1`, [captureId]);

      // Deleting a capture can remove the current best-rated photo for this species —
      // recompute rather than leave a stale max (see PATCH /captures/:id/rating).
      await client.query(
        `UPDATE user_species SET best_quality = (
           SELECT MAX(quality_rating) FROM captures WHERE user_id = $1 AND species_id = $2
         ) WHERE user_id = $1 AND species_id = $2`,
        [userId, capture.species_id],
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // Derivatives are always Lifer's own generated files — safe to delete unconditionally.
    for (const p of photosRes.rows) {
      if (existsSync(p.display_path)) unlinkSync(p.display_path);
      if (existsSync(p.thumb_path)) unlinkSync(p.thumb_path);
    }
    for (const ref of rawFilesToDelete) {
      if (existsSync(ref)) unlinkSync(ref);
    }

    return {};
  }

  app.delete<{ Params: { id: string }; Querystring: { deleteRaw?: string } }>(
    "/captures/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const result = await trashCapture(request.user!.id, request.params.id, request.query.deleteRaw === "1");
      if (result.notFound) return reply.code(404).send({ error: "Capture not found" });
      return { ok: true };
    },
  );

  // Multi-select delete (see SpeciesDetailPage.tsx's photo-grid select mode). `deleteRaw`
  // applies to every capture in the batch — the frontend only offers the checkbox at all when
  // at least one selected photo actually has a managed RAW to delete (see
  // GET /species/:id's has_raw_original), and applying it uniformly to the whole batch is
  // simpler than asking per-photo when most batches are either "all RAWs" or "no RAWs."
  app.post<{ Body: { captureIds?: string[]; deleteRaw?: boolean } }>(
    "/captures/batch-delete",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { captureIds, deleteRaw } = request.body ?? {};
      if (!captureIds || captureIds.length === 0) {
        return reply.code(400).send({ error: "captureIds is required" });
      }
      const userId = request.user!.id;
      let deleted = 0;
      let notFound = 0;
      for (const captureId of captureIds) {
        const result = await trashCapture(userId, captureId, !!deleteRaw);
        if (result.notFound) notFound++;
        else deleted++;
      }
      return { deleted, notFound };
    },
  );

  // Trashed Photos (Settings): everything currently in the trash for this user, newest-trashed
  // first, with enough to show "N days left" and a thumbnail. Deliberately reads captures_all
  // directly (the `captures` view would never show a trashed row at all).
  const TRASH_RETENTION_DAYS = 7;
  app.get("/trash", { preHandler: requireAuth }, async (request) => {
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
    }>(
      `SELECT c.id, c.species_id, s.common_name, s.scientific_name, c.deleted_at, c.pending_delete_raw,
              c.current_photo_id AS photo_id, p.width, p.height,
              EXISTS (SELECT 1 FROM originals o WHERE o.capture_id = c.id AND o.kind = 'raw') AS has_raw_original
       FROM captures_all c
       JOIN species s ON s.id = c.species_id
       LEFT JOIN photos p ON p.id = c.current_photo_id
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
        purgesAt: new Date(new Date(r.deleted_at).getTime() + TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      })),
    };
  });

  app.post<{ Params: { id: string } }>("/trash/:id/restore", { preHandler: requireAuth }, async (request, reply) => {
    const result = await restoreCapture(request.user!.id, request.params.id);
    if (result.notFound) return reply.code(404).send({ error: "Not in trash" });
    return { ok: true };
  });

  // Permanently removes everything currently in the trash right now, regardless of how long
  // it's been there — same underlying purgeCapture the scheduled 7-day job uses, just run
  // immediately and for the whole trash at once instead of waiting.
  app.post("/trash/empty", { preHandler: requireAuth }, async (request) => {
    const userId = request.user!.id;
    const res = await pool.query<{ id: string; pending_delete_raw: boolean }>(
      `SELECT id, pending_delete_raw FROM captures_all WHERE user_id = $1 AND deleted_at IS NOT NULL`,
      [userId],
    );
    let purged = 0;
    for (const row of res.rows) {
      const result = await purgeCapture(userId, row.id, row.pending_delete_raw);
      if (!result.notFound) purged++;
    }
    return { purged };
  });

  // Species auto-suggest (see ~/.claude/plans/vast-prancing-turing.md, Phases 1-2): ranks
  // candidate species for a not-yet-assigned photo by embedding similarity, for the picker to
  // show as one-click suggestions. Never auto-assigns — this only ever returns a ranked list,
  // the same species picker flow decides what to do with it.
  app.post("/captures/suggest-species", { preHandler: requireAuth }, async (request, reply) => {
    // Experimental, and off is a real, supported choice (see Settings) — check this before
    // doing any of the actual (CPU-costly) work below, not just as a UI-side gate the frontend
    // could be bypassed to skip.
    const settingRes = await pool.query<{ species_suggest_enabled: boolean }>(`SELECT species_suggest_enabled FROM users WHERE id = $1`, [
      request.user!.id,
    ]);
    if (settingRes.rows[0]?.species_suggest_enabled === false) return { suggestions: [] };

    let fileBuffer: Buffer | null = null;
    let regionId: string | null = null;
    for await (const part of request.parts()) {
      if (part.type === "file" && part.fieldname === "file") {
        fileBuffer = await part.toBuffer();
      } else if (part.type !== "file" && part.fieldname === "regionId") {
        regionId = String(part.value) || null;
      }
    }
    if (!fileBuffer) return reply.code(400).send({ error: "No file uploaded" });

    try {
      const suggestions = await suggestSpecies(pool, request.user!.id, fileBuffer, regionId);
      return { suggestions };
    } catch (err) {
      // Most likely cause: the one-time model download hasn't completed yet (no network, or
      // still in flight). Suggestions are a nice-to-have, never a hard requirement to assign a
      // species — surface an empty list rather than a scary error the picker has to handle.
      request.log.warn({ err }, "Species suggestion failed");
      return { suggestions: [] };
    }
  });

  // Sweeps every user's trash for anything past its retention window, purging it for good.
  // Runs once at startup (so a capture trashed just before the app was last closed doesn't
  // wait a full extra day-cycle to be checked) and then daily — trash purging has no
  // real-time urgency, so there's no reason to poll more often than that.
  async function sweepExpiredTrash(): Promise<void> {
    const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const res = await pool.query<{ id: string; user_id: string; pending_delete_raw: boolean }>(
      `SELECT id, user_id, pending_delete_raw FROM captures_all WHERE deleted_at IS NOT NULL AND deleted_at < $1`,
      [cutoff],
    );
    for (const row of res.rows) {
      await purgeCapture(row.user_id, row.id, row.pending_delete_raw).catch((err) =>
        app.log.error({ err, captureId: row.id }, "Failed to purge an expired trashed capture"),
      );
    }
    if (res.rows.length > 0) app.log.info(`[trash] purged ${res.rows.length} expired capture(s)`);
  }
  const TRASH_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
  sweepExpiredTrash().catch((err) => app.log.warn({ err }, "Initial trash sweep failed"));
  setInterval(() => sweepExpiredTrash().catch((err) => app.log.warn({ err }, "Trash sweep failed")), TRASH_SWEEP_INTERVAL_MS);
}
