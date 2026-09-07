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

interface CreateAlbumBody {
  name?: string;
  description?: string | null;
}

interface UpdateAlbumBody {
  name?: string;
  description?: string | null;
  coverPhotoId?: string | null;
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
      `SELECT a.id, a.name, a.description, a.cover_photo_id, a.created_at,
              (SELECT count(*) FROM album_captures ac WHERE ac.album_id = a.id) AS capture_count
       FROM albums a
       WHERE a.user_id = $1
       ORDER BY a.created_at DESC`,
      [request.user!.id],
    );
    return {
      albums: res.rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        coverPhotoId: r.cover_photo_id,
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
      `SELECT id, name, description, cover_photo_id, created_at FROM albums WHERE id = $1 AND user_id = $2`,
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
      coverPhotoId: album.cover_photo_id,
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
      const { name, description, coverPhotoId } = request.body ?? {};
      const res = await pool.query(
        `UPDATE albums SET
           name = COALESCE($3, name),
           description = CASE WHEN $4::boolean THEN $5 ELSE description END,
           cover_photo_id = CASE WHEN $6::boolean THEN $7 ELSE cover_photo_id END,
           updated_at = now()
         WHERE id = $1 AND user_id = $2
         RETURNING id, name, description, cover_photo_id, created_at`,
        [
          request.params.id,
          userId,
          name?.trim() || null,
          description !== undefined,
          description?.trim() || null,
          coverPhotoId !== undefined,
          coverPhotoId ?? null,
        ],
      );
      const r = res.rows[0];
      return { id: r.id, name: r.name, description: r.description, coverPhotoId: r.cover_photo_id, createdAt: r.created_at };
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
      return { ok: true };
    },
  );
}
