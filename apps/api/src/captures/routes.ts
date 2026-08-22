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

  app.delete<{ Params: { id: string } }>("/captures/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id: captureId } = request.params;
    const userId = request.user!.id;

    const captureRes = await pool.query<{ species_id: string; current_photo_id: string | null }>(
      `SELECT species_id, current_photo_id FROM captures WHERE id = $1 AND user_id = $2`,
      [captureId, userId],
    );
    const capture = captureRes.rows[0];
    if (!capture) return reply.code(404).send({ error: "Capture not found" });

    const photosRes = await pool.query<{ id: string; display_path: string; thumb_path: string }>(
      `SELECT id, display_path, thumb_path FROM photos WHERE capture_id = $1`,
      [captureId],
    );

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

      await client.query(`DELETE FROM captures WHERE id = $1`, [captureId]);

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

    return { ok: true };
  });
}
