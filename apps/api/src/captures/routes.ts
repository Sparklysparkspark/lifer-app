// "Remove from Lifer" — deletes Lifer's own records and derivative files (display/thumb
// WebPs, which Lifer always generated and always owns) but deliberately never touches the
// original file on disk, even in "store" mode where Lifer wrote it. A UI action to tidy up
// your collection shouldn't be able to destroy your only copy of a photo as a side effect —
// if you want the stored copy gone too, that's a separate, explicit action to add later, not
// a default. (Known tradeoff: a removed "store"-mode original is now an orphaned file with no
// DB reference back to it — acceptable for a personal deployment, worth revisiting if this
// ever needs a "reclaim disk space" story.)
import { existsSync, unlinkSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireAuth } from "../auth/session.js";
import { writeSpeciesMetadata } from "../uploads/exif.js";
import { syncCaptureXmpSidecars } from "../uploads/xmpSidecarSync.js";
import { computeEmbedding, rankSpeciesByEmbeddings } from "../species/embeddings.js";
import { suggestSpecies } from "../species/embeddings.js";
import { probeVideo, extractVideoFrame } from "../uploads/image.js";
import { APP_DATA_DIR } from "../config.js";
import { moveManagedOriginalToSpeciesFolder } from "../uploads/routes.js";

interface SpeciesRow {
  id: string;
  common_name: string | null;
  scientific_name: string;
  taxon_class: string | null;
  family: string | null;
  aba_code: string | null;
  ebird_code: string | null;
}

/** Re-embeds the full, current species list (primary + every tagged secondary) into a
 *  capture's managed JPEG original, if it has one — a linked/external file is never
 *  touched, same rule as the upload flow. Best-effort: a photo with no managed JPEG (RAW-
 *  only, or link/s3 mode) just skips this, nothing to write metadata into. */
export async function resyncSpeciesMetadata(userId: string, captureId: string): Promise<void> {
  const originalRes = await pool.query<{ ref: string }>(
    `SELECT ref FROM originals WHERE capture_id = $1 AND kind = 'jpeg' AND managed = true`,
    [captureId],
  );
  const original = originalRes.rows[0];
  if (!original) return;

  const speciesRes = await pool.query<SpeciesRow>(
    `SELECT s.id, s.common_name, s.scientific_name, s.taxon_class, s.family, s.aba_code, s.ebird_code
     FROM species s WHERE s.id = (SELECT species_id FROM captures WHERE id = $1)
     UNION ALL
     SELECT s.id, s.common_name, s.scientific_name, s.taxon_class, s.family, s.aba_code, s.ebird_code
     FROM species s JOIN capture_species cs ON cs.species_id = s.id WHERE cs.capture_id = $1`,
    [captureId],
  );
  const namingStyleRes = await pool.query<{ species_naming_styles: string[] }>(
    `SELECT species_naming_styles FROM users WHERE id = $1`,
    [userId],
  );

  await writeSpeciesMetadata(
    original.ref,
    speciesRes.rows.map((s) => ({
      commonName: s.common_name,
      scientificName: s.scientific_name,
      taxonClass: s.taxon_class,
      family: s.family,
      abaCode: s.aba_code,
      ebirdCode: s.ebird_code,
    })),
    namingStyleRes.rows[0]?.species_naming_styles ?? [],
  );
}

/** Cleans up a species' user_species row once nothing evidences it any more — the same
 *  "no state, no target, no reason for a row" invariant DELETE /species/:id/target already
 *  enforces (species/routes.ts), applied here for the two capture-side actions that can also
 *  empty a species out from under it: correcting a misidentified capture's ID away from it
 *  (PATCH /captures/:id/reassign), and permanently deleting its last capture (purgeCapture).
 *  `vacatedPhotoId` is the photo that just stopped counting as evidence — only relevant for
 *  deciding whether a still-remaining `cover_photo_id` needs repointing, not whether the row
 *  survives at all. */
