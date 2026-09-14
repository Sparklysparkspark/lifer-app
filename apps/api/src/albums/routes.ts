// Manually-curated, named collections of captures — same shape as Trips (a name plus an
// ordered set of captures) but user-curated instead of auto-populated by folder-scan
// fingerprint matching. Reuses gallery/routes.ts's own GalleryItem shape for album contents so
// the frontend can render an album's photos with the exact same PhotoTile/MasonryGrid code the
// Gallery page already uses.
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireScope } from "../auth/session.js";
import { GALLERY_ITEM_COLUMNS, GALLERY_ITEM_JOINS, toGalleryItem } from "../gallery/routes.js";
import { nextDefaultName } from "../lib/defaultName.js";
import { syncAlbumIndexForCaptures } from "./albumIndex.js";
import { toCollectionItem } from "../collection/collectionItem.js";
import { resolveQuadSlots } from "../lib/quadCover.js";

interface CreateAlbumBody {
  name?: string;
  description?: string | null;
}

interface UpdateAlbumBody {
  name?: string;
  description?: string | null;
  coverPhotoId?: string | null;
  coverLayout?: "single" | "quad";
}

interface AddCapturesBody {
  captureIds?: string[];
}

async function assertOwnedAlbum(albumId: string, userId: string): Promise<boolean> {
  const res = await pool.query(`SELECT 1 FROM albums WHERE id = $1 AND user_id = $2`, [albumId, userId]);
  return res.rows.length > 0;
}