async function cleanupStaleUserSpecies(userId: string, speciesId: string, vacatedPhotoId: string | null): Promise<void> {
  const userSpeciesRes = await pool.query<{ cover_photo_id: string | null; is_target: boolean }>(
    `SELECT cover_photo_id, is_target FROM user_species WHERE user_id = $1 AND species_id = $2`,
    [userId, speciesId],
  );
  const row = userSpeciesRes.rows[0];
  if (!row) return;

  // Primary captures AND secondary (capture_species) tags both count as real evidence for a
  // species — either can be what a 'collected' state and cover photo are resting on.
  const remainingRes = await pool.query<{ current_photo_id: string | null }>(
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
    // Nothing left to justify 'collected' (that state specifically means "I have a photo").
    // is_target is independent of state/photos (species/routes.ts's own comment on it), so a
    // target species keeps its row — just stripped of the now-meaningless state/cover/crop —
    // rather than losing the target flag as a side effect of an unrelated ID correction.
    if (row.is_target) {
      await pool.query(
        `UPDATE user_species SET state = NULL, cover_photo_id = NULL, card_crop_x = NULL, card_crop_y = NULL,
           card_crop_size = NULL, best_quality = NULL WHERE user_id = $1 AND species_id = $2`,
        [userId, speciesId],
      );
    } else {
      await pool.query(`DELETE FROM user_species WHERE user_id = $1 AND species_id = $2`, [userId, speciesId]);
    }
    return;
  }

  // Evidence remains, but the cover photo specifically may have been the one that just left —
  // repoint it at the next-most-recent remaining photo (crop settings don't carry over, since
  // they were framed for the old cover photo specifically).
  if (vacatedPhotoId && row.cover_photo_id === vacatedPhotoId) {
    await pool.query(
      `UPDATE user_species SET cover_photo_id = $1, card_crop_x = NULL, card_crop_y = NULL, card_crop_size = NULL
       WHERE user_id = $2 AND species_id = $3`,
      [newestRemaining.current_photo_id, userId, speciesId],
    );
  }
  // Losing a capture can also remove the current best-rated photo for this species — recompute
  // rather than leave a stale max (same reasoning as PATCH /captures/:id/rating).
  await pool.query(
    `UPDATE user_species SET best_quality = (
       SELECT MAX(quality_rating) FROM captures WHERE user_id = $1 AND species_id = $2
     ) WHERE user_id = $1 AND species_id = $2`,
    [userId, speciesId],
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

      await resyncSpeciesMetadata(userId, captureId);
      await syncCaptureXmpSidecars(userId, captureId).catch(() => {});
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
      await resyncSpeciesMetadata(userId, captureId);
      await syncCaptureXmpSidecars(userId, captureId).catch(() => {});
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
          userId,
          newSpecies.id,
          original.kind,
          organizeByYear,
          newSpecies.taxon_class,
          takenAt,
        );
        if (newRef !== original.ref) {
          await pool.query(`UPDATE originals SET ref = $1 WHERE id = $2`, [newRef, original.id]);
        }
      }

      const oldSpeciesId = capture.species_id;
      await pool.query(`UPDATE captures SET species_id = $1 WHERE id = $2`, [speciesId, captureId]);
      await pool.query(
        `INSERT INTO user_species (user_id, species_id, state, cover_photo_id, first_collected)
         VALUES ($1, $2, 'collected', $3, COALESCE($4::date, CURRENT_DATE))
         ON CONFLICT (user_id, species_id) DO UPDATE SET
           state = 'collected',
           cover_photo_id = COALESCE(user_species.cover_photo_id, EXCLUDED.cover_photo_id)`,
        [userId, speciesId, capture.current_photo_id, capture.taken_at],
      );
      // The old species may have had ONLY this capture backing it — without this, correcting
      // a misidentified photo left the wrong species sitting in your collection forever as
      // "collected," with a cover photo that (confusingly) now shows the corrected species.
      await cleanupStaleUserSpecies(userId, oldSpeciesId, capture.current_photo_id);

      await resyncSpeciesMetadata(userId, captureId);
      await syncCaptureXmpSidecars(userId, captureId).catch(() => {});
      return { ok: true };
    },
  );

  // Backfilling a missing taken_at — reachable from the Stats page's Archive health "Missing
  // date" drill-down (GET /gallery?missingDate=1), so a photo that never had EXIF date data (a
  // scan, a screenshot, a corrupted file) can get a real date instead of sitting unfixable.
  app.patch<{ Params: { id: string }; Body: { takenAt: string | null } }>(
    "/captures/:id/taken-at",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id: captureId } = request.params;
      const { takenAt } = request.body ?? {};
      const userId = request.user!.id;

      if (takenAt !== null && Number.isNaN(new Date(takenAt).getTime())) {
        return reply.code(400).send({ error: "takenAt must be a valid date, or null to clear" });
      }

      const res = await pool.query(`UPDATE captures SET taken_at = $1 WHERE id = $2 AND user_id = $3 RETURNING id`, [
        takenAt,
        captureId,
        userId,
      ]);
      if (res.rows.length === 0) return reply.code(404).send({ error: "Capture not found" });

      return { ok: true };
    },
  );

  /** Corrects a capture's location after the fact — region_id (a catalog country/province) and
   * locationLabel (a free-text custom name — "Prince George", "my backyard" — nested under
   * that region) were previously only ever set at import time (see uploads/routes.ts), with no
   * way back in if either was wrong or skipped. Each field is independently optional in the
   * body — sending only one leaves the other untouched. */
  app.patch<{ Params: { id: string }; Body: { regionId?: string | null; locationLabel?: string | null } }>(
    "/captures/:id/region",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id: captureId } = request.params;
      const { regionId, locationLabel } = request.body ?? {};
      const userId = request.user!.id;

      const res = await pool.query(
        `UPDATE captures SET
           region_id = CASE WHEN $4::boolean THEN $1 ELSE region_id END,
           location_label = CASE WHEN $5::boolean THEN $2 ELSE location_label END
         WHERE id = $3 AND user_id = $6
         RETURNING id`,
        [regionId ?? null, locationLabel?.trim() || null, captureId, regionId !== undefined, locationLabel !== undefined, userId],
      );
      if (res.rows.length === 0) return reply.code(404).send({ error: "Capture not found" });

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

      await syncCaptureXmpSidecars(userId, captureId).catch(() => {});
      return { ok: true };
    },
  );

  // Free-text custom tags (e.g. "flight shot", "courtship display") — replaces the whole array
  // per call, matching how the frontend tag editor always submits the full current list rather
  // than a single add/remove delta.
  app.patch<{ Params: { id: string }; Body: { tags: string[] } }>(
    "/captures/:id/tags",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id: captureId } = request.params;
      const userId = request.user!.id;
      const rawTags = request.body?.tags;
      if (!Array.isArray(rawTags) || rawTags.some((t) => typeof t !== "string")) {
        return reply.code(400).send({ error: "tags must be an array of strings" });
      }
      const tags = [...new Set(rawTags.map((t) => t.trim()).filter(Boolean))];

      const res = await pool.query<{ tags: string[] }>(
        `UPDATE captures SET tags = $1 WHERE id = $2 AND user_id = $3 RETURNING tags`,
        [tags, captureId, userId],
      );
      const capture = res.rows[0];
      if (!capture) return reply.code(404).send({ error: "Capture not found" });

      await syncCaptureXmpSidecars(userId, captureId).catch(() => {});
      return { tags: capture.tags };
    },
  );

  // Every distinct tag this user has ever used, for the tag editor's autocomplete — lets "flight
  // shot" typed once on one photo get suggested (and reused verbatim, not near-duplicated as
  // "Flight shot") on the next.
  app.get("/captures/tags", { preHandler: requireAuth }, async (request) => {
    const res = await pool.query<{ tag: string }>(
      `SELECT DISTINCT unnest(tags) AS tag FROM captures WHERE user_id = $1 ORDER BY tag`,
      [request.user!.id],
    );
    return { tags: res.rows.map((r) => r.tag) };
  });

  // Bulk tagging — adds the given tags to every listed capture WITHOUT touching any tag a
  // capture already has (a plain overwrite, like the single-capture PATCH above, would wipe out
  // whatever different tags each selected photo already carried; a batch action has no way to
  // know what those were per-photo, so it can only ever safely add, never replace).
  app.patch<{ Body: { captureIds: string[]; tags: string[] } }>(
    "/captures/tags",
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = request.user!.id;
      const { captureIds, tags: rawTags } = request.body ?? {};
      if (!Array.isArray(captureIds) || captureIds.length === 0) {
        return reply.code(400).send({ error: "captureIds is required" });
      }
      if (!Array.isArray(rawTags) || rawTags.some((t) => typeof t !== "string")) {
        return reply.code(400).send({ error: "tags must be an array of strings" });
      }
      const tags = [...new Set(rawTags.map((t) => t.trim()).filter(Boolean))];
      if (tags.length === 0) return { ok: true };

      const res = await pool.query(
        `UPDATE captures SET tags = (
           SELECT array_agg(DISTINCT t ORDER BY t) FROM unnest(tags || $1::text[]) AS t
         ) WHERE id = ANY($2) AND user_id = $3`,
        [tags, captureIds, userId],
      );
      for (const captureId of captureIds) {
        await syncCaptureXmpSidecars(userId, captureId).catch(() => {});
      }
      return { ok: true, updated: res.rowCount ?? 0 };
    },
  );

  // Every distinct tag plus how many photos carry it — the management page's own data source
  // (GET /captures/tags above is the lighter-weight autocomplete version, no counts needed
  // there). Sorted by count descending so the tags actually worth keeping surface first, with
  // one-off typos naturally sinking to the bottom.
  app.get("/captures/tags/manage", { preHandler: requireAuth }, async (request) => {
    const res = await pool.query<{ tag: string; count: string }>(
      `SELECT unnest(tags) AS tag, count(*) AS count FROM captures WHERE user_id = $1 GROUP BY tag ORDER BY count DESC, tag ASC`,
      [request.user!.id],
    );
    return { tags: res.rows.map((r) => ({ tag: r.tag, count: Number(r.count) })) };
  });

  // Renames a tag everywhere it's used in one shot — the fix for a typo ("flght shot") or
  // standardizing casing ("Flight Shot" -> "flight shot") without having to open every photo
  // that has it individually. array_replace swaps every occurrence in each capture's own tags
  // array; the DISTINCT re-aggregate afterward merges into the target tag rather than leaving a
  // duplicate if a capture already happened to have both (e.g. renaming "flght shot" to "flight
  // shot" on a photo that was already correctly tagged "flight shot" too).
  app.patch<{ Body: { from: string; to: string } }>("/captures/tags/rename", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.user!.id;
    const from = request.body?.from?.trim();
    const to = request.body?.to?.trim();
    if (!from || !to) return reply.code(400).send({ error: "from and to are both required" });
    if (from === to) return { ok: true, updated: 0 };

    const res = await pool.query(
      `UPDATE captures SET tags = (
         SELECT array_agg(DISTINCT t ORDER BY t) FROM unnest(array_replace(tags, $1, $2)) AS t
       ) WHERE user_id = $3 AND $1 = ANY(tags)`,
      [from, to, userId],
    );
    return { ok: true, updated: res.rowCount ?? 0 };
  });

  // Deletes a tag everywhere it's used — for a genuine dud (a test tag, one that no longer
  // means anything) rather than a typo that should become some other tag (see rename above).
  app.delete<{ Body: { tag: string } }>("/captures/tags", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.user!.id;
    const tag = request.body?.tag?.trim();
    if (!tag) return reply.code(400).send({ error: "tag is required" });

    const res = await pool.query(
      `UPDATE captures SET tags = array_remove(tags, $1) WHERE user_id = $2 AND $1 = ANY(tags)`,
      [tag, userId],
    );
    return { ok: true, updated: res.rowCount ?? 0 };
  });

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
      const coverRes = await client.query<{ cover_photo_id: string | null; is_target: boolean }>(
        `SELECT cover_photo_id, is_target FROM user_species WHERE user_id = $1 AND species_id = $2`,
        [userId, capture.species_id],
      );
      if (coverRes.rows[0] && photosRes.rows.some((p) => p.id === coverRes.rows[0].cover_photo_id)) {
        // A secondary (capture_species) tag on some OTHER capture is real evidence for this
        // species too, same as a primary capture — checked alongside primary captures rather
        // than just the latter, so deleting the species' only PRIMARY capture doesn't wipe its
        // 'collected' state out from under a still-valid secondary tag elsewhere.
        const remaining = await client.query<{ current_photo_id: string | null }>(
          `SELECT current_photo_id, taken_at FROM captures WHERE user_id = $1 AND species_id = $2 AND id != $3
           UNION ALL
           SELECT c.current_photo_id, c.taken_at FROM capture_species cs
             JOIN captures c ON c.id = cs.capture_id
             WHERE cs.species_id = $2 AND c.user_id = $1 AND c.id != $3
           ORDER BY taken_at DESC NULLS LAST LIMIT 1`,
          [userId, capture.species_id, captureId],
        );
        if (remaining.rows[0]?.current_photo_id) {
          await client.query(
            `UPDATE user_species SET cover_photo_id = $1, card_crop_x = NULL, card_crop_y = NULL, card_crop_size = NULL
             WHERE user_id = $2 AND species_id = $3`,
            [remaining.rows[0].current_photo_id, userId, capture.species_id],
          );
        } else if (coverRes.rows[0].is_target) {
          // is_target is independent of state/photos (species/routes.ts's own comment on it) —
          // losing the species' last photo shouldn't silently drop an unrelated target flag, so
          // only the now-meaningless state/cover/crop is cleared, mirroring the downgrade-not-
          // delete rule DELETE /species/:id/target already enforces for the same invariant.
          await client.query(
            `UPDATE user_species SET state = NULL, cover_photo_id = NULL, card_crop_x = NULL, card_crop_y = NULL,
               card_crop_size = NULL, best_quality = NULL WHERE user_id = $1 AND species_id = $2`,
            [userId, capture.species_id],
          );
        } else {
          await client.query(`DELETE FROM user_species WHERE user_id = $1 AND species_id = $2`, [
            userId,
            capture.species_id,
          ]);
        }
      }

      // Same "fix the FK before deleting the row it points at" story as user_species above —
      // albums.cover_photo_id (migration 071) has no ON DELETE clause at all, so purging a
      // capture that happens to be one of the user's album covers would otherwise fail this
      // whole transaction outright with a foreign-key violation, not just leave stale data.
      // Repoint at that album's next-most-recent remaining capture, or clear it if none are left
      // — same fallback shape ADD (album_captures) already uses to auto-pick a cover.
      if (photosRes.rows.length > 0) {
        const affectedAlbums = await client.query<{ id: string }>(
          `SELECT id FROM albums WHERE user_id = $1 AND cover_photo_id = ANY($2)`,
          [userId, photosRes.rows.map((p) => p.id)],
        );
        for (const album of affectedAlbums.rows) {
          await client.query(
            `UPDATE albums SET cover_photo_id = (
               SELECT c.current_photo_id FROM album_captures ac
                 JOIN captures c ON c.id = ac.capture_id
                 WHERE ac.album_id = $1 AND ac.capture_id != $2 AND c.current_photo_id IS NOT NULL
                 ORDER BY c.taken_at DESC NULLS LAST LIMIT 1
             ), cover_crop_x = NULL, cover_crop_y = NULL, cover_crop_size = NULL
             WHERE id = $1`,
            [album.id, captureId],
          );
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
       -- Same jpeg-preferred tiebreak every other capture query here uses (SpeciesDetailPage's
       -- own, GALLERY_ITEM_JOINS) — picks one original per capture instead of duplicating the
       -- row when both a jpeg and a raw sibling exist.
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

  // Same idea as /captures/suggest-species, for a video clip instead of a single photo — a
  // still photo already IS the one moment someone chose to capture, but a clip is footage: the
  // subject might only be clearly on-screen for part of it, mid-motion-blur in some frames,
  // or out of frame entirely in others. Sampling several frames spread across the clip (with a
  // little randomness within each spread-out slot, not the exact same fixed instant every
  // time) and letting the BEST-matching one decide (see rankSpeciesByEmbeddings) covers that —
  // a single frame grabbed at a fixed point (e.g. always exactly halfway) risks landing on
  // exactly the one moment nothing is visible.
  app.post("/captures/suggest-species-from-video", { preHandler: requireAuth }, async (request, reply) => {
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

    // ffprobe/ffmpeg need a real file path, not a buffer — a scratch tmp file, same pattern
    // /uploads/video already uses, cleaned up in `finally` below regardless of outcome.
    const tmpDir = path.join(APP_DATA_DIR, "tmp");
    mkdirSync(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `${randomUUID()}.suggest`);
    writeFileSync(tmpPath, fileBuffer);

    try {
      const { durationSeconds } = await probeVideo(tmpPath);
      const duration = durationSeconds && durationSeconds > 0.5 ? durationSeconds : 1;
      // Up to 5 frames, spread across evenly-sized time buckets covering the WHOLE clip — a
      // random point within each bucket (not each bucket's exact midpoint) so two imports of
      // the same clip don't sample identically, while still guaranteeing the frames are spread
      // apart rather than clustered. A short clip (under ~2s) gets fewer, since 5 buckets across
      // 1 second would sample points barely a fifth of a second apart — not meaningfully
      // different frames.
      const frameCount = Math.max(1, Math.min(5, Math.floor(duration / 0.4)));
      const bucketSeconds = duration / frameCount;
      const timestamps = Array.from({ length: frameCount }, (_, i) => {
        const bucketStart = i * bucketSeconds;
        return bucketStart + Math.random() * bucketSeconds;
      });

      const embeddings: number[][] = [];
      for (const t of timestamps) {
        try {
          const frame = await extractVideoFrame(tmpPath, t);
          embeddings.push(await computeEmbedding(frame));
        } catch {
          // One unreadable timestamp (e.g. right at a keyframe boundary ffmpeg can't seek to
          // cleanly) shouldn't sink the whole suggestion — the other sampled frames still stand.
        }
      }
      if (embeddings.length === 0) return { suggestions: [] };

      const suggestions = await rankSpeciesByEmbeddings(pool, request.user!.id, embeddings, regionId);
      return { suggestions };
    } catch (err) {
      request.log.warn({ err }, "Video species suggestion failed");
      return { suggestions: [] };
    } finally {
      rmSync(tmpPath, { force: true });
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