export async function albumRoutes(app: FastifyInstance): Promise<void> {
  app.get("/albums", { preHandler: requireScope("album.read") }, async (request) => {
    const res = await pool.query(
      `SELECT a.id, a.name, a.description, a.cover_layout, a.cover_crop_x, a.cover_crop_y, a.cover_crop_size, a.created_at,
              a.quad_photo_ids, a.quad_crops,
              (SELECT count(*) FROM album_captures ac WHERE ac.album_id = a.id) AS capture_count,
              -- cover_p resolves NULL when cover_photo_id's own capture has been trashed (see
              -- the /albums/:id route's own comment on this trap) — falls back to the album's
              -- own most-recently-added photo via "fallback", same default an unset cover uses.
              cover_p.id AS resolved_cover_photo_id,
              (cover_p.id IS NOT NULL) AS cover_is_manual_pick,
              fallback.photo_id AS fallback_cover_photo_id,
              -- EVERY non-trashed photo in the album, not just a handful — this doubles as both
              -- the fallback-fill pool AND the validity check for a manually-picked slot (a
              -- picked photo not from the "most recent" end still needs to pass as valid, or a
              -- deliberately-chosen older photo would get silently discarded as if trashed).
              (
                SELECT array_agg(sub.photo_id) FROM (
                  SELECT c.current_photo_id AS photo_id
                  FROM album_captures ac2
                  JOIN captures c ON c.id = ac2.capture_id
                  WHERE ac2.album_id = a.id AND c.current_photo_id IS NOT NULL
                  ORDER BY ac2.added_at DESC
                ) sub
              ) AS quad_candidate_photo_ids
       FROM albums a
       LEFT JOIN LATERAL (
         SELECT p.id FROM photos p JOIN captures c ON c.id = p.capture_id WHERE p.id = a.cover_photo_id
       ) cover_p ON true
       LEFT JOIN LATERAL (
         SELECT c.current_photo_id AS photo_id
         FROM album_captures ac2 JOIN captures c ON c.id = ac2.capture_id
         WHERE ac2.album_id = a.id AND c.current_photo_id IS NOT NULL
         ORDER BY ac2.added_at DESC LIMIT 1
       ) fallback ON true
       WHERE a.user_id = $1
       ORDER BY a.created_at DESC`,
      [request.user!.id],
    );
    return {
      albums: res.rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        coverPhotoId: r.resolved_cover_photo_id ?? r.fallback_cover_photo_id ?? null,
        coverLayout: r.cover_layout,
        // The crop was framed for the specific photo manually picked — wrong (not just stale)
        // once that photo's trashed and we fell back to a different one.
        coverCropX: !r.cover_is_manual_pick || r.cover_crop_x == null ? null : Number(r.cover_crop_x),
        coverCropY: !r.cover_is_manual_pick || r.cover_crop_y == null ? null : Number(r.cover_crop_y),
        coverCropSize: !r.cover_is_manual_pick || r.cover_crop_size == null ? null : Number(r.cover_crop_size),
        quadSlots: resolveQuadSlots(r.quad_photo_ids, r.quad_crops, r.quad_candidate_photo_ids ?? []),
        createdAt: r.created_at,
        captureCount: Number(r.capture_count),
      })),
    };
  });

  app.post<{ Body: CreateAlbumBody }>("/albums", { preHandler: requireScope("album.write") }, async (request, reply) => {
    const userId = request.user!.id;
    let name = request.body?.name?.trim();
    if (!name) {
      const countRes = await pool.query(
        `SELECT count(*) FROM albums WHERE user_id = $1 AND name ~ '^Untitled Album( [A-Za-z-]+)?$'`,
        [userId],
      );
      name = nextDefaultName("Album", Number(countRes.rows[0].count));
    }

    const res = await pool.query(
      `INSERT INTO albums (user_id, name, description) VALUES ($1, $2, $3) RETURNING id, name, description, cover_photo_id, created_at`,
      [userId, name, request.body?.description?.trim() || null],
    );
    const r = res.rows[0];
    return { id: r.id, name: r.name, description: r.description, coverPhotoId: r.cover_photo_id, createdAt: r.created_at, captureCount: 0 };
  });

  app.get<{ Params: { id: string } }>("/albums/:id", { preHandler: requireScope("album.read") }, async (request, reply) => {
    const userId = request.user!.id;
    const albumRes = await pool.query(
      // resolved_cover_photo_id is NULL when cover_photo_id's own capture has been trashed
      // (captures excludes trashed rows, captures_all wouldn't) — a soft delete doesn't clear
      // cover_photo_id itself, so without this check the cover would keep rendering a photo
      // that's invisible everywhere else in the app for the whole trash retention window.
      `SELECT a.id, a.name, a.description, a.cover_layout, a.cover_crop_x, a.cover_crop_y, a.cover_crop_size, a.created_at,
              a.quad_photo_ids, a.quad_crops,
              cover_p.id AS resolved_cover_photo_id,
              (
                SELECT array_agg(sub.photo_id) FROM (
                  SELECT c.current_photo_id AS photo_id
                  FROM album_captures ac2 JOIN captures c ON c.id = ac2.capture_id
                  WHERE ac2.album_id = a.id AND c.current_photo_id IS NOT NULL
                  ORDER BY ac2.added_at DESC
                ) sub
              ) AS quad_candidate_photo_ids
       FROM albums a
       LEFT JOIN LATERAL (
         SELECT p.id FROM photos p JOIN captures c ON c.id = p.capture_id WHERE p.id = a.cover_photo_id
       ) cover_p ON true
       WHERE a.id = $1 AND a.user_id = $2`,
      [request.params.id, userId],
    );
    const album = albumRes.rows[0];
    if (!album) return reply.code(404).send({ error: "Album not found" });

    // Scoped through captures (the trash-excluding view, not captures_all) so a soft-deleted
    // capture silently drops out of every album it was in, same as it already drops out of the
    // Gallery/species views — no separate cleanup needed when a photo is trashed.
    const itemsRes = await pool.query(
      `SELECT ${GALLERY_ITEM_COLUMNS}
       FROM album_captures ac
       JOIN captures c ON c.id = ac.capture_id
       ${GALLERY_ITEM_JOINS}
       WHERE ac.album_id = $1 AND c.user_id = $2
       ORDER BY ac.added_at DESC`,
      [album.id, userId],
    );

    return {
      id: album.id,
      name: album.name,
      description: album.description,
      // Falls back to whatever's actually first in the (already trash-filtered) item list
      // once the manual pick's own capture is gone — same "still show SOME cover, not a
      // broken one" fallback trips already had for its own cover.
      coverPhotoId: album.resolved_cover_photo_id ?? itemsRes.rows[0]?.photo_id ?? null,
      coverLayout: album.cover_layout,
      // The crop was framed for the SPECIFIC photo the user picked — if that one's gone and we
      // fell back to a different photo above, the old crop coordinates would frame the wrong
      // image entirely, not just look stale.
      coverCropX: album.resolved_cover_photo_id == null ? null : album.cover_crop_x == null ? null : Number(album.cover_crop_x),
      coverCropY: album.resolved_cover_photo_id == null ? null : album.cover_crop_y == null ? null : Number(album.cover_crop_y),
      coverCropSize: album.resolved_cover_photo_id == null ? null : album.cover_crop_size == null ? null : Number(album.cover_crop_size),
      quadSlots: resolveQuadSlots(album.quad_photo_ids, album.quad_crops, album.quad_candidate_photo_ids ?? []),
      createdAt: album.created_at,
      items: itemsRes.rows.map((row) => toGalleryItem(row, null)),
    };
  });

  app.patch<{ Params: { id: string }; Body: UpdateAlbumBody }>(
    "/albums/:id",
    { preHandler: requireScope("album.write") },
    async (request, reply) => {
      const userId = request.user!.id;
      if (!(await assertOwnedAlbum(request.params.id, userId))) {
        return reply.code(404).send({ error: "Album not found" });
      }
      const { name, description, coverPhotoId, coverLayout } = request.body ?? {};
      if (coverLayout !== undefined && coverLayout !== "single" && coverLayout !== "quad") {
        return reply.code(400).send({ error: "coverLayout must be 'single' or 'quad'" });
      }
      const res = await pool.query(
        `UPDATE albums SET
           name = COALESCE($3, name),
           description = CASE WHEN $4::boolean THEN $5 ELSE description END,
           cover_photo_id = CASE WHEN $6::boolean THEN $7 ELSE cover_photo_id END,
           cover_layout = COALESCE($8, cover_layout),
           -- A newly-picked cover photo was never framed for whatever crop was saved against
           -- the PREVIOUS cover, so it's cleared here too — same rule trips' own cover-pick
           -- endpoint already follows.
           cover_crop_x = CASE WHEN $6::boolean THEN NULL ELSE cover_crop_x END,
           cover_crop_y = CASE WHEN $6::boolean THEN NULL ELSE cover_crop_y END,
           cover_crop_size = CASE WHEN $6::boolean THEN NULL ELSE cover_crop_size END,
           updated_at = now()
         WHERE id = $1 AND user_id = $2
         RETURNING id, name, description, cover_photo_id, cover_layout, created_at`,
        [
          request.params.id,
          userId,
          name?.trim() || null,
          description !== undefined,
          description?.trim() || null,
          coverPhotoId !== undefined,
          coverPhotoId ?? null,
          coverLayout ?? null,
        ],
      );
      const r = res.rows[0];
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        coverPhotoId: r.cover_photo_id,
        coverLayout: r.cover_layout,
        createdAt: r.created_at,
      };
    },
  );

  app.delete<{ Params: { id: string } }>("/albums/:id", { preHandler: requireScope("album.write") }, async (request, reply) => {
    const res = await pool.query(`DELETE FROM albums WHERE id = $1 AND user_id = $2`, [request.params.id, request.user!.id]);
    if (res.rowCount === 0) return reply.code(404).send({ error: "Album not found" });
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: AddCapturesBody }>(
    "/albums/:id/captures",
    { preHandler: requireScope("album.write") },
    async (request, reply) => {
      const userId = request.user!.id;
      if (!(await assertOwnedAlbum(request.params.id, userId))) {
        return reply.code(404).send({ error: "Album not found" });
      }
      const captureIds = request.body?.captureIds ?? [];
      if (captureIds.length === 0) return reply.code(400).send({ error: "captureIds is required" });

      // Only captures this user actually owns can be added — same defense-in-depth as every
      // other per-user query here, just worth calling out since this is the one place a caller
      // supplies capture IDs directly rather than the server deriving them from a join.
      const inserted = await pool.query(
        `INSERT INTO album_captures (album_id, capture_id)
         SELECT $1, c.id FROM captures c WHERE c.id = ANY($2) AND c.user_id = $3
         ON CONFLICT DO NOTHING
         RETURNING capture_id`,
        [request.params.id, captureIds, userId],
      );

      // An album with no cover yet gets one automatically from whatever's just been added —
      // same "don't make the user do a separate step for the obvious default" reasoning as a
      // trip's own automatic cover. A manual pick (PATCH coverPhotoId) always overrides this.
      if (inserted.rows.length > 0) {
        await pool.query(
          `UPDATE albums a SET cover_photo_id = sub.photo_id
           FROM (
             SELECT c.current_photo_id AS photo_id FROM captures c
             WHERE c.id = ANY($2) AND c.current_photo_id IS NOT NULL
             ORDER BY c.created_at ASC
             LIMIT 1
           ) sub
           WHERE a.id = $1 AND a.cover_photo_id IS NULL`,
          [request.params.id, inserted.rows.map((r) => r.capture_id)],
        );
      }
      // Best-effort, fire-and-forget — see albumIndex.ts's own comment on why this never blocks
      // or fails the request over a recovery-manifest write.
      syncAlbumIndexForCaptures(inserted.rows.map((r) => r.capture_id)).catch(() => {});
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string; captureId: string } }>(
    "/albums/:id/captures/:captureId",
    { preHandler: requireScope("album.write") },
    async (request, reply) => {
      if (!(await assertOwnedAlbum(request.params.id, request.user!.id))) {
        return reply.code(404).send({ error: "Album not found" });
      }
      await pool.query(`DELETE FROM album_captures WHERE album_id = $1 AND capture_id = $2`, [
        request.params.id,
        request.params.captureId,
      ]);
      syncAlbumIndexForCaptures([request.params.captureId]).catch(() => {});
      return { ok: true };
    },
  );

  // Parity with /trips/:id/cover-crop (same CardCropEditor.tsx UI, same request shape) — an
  // album's cover only ever has a crop once a manual cover_photo_id is actually set, same
  // "nothing to frame yet" gate trips uses.
  app.patch<{ Params: { id: string }; Body: { x?: number; y?: number; size?: number; reset?: boolean } }>(
    "/albums/:id/cover-crop",
    { preHandler: requireScope("album.write") },
    async (request, reply) => {
      const userId = request.user!.id;
      const albumRes = await pool.query<{ cover_photo_id: string | null }>(
        `SELECT cover_photo_id FROM albums WHERE id = $1 AND user_id = $2`,
        [request.params.id, userId],
      );
      if (albumRes.rows.length === 0) return reply.code(404).send({ error: "Album not found" });
      if (!albumRes.rows[0].cover_photo_id) return reply.code(400).send({ error: "No cover photo set for this album yet" });

      const { x, y, size, reset } = request.body ?? {};
      if (reset) {
        await pool.query(`UPDATE albums SET cover_crop_x = NULL, cover_crop_y = NULL, cover_crop_size = NULL WHERE id = $1`, [
          request.params.id,
        ]);
        return { ok: true };
      }

      const valid =
        typeof x === "number" && x >= 0 && x <= 100 && typeof y === "number" && y >= 0 && y <= 100 && typeof size === "number" && size > 0 && size <= 100;
      if (!valid) return reply.code(400).send({ error: "x, y, size must each be within 0-100" });

      await pool.query(`UPDATE albums SET cover_crop_x = $1, cover_crop_y = $2, cover_crop_size = $3 WHERE id = $4`, [
        x,
        y,
        size,
        request.params.id,
      ]);
      return { ok: true };
    },
  );

  /** Assigns a specific photo (and/or crop) to one of the 4 quad-grid tiles — see
   * quadCover.ts's own comment for how a slot falls back to an auto-pick once its photo is
   * gone. photoId omitted (undefined) leaves that slot's photo as-is; passing null clears it
   * back to auto-pick. crop omitted leaves the crop as-is; null clears it. */
  app.patch<{
    Params: { id: string };
    Body: { slot: number; photoId?: string | null; crop?: { x: number; y: number; size: number } | null };
  }>("/albums/:id/quad-slot", { preHandler: requireScope("album.write") }, async (request, reply) => {
    const userId = request.user!.id;
    const { slot, photoId, crop } = request.body ?? {};
    if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 0 || slot > 3) {
      return reply.code(400).send({ error: "slot must be an integer 0-3" });
    }

    const albumRes = await pool.query<{ quad_photo_ids: (string | null)[] | null; quad_crops: unknown[] | null }>(
      `SELECT quad_photo_ids, quad_crops FROM albums WHERE id = $1 AND user_id = $2`,
      [request.params.id, userId],
    );
    if (albumRes.rows.length === 0) return reply.code(404).send({ error: "Album not found" });
    const current = albumRes.rows[0];

    const ids = [0, 1, 2, 3].map((i) => current.quad_photo_ids?.[i] ?? null);
    const crops = [0, 1, 2, 3].map((i) => current.quad_crops?.[i] ?? null);
    if (photoId !== undefined) {
      ids[slot] = photoId;
      crops[slot] = null; // a newly-assigned photo was never framed for whatever crop was saved
    }
    if (crop !== undefined) crops[slot] = crop;

    // All 4 slots cleared back to auto-pick — store NULL rather than an array of nulls, so a
    // brand new capture added later can still become part of the auto-picked default.
    const allEmpty = ids.every((id) => id == null);
    await pool.query(`UPDATE albums SET quad_photo_ids = $1, quad_crops = $2 WHERE id = $3`, [
      allEmpty ? null : ids,
      allEmpty ? null : JSON.stringify(crops),
      request.params.id,
    ]);
    return { ok: true };
  });

  // Parity with /trips/:id/species — same toCollectionItem shape, so the frontend's "Species
  // view" toggle can reuse the exact same SpeciesCard grid on Albums that Trips already has.
  app.get<{ Params: { id: string } }>("/albums/:id/species", { preHandler: requireScope("album.read") }, async (request, reply) => {
    const userId = request.user!.id;
    if (!(await assertOwnedAlbum(request.params.id, userId))) {
      return reply.code(404).send({ error: "Album not found" });
    }
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
       WHERE EXISTS (
         SELECT 1 FROM album_captures ac JOIN captures c ON c.id = ac.capture_id
         WHERE ac.album_id = $2 AND c.species_id = s.id
       )
       ORDER BY s.scientific_name`,
      [userId, request.params.id],
    );
    return { items: res.rows.map(toCollectionItem) };
  });
}
