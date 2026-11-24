// Albums: named sets of captures, either hand-picked or (smart albums) matched live by saved
// Gallery rules. Contents use the gallery's item shape so the web reuses the gallery grid.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { log } from "@lifer/core/lib/log.js";
import { requireScope } from "../auth/session.js";
import { GALLERY_ITEM_COLUMNS, GALLERY_ITEM_FRAME_JOINS, toGalleryItem, type GalleryRow } from "../gallery/routes.js";
import {
  ALBUM_MEMBER_COLUMNS,
  SmartAlbumRulesInput,
  checkedRules,
  smartAlbumRows,
  storedRules,
  type AlbumMember,
  type SmartAlbumRules,
} from "./smartRules.js";
import { MAX_NAME_LENGTH, NAME_TOO_LONG, nextDefaultName } from "../lib/defaultName.js";
import { syncAlbumIndexForCaptures } from "./albumIndex.js";
import {
  AlbumDetail,
  AlbumExclusions,
  AlbumList,
  AlbumSpecies,
  AlbumSuggestionList,
  CreatedAlbum,
  UpdatedAlbum,
} from "./responses.js";
import { albumSuggestions, dismissSuggestion, restoreSuggestion } from "./suggestions.js";
import { photoSetSpeciesCards } from "../collection/photoSetSpecies.js";
import { resolveQuadSlots } from "../lib/quadCover.js";
import { applyDefaultCoverCrops } from "./defaultCoverCrops.js";
import { isValidCrop } from "../lib/crop.js";
import { BEST_PHOTO_ORDER } from "../lib/bestPhotoOrder.js";
import { DateTime, IdParams, Nullable, Ok, Uuid, notFoundOnInvalidId, replies, withSchemas } from "../lib/schema.js";

const albumNotFound = notFoundOnInvalidId("Album not found");
const Percent = Type.Number({ minimum: 0, maximum: 100 });
// A crop's size can't be 0: it would frame nothing (lib/crop.ts isValidCrop).
const CropSize = Type.Number({ exclusiveMinimum: 0, maximum: 100 });
const Crop = Type.Object({ x: Percent, y: Percent, size: CropSize }, { additionalProperties: false });

/** The album when the user owns it, with its rules (null for a hand-picked album). */
async function assertOwnedAlbum(albumId: string, userId: string): Promise<{ rules: SmartAlbumRules | null } | null> {
  const res = await pool.query<{ rules: SmartAlbumRulesInput | null }>(
    `SELECT rules FROM albums WHERE id = $1 AND user_id = $2`,
    [albumId, userId],
  );
  return res.rows[0] ? { rules: storedRules(res.rows[0].rules) } : null;
}

const SMART_ALBUM_NO_ADD =
  "This is a smart album: its rules choose its photos, so photos can't be added by hand. Edit its rules instead.";
// Keeps one request one quick transaction; the web sends a bigger selection in chunks.
const MAX_BATCH_REMOVE = 500;
const SMART_ALBUM_NO_REMOVE = "This is a smart album: its rules choose its photos. Exclude the photo instead.";

/** The album's photos as gallery rows: a hand-picked album's newest-added first, a smart album's
 *  live rule matches less its exclusions. The album page, export and share page all read
 *  membership here, so every kind of album resolves its photos the same way. Through the
 *  trash-excluding captures view, so trashed photos drop out. */
export async function albumItemRows<T extends AlbumMember = GalleryRow>(
  albumId: string,
  userId: string,
  seen: ReadonlySet<string> = new Set(),
  columns = GALLERY_ITEM_COLUMNS,
): Promise<T[]> {
  const album = await assertOwnedAlbum(albumId, userId);
  if (album?.rules) {
    const [rows, excluded] = await Promise.all([
      smartAlbumRows<T>(album.rules, userId, new Set([...seen, albumId]), columns),
      pool.query<{ capture_id: string }>(`SELECT capture_id FROM album_exclusions WHERE album_id = $1`, [albumId]),
    ]);
    const out = new Set(excluded.rows.map((r) => r.capture_id));
    return rows.filter((r) => !out.has(r.capture_id));
  }
  const res = await pool.query(
    `SELECT ${columns}
     FROM album_captures ac
     JOIN captures c ON c.id = ac.capture_id
     ${GALLERY_ITEM_FRAME_JOINS}
     WHERE ac.album_id = $1 AND c.user_id = $2
     ORDER BY ac.added_at DESC`,
    [albumId, userId],
  );
  return res.rows as T[];
}

const albumMembers = (albumId: string, userId: string, seen?: ReadonlySet<string>) =>
  albumItemRows<AlbumMember>(albumId, userId, seen, ALBUM_MEMBER_COLUMNS);

/** Full rows for these captures, in the order given. captures_all, not the captures view: a smart
 *  album's rules can pick hidden photos, and the ids are already filtered. */
async function galleryRowsInOrder(captureIds: string[], userId: string): Promise<GalleryRow[]> {
  const res = await pool.query<GalleryRow>(
    `SELECT ${GALLERY_ITEM_COLUMNS} FROM captures_all c ${GALLERY_ITEM_FRAME_JOINS}
     WHERE c.id = ANY($1::uuid[]) AND c.user_id = $2 AND c.deleted_at IS NULL`,
    [captureIds, userId],
  );
  const byId = new Map(res.rows.map((r) => [r.capture_id, r]));
  return captureIds.flatMap((id) => byId.get(id) ?? []);
}

/** A smart album's member captures, or undefined for any other album (whose album_captures rows
 *  say). Empty for one already in `seen`: rules that scope to their own album match nothing more. */
export async function smartAlbumCaptureIds(
  albumId: string,
  userId: string,
  seen: ReadonlySet<string>,
): Promise<string[] | undefined> {
  const album = await assertOwnedAlbum(albumId, userId);
  if (!album?.rules) return undefined;
  if (seen.has(albumId)) return [];
  return (await albumMembers(albumId, userId, seen)).map((r) => r.capture_id);
}

export async function albumRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.get(
    "/albums",
    { preValidation: requireScope("album.read"), schema: { response: replies(AlbumList) } },
    async (request) => {
      const res = await pool.query(
        `SELECT a.id, a.name, a.description, a.cover_layout, a.cover_crop_x, a.cover_crop_y, a.cover_crop_size, a.created_at,
              a.quad_photo_ids, a.quad_crops, a.rules,
              (SELECT count(*) FROM album_captures ac WHERE ac.album_id = a.id) AS capture_count,
              -- cover_p resolves NULL when cover_photo_id's own capture has been trashed (see
              -- the /albums/:id route's own comment on this trap), falls back to the album's
              -- own most-recently-added photo via "fallback", same default an unset cover uses.
              cover_p.id AS resolved_cover_photo_id,
              (cover_p.id IS NOT NULL) AS cover_is_manual_pick,
              fallback.photo_id AS fallback_cover_photo_id,
              -- EVERY non-trashed photo in the album, not just a handful, this doubles as both
              -- the fallback-fill pool AND the validity check for a manually-picked slot (a
              -- picked photo not from the "most recent" end still needs to pass as valid, or a
              -- deliberately-chosen older photo would get silently discarded as if trashed).
              (
                SELECT array_agg(sub.photo_id) FROM (
                  SELECT c.current_photo_id AS photo_id
                  FROM album_captures ac2
                  JOIN captures c ON c.id = ac2.capture_id
                  WHERE ac2.album_id = a.id AND c.current_photo_id IS NOT NULL
                  ORDER BY ${BEST_PHOTO_ORDER}
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
         ORDER BY ${BEST_PHOTO_ORDER} LIMIT 1
       ) fallback ON true
       WHERE a.user_id = $1
       ORDER BY a.created_at DESC`,
        [request.user!.id],
      );
      // A smart album's count and cover come from its live matches, not album_captures.
      const smartItems = new Map(
        await Promise.all(
          res.rows
            .filter((r) => r.rules)
            .map(async (r) => [r.id as string, await albumMembers(r.id, request.user!.id)] as const),
        ),
      );
      return {
        albums: res.rows.map((r) => {
          const items = smartItems.get(r.id);
          const fallbackCover = items ? (items[0]?.photo_id ?? null) : r.fallback_cover_photo_id;
          const quadCandidates = items ? items.map((i) => i.photo_id) : (r.quad_candidate_photo_ids ?? []);
          return applyDefaultCoverCrops({
            id: r.id,
            name: r.name,
            description: r.description,
            coverPhotoId: r.resolved_cover_photo_id ?? fallbackCover ?? null,
            coverLayout: r.cover_layout,
            // The crop was framed for the trashed photo, so it's wrong for the fallback.
            coverCropX: !r.cover_is_manual_pick || r.cover_crop_x == null ? null : Number(r.cover_crop_x),
            coverCropY: !r.cover_is_manual_pick || r.cover_crop_y == null ? null : Number(r.cover_crop_y),
            coverCropSize: !r.cover_is_manual_pick || r.cover_crop_size == null ? null : Number(r.cover_crop_size),
            quadSlots: resolveQuadSlots(r.quad_photo_ids, r.quad_crops, quadCandidates),
            createdAt: r.created_at,
            rules: storedRules(r.rules),
            captureCount: items ? items.length : Number(r.capture_count),
          });
        }),
      };
    },
  );

  // Smart albums worth making from the user's own photos. Nothing is created until they pick one.
  app.get(
    "/albums/suggestions",
    {
      preValidation: requireScope("album.read"),
      schema: {
        querystring: Type.Object({
          dismissed: Type.Optional(
            Type.Enum(["true", "false"], { description: "true for the dismissed ones, to restore" }),
          ),
        }),
        response: replies(AlbumSuggestionList),
      },
    },
    async (request) => albumSuggestions(request.user!.id, { dismissed: request.query.dismissed === "true" }),
  );

  app.post(
    "/albums/suggestions/:id/restore",
    {
      preValidation: requireScope("album.write"),
      schema: {
        params: Type.Object({ id: Type.String({ pattern: "^[a-z0-9-]{1,80}$" }) }),
        response: replies(Ok),
      },
    },
    async (request) => {
      await restoreSuggestion(request.user!.id, request.params.id);
      return { ok: true };
    },
  );

  app.post(
    "/albums/suggestions/:id/dismiss",
    {
      preValidation: requireScope("album.write"),
      schema: {
        params: Type.Object({ id: Type.String({ pattern: "^[a-z0-9-]{1,80}$" }) }),
        response: replies(Ok),
      },
    },
    async (request) => {
      await dismissSuggestion(request.user!.id, request.params.id);
      return { ok: true };
    },
  );

  app.post(
    "/albums",
    {
      preValidation: requireScope("album.write"),
      schema: {
        // A blank or missing name gets the next "Untitled Album" name.
        // With rules it's a smart album: its photos are what those Gallery filters match.
        body: Type.Object(
          {
            name: Type.Optional(Type.String()),
            description: Type.Optional(Nullable(Type.String())),
            rules: Type.Optional(SmartAlbumRulesInput),
          },
          { additionalProperties: false },
        ),
        response: replies(CreatedAlbum),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const checked = request.body?.rules ? checkedRules(request.body.rules) : null;
      if (checked && "error" in checked) return reply.code(400).send({ error: checked.error });
      const rules = checked?.rules ?? null;
      let name = request.body?.name?.trim();
      if (name && name.length > MAX_NAME_LENGTH) return reply.code(400).send({ error: NAME_TOO_LONG });
      if (!name) {
        const countRes = await pool.query(
          `SELECT count(*) FROM albums WHERE user_id = $1 AND name ~ '^Untitled Album( [A-Za-z-]+)?$'`,
          [userId],
        );
        name = nextDefaultName("Album", Number(countRes.rows[0].count));
      }

      const res = await pool.query(
        `INSERT INTO albums (user_id, name, description, rules) VALUES ($1, $2, $3, $4)
         RETURNING id, name, description, cover_photo_id, created_at, rules`,
        [userId, name, request.body?.description?.trim() || null, rules ? JSON.stringify(rules) : null],
      );
      const r = res.rows[0];
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        coverPhotoId: r.cover_photo_id,
        createdAt: r.created_at,
        rules: r.rules,
        captureCount: rules ? (await albumMembers(r.id, userId)).length : 0,
      };
    },
  );

  app.get(
    "/albums/:id",
    {
      preValidation: requireScope("album.read"),
      config: albumNotFound,
      schema: {
        params: IdParams,
        querystring: Type.Object({
          limit: Type.Optional(
            Type.Integer({ minimum: 1, maximum: 1000, description: "Only the first this many photos in items" }),
          ),
        }),
        response: replies(AlbumDetail),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const albumRes = await pool.query(
        // NULL when the cover's capture is trashed: soft delete doesn't clear cover_photo_id.
        `SELECT a.id, a.name, a.description, a.cover_layout, a.cover_crop_x, a.cover_crop_y, a.cover_crop_size, a.created_at,
                a.quad_photo_ids, a.quad_crops, a.rules,
                (SELECT count(*) FROM album_exclusions ae JOIN captures c ON c.id = ae.capture_id
                  WHERE ae.album_id = a.id) AS excluded_count,
                cover_p.id AS resolved_cover_photo_id,
                (
                  SELECT array_agg(sub.photo_id) FROM (
                    SELECT c.current_photo_id AS photo_id
                    FROM album_captures ac2 JOIN captures c ON c.id = ac2.capture_id
                    WHERE ac2.album_id = a.id AND c.current_photo_id IS NOT NULL
                    ORDER BY ${BEST_PHOTO_ORDER}
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

      // With a limit, the first photos only (the page draws them while the whole album loads), from
      // the cheap member list that still gives the count, cover and quad candidates.
      const { limit } = request.query;
      let items: AlbumMember[];
      let rows: GalleryRow[];
      if (limit) {
        items = await albumMembers(album.id, userId);
        rows = await galleryRowsInOrder(
          items.slice(0, limit).map((m) => m.capture_id),
          userId,
        );
      } else {
        rows = await albumItemRows(album.id, userId);
        items = rows;
      }

      return applyDefaultCoverCrops({
        id: album.id,
        name: album.name,
        description: album.description,
        // Falls back to the first item once the manual pick's capture is gone.
        coverPhotoId: album.resolved_cover_photo_id ?? items[0]?.photo_id ?? null,
        coverLayout: album.cover_layout,
        coverPicked: album.resolved_cover_photo_id != null,
        // The crop belongs to the picked photo, so drop it when we fell back to another.
        coverCropX:
          album.resolved_cover_photo_id == null ? null : album.cover_crop_x == null ? null : Number(album.cover_crop_x),
        coverCropY:
          album.resolved_cover_photo_id == null ? null : album.cover_crop_y == null ? null : Number(album.cover_crop_y),
        coverCropSize:
          album.resolved_cover_photo_id == null
            ? null
            : album.cover_crop_size == null
              ? null
              : Number(album.cover_crop_size),
        quadSlots: resolveQuadSlots(
          album.quad_photo_ids,
          album.quad_crops,
          album.rules ? items.map((i) => i.photo_id) : (album.quad_candidate_photo_ids ?? []),
        ),
        createdAt: album.created_at,
        rules: storedRules(album.rules),
        excludedCount: Number(album.excluded_count),
        itemCount: items.length,
        items: rows.map((row) => toGalleryItem(row, null)),
      });
    },
  );

  app.patch(
    "/albums/:id",
    {
      preValidation: requireScope("album.write"),
      config: albumNotFound,
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            name: Type.Optional(Type.String()),
            description: Type.Optional(Nullable(Type.String())),
            coverPhotoId: Type.Optional(Nullable(Uuid())),
            coverLayout: Type.Optional(Type.Enum(["single", "quad"])),
            rules: Type.Optional(SmartAlbumRulesInput),
          },
          { additionalProperties: false },
        ),
        response: replies(UpdatedAlbum),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const owned = await assertOwnedAlbum(request.params.id, userId);
      if (!owned) return reply.code(404).send({ error: "Album not found" });
      const { name, description, coverPhotoId, coverLayout } = request.body;
      if (name !== undefined && !name.trim()) return reply.code(400).send({ error: "name can't be empty" });
      if (name && name.trim().length > MAX_NAME_LENGTH) return reply.code(400).send({ error: NAME_TOO_LONG });
      // A hand-picked album stays one: rules would silently replace the photos the user chose.
      if (request.body.rules && !owned.rules)
        return reply.code(409).send({ error: "Only a smart album has rules. Make a new smart album instead." });
      const checked = request.body.rules ? checkedRules(request.body.rules) : null;
      if (checked && "error" in checked) return reply.code(400).send({ error: checked.error });
      const rules = checked?.rules ?? null;
      if (coverPhotoId !== undefined && coverPhotoId !== null) {
        const owned = await pool.query(
          `SELECT 1 FROM photos p JOIN captures c ON c.id = p.capture_id WHERE p.id = $1 AND c.user_id = $2`,
          [coverPhotoId, userId],
        );
        if (owned.rowCount === 0) return reply.code(400).send({ error: "coverPhotoId is not one of your photos" });
      }
      const res = await pool.query(
        `UPDATE albums SET
           name = COALESCE($3, name),
           description = CASE WHEN $4::boolean THEN $5 ELSE description END,
           cover_photo_id = CASE WHEN $6::boolean THEN $7 ELSE cover_photo_id END,
           cover_layout = COALESCE($8, cover_layout),
           -- A newly-picked cover photo was never framed for whatever crop was saved against
           -- the PREVIOUS cover, so it's cleared here too, same rule trips' own cover-pick
           -- endpoint already follows.
           cover_crop_x = CASE WHEN $6::boolean THEN NULL ELSE cover_crop_x END,
           cover_crop_y = CASE WHEN $6::boolean THEN NULL ELSE cover_crop_y END,
           cover_crop_size = CASE WHEN $6::boolean THEN NULL ELSE cover_crop_size END,
           rules = COALESCE($9::jsonb, rules),
           updated_at = now()
         WHERE id = $1 AND user_id = $2
         RETURNING id, name, description, cover_photo_id, cover_layout, created_at, rules`,
        [
          request.params.id,
          userId,
          name?.trim() || null,
          description !== undefined,
          description?.trim() || null,
          coverPhotoId !== undefined,
          coverPhotoId ?? null,
          coverLayout ?? null,
          rules ? JSON.stringify(rules) : null,
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
        rules: r.rules,
      };
    },
  );

  app.delete(
    "/albums/:id",
    {
      preValidation: requireScope("album.write"),
      config: albumNotFound,
      schema: { params: IdParams, response: replies(Ok) },
    },
    async (request, reply) => {
      const res = await pool.query(`DELETE FROM albums WHERE id = $1 AND user_id = $2`, [
        request.params.id,
        request.user!.id,
      ]);
      if (res.rowCount === 0) return reply.code(404).send({ error: "Album not found" });
      return { ok: true };
    },
  );

  app.post(
    "/albums/:id/captures",
    {
      preValidation: requireScope("album.write"),
      config: albumNotFound,
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            captureIds: Type.Array(Uuid(), { minItems: 1 }),
            addedAt: Type.Optional(
              Type.Record(Type.String(), DateTime(), {
                description:
                  "Puts photos back at their old place in the album's order: the addedAt a remove answered with",
              }),
            ),
          },
          { additionalProperties: false },
        ),
        response: replies(Ok),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const owned = await assertOwnedAlbum(request.params.id, userId);
      if (!owned) return reply.code(404).send({ error: "Album not found" });
      if (owned.rules) return reply.code(409).send({ error: SMART_ALBUM_NO_ADD });
      const { captureIds, addedAt } = request.body;

      // Only the user's own captures: the caller supplies capture IDs directly here.
      const inserted = await pool.query(
        `INSERT INTO album_captures (album_id, capture_id, added_at)
         SELECT $1, c.id, COALESCE(($4::jsonb ->> c.id::text)::timestamptz, now())
         FROM captures c WHERE c.id = ANY($2) AND c.user_id = $3
         ON CONFLICT DO NOTHING
         RETURNING capture_id`,
        [request.params.id, captureIds, userId, JSON.stringify(addedAt ?? {})],
      );

      // An album with no cover gets one from what was just added; a manual pick overrides it.
      if (inserted.rows.length > 0) {
        await pool.query(
          `UPDATE albums a SET cover_photo_id = sub.photo_id
           FROM (
             SELECT c.current_photo_id AS photo_id FROM captures c
             WHERE c.id = ANY($2) AND c.current_photo_id IS NOT NULL
             ORDER BY ${BEST_PHOTO_ORDER}
             LIMIT 1
           ) sub
           WHERE a.id = $1 AND a.cover_photo_id IS NULL`,
          [request.params.id, inserted.rows.map((r) => r.capture_id)],
        );
      }
      // Best-effort: a recovery-manifest write never blocks or fails the request.
      syncAlbumIndexForCaptures(inserted.rows.map((r) => r.capture_id)).catch((err: unknown) =>
        log.warn(
          { albumId: request.params.id, err: err instanceof Error ? err.message : err },
          "Couldn't update the album recovery index",
        ),
      );
      return { ok: true };
    },
  );

  app.delete(
    "/albums/:id/captures/:captureId",
    {
      preValidation: requireScope("album.write"),
      config: albumNotFound,
      schema: { params: Type.Object({ id: Uuid(), captureId: Uuid() }), response: replies(Ok) },
    },
    async (request, reply) => {
      const owned = await assertOwnedAlbum(request.params.id, request.user!.id);
      if (!owned) return reply.code(404).send({ error: "Album not found" });
      if (owned.rules) return reply.code(409).send({ error: SMART_ALBUM_NO_REMOVE });
      await pool.query(`DELETE FROM album_captures WHERE album_id = $1 AND capture_id = $2`, [
        request.params.id,
        request.params.captureId,
      ]);
      syncAlbumIndexForCaptures([request.params.captureId]).catch((err: unknown) =>
        log.warn(
          { captureId: request.params.captureId, err: err instanceof Error ? err.message : err },
          "Couldn't update the album recovery index",
        ),
      );
      return { ok: true };
    },
  );

  // Takes many photos out at once. addedAt lets an Undo put them back in the same order.
  app.post(
    "/albums/:id/items/remove",
    {
      preValidation: requireScope("album.write"),
      config: albumNotFound,
      schema: {
        params: IdParams,
        body: Type.Object(
          { captureIds: Type.Array(Uuid(), { minItems: 1, maxItems: MAX_BATCH_REMOVE }) },
          { additionalProperties: false },
        ),
        response: replies(
          Type.Object({
            removed: Type.Integer(),
            skipped: Type.Integer({ description: "Photos that weren't in the album" }),
            addedAt: Type.Record(Type.String(), DateTime(), {
              description: "When each removed photo had been added, to pass back to an add to undo",
            }),
          }),
        ),
      },
    },
    async (request, reply) => {
      const owned = await assertOwnedAlbum(request.params.id, request.user!.id);
      if (!owned) return reply.code(404).send({ error: "Album not found" });
      if (owned.rules) return reply.code(409).send({ error: SMART_ALBUM_NO_REMOVE });
      const captureIds = [...new Set(request.body.captureIds)];
      // One statement, so the batch goes all at once or not at all.
      // added_at as ISO text with its microseconds, so a re-add sorts exactly where it was.
      const res = await pool.query<{ capture_id: string; added_at: string }>(
        `DELETE FROM album_captures WHERE album_id = $1 AND capture_id = ANY($2::uuid[])
         RETURNING capture_id, to_json(added_at) #>> '{}' AS added_at`,
        [request.params.id, captureIds],
      );
      const removed = res.rows.map((r) => r.capture_id);
      syncAlbumIndexForCaptures(removed).catch((err: unknown) =>
        log.warn(
          { albumId: request.params.id, err: err instanceof Error ? err.message : err },
          "Couldn't update the album recovery index",
        ),
      );
      return {
        removed: removed.length,
        skipped: captureIds.length - removed.length,
        addedAt: Object.fromEntries(res.rows.map((r) => [r.capture_id, r.added_at])),
      };
    },
  );

  // A smart album's exclusions: photos its rules match that the user took out by hand.
  app.get(
    "/albums/:id/exclusions",
    {
      preValidation: requireScope("album.read"),
      config: albumNotFound,
      schema: { params: IdParams, response: replies(AlbumExclusions) },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      if (!(await assertOwnedAlbum(request.params.id, userId))) {
        return reply.code(404).send({ error: "Album not found" });
      }
      const res = await pool.query<GalleryRow>(
        `SELECT ${GALLERY_ITEM_COLUMNS}
         FROM album_exclusions ae
         JOIN captures c ON c.id = ae.capture_id
         ${GALLERY_ITEM_FRAME_JOINS}
         WHERE ae.album_id = $1 AND c.user_id = $2
         ORDER BY ae.excluded_at DESC`,
        [request.params.id, userId],
      );
      return { items: res.rows.map((row) => toGalleryItem(row, null)) };
    },
  );

  app.post(
    "/albums/:id/exclusions",
    {
      preValidation: requireScope("album.write"),
      config: albumNotFound,
      schema: {
        params: IdParams,
        body: Type.Object({ captureIds: Type.Array(Uuid(), { minItems: 1 }) }, { additionalProperties: false }),
        response: replies(Ok),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const owned = await assertOwnedAlbum(request.params.id, userId);
      if (!owned) return reply.code(404).send({ error: "Album not found" });
      if (!owned.rules)
        return reply.code(409).send({ error: "Only a smart album has exclusions. Remove the photo instead." });
      // Only the user's own captures: the caller supplies capture IDs directly here.
      await pool.query(
        `INSERT INTO album_exclusions (album_id, capture_id)
         SELECT $1, c.id FROM captures_all c WHERE c.id = ANY($2) AND c.user_id = $3
         ON CONFLICT DO NOTHING`,
        [request.params.id, request.body.captureIds, userId],
      );
      return { ok: true };
    },
  );

  // Puts many back in one go, for an album with hundreds left out.
  app.post(
    "/albums/:id/exclusions/restore",
    {
      preValidation: requireScope("album.write"),
      config: albumNotFound,
      schema: {
        params: IdParams,
        body: Type.Object({ captureIds: Type.Array(Uuid(), { minItems: 1 }) }, { additionalProperties: false }),
        response: replies(Ok),
      },
    },
    async (request, reply) => {
      if (!(await assertOwnedAlbum(request.params.id, request.user!.id))) {
        return reply.code(404).send({ error: "Album not found" });
      }
      await pool.query(`DELETE FROM album_exclusions WHERE album_id = $1 AND capture_id = ANY($2::uuid[])`, [
        request.params.id,
        request.body.captureIds,
      ]);
      return { ok: true };
    },
  );

  app.delete(
    "/albums/:id/exclusions/:captureId",
    {
      preValidation: requireScope("album.write"),
      config: albumNotFound,
      schema: { params: Type.Object({ id: Uuid(), captureId: Uuid() }), response: replies(Ok) },
    },
    async (request, reply) => {
      if (!(await assertOwnedAlbum(request.params.id, request.user!.id))) {
        return reply.code(404).send({ error: "Album not found" });
      }
      await pool.query(`DELETE FROM album_exclusions WHERE album_id = $1 AND capture_id = $2`, [
        request.params.id,
        request.params.captureId,
      ]);
      return { ok: true };
    },
  );

  // Same as /trips/:id/cover-crop: a crop needs a manual cover_photo_id first.
  app.patch(
    "/albums/:id/cover-crop",
    {
      preValidation: requireScope("album.write"),
      config: albumNotFound,
      schema: {
        params: IdParams,
        // Either { reset: true } or a full crop, which the handler checks once it knows which.
        body: Type.Object(
          {
            x: Type.Optional(Percent),
            y: Type.Optional(Percent),
            size: Type.Optional(CropSize),
            reset: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
        response: replies(Ok),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const albumRes = await pool.query<{ cover_photo_id: string | null }>(
        `SELECT cover_photo_id FROM albums WHERE id = $1 AND user_id = $2`,
        [request.params.id, userId],
      );
      if (albumRes.rows.length === 0) return reply.code(404).send({ error: "Album not found" });
      if (!albumRes.rows[0].cover_photo_id)
        return reply.code(400).send({ error: "No cover photo set for this album yet" });

      const { x, y, size, reset } = request.body;
      if (reset) {
        await pool.query(
          `UPDATE albums SET cover_crop_x = NULL, cover_crop_y = NULL, cover_crop_size = NULL WHERE id = $1`,
          [request.params.id],
        );
        return { ok: true };
      }

      if (!isValidCrop(x, y, size)) return reply.code(400).send({ error: "x, y, size must each be within 0-100" });

      await pool.query(`UPDATE albums SET cover_crop_x = $1, cover_crop_y = $2, cover_crop_size = $3 WHERE id = $4`, [
        x,
        y,
        size,
        request.params.id,
      ]);
      return { ok: true };
    },
  );

  /** Sets the photo and/or crop of one quad-grid tile. Omitted fields are left as-is; null
   * clears back to auto-pick. */
  app.patch(
    "/albums/:id/quad-slot",
    {
      preValidation: requireScope("album.write"),
      config: albumNotFound,
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            slot: Type.Integer({ minimum: 0, maximum: 3 }),
            photoId: Type.Optional(Nullable(Uuid())),
            crop: Type.Optional(Nullable(Crop)),
          },
          { additionalProperties: false },
        ),
        response: replies(Ok),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const { slot, photoId, crop } = request.body;

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
        crops[slot] = null; // the old crop was framed for a different photo
      }
      if (crop !== undefined) crops[slot] = crop;

      // All slots cleared: store NULL so new captures can join the auto-picked default.
      const allEmpty = ids.every((id) => id == null);
      await pool.query(`UPDATE albums SET quad_photo_ids = $1, quad_crops = $2 WHERE id = $3`, [
        allEmpty ? null : ids,
        allEmpty ? null : JSON.stringify(crops),
        request.params.id,
      ]);
      return { ok: true };
    },
  );

  // Same shape as /trips/:id/species, so the web reuses the species grid.
  app.get(
    "/albums/:id/species",
    {
      preValidation: requireScope("album.read"),
      config: albumNotFound,
      schema: { params: IdParams, response: replies(AlbumSpecies) },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      if (!(await assertOwnedAlbum(request.params.id, userId))) {
        return reply.code(404).send({ error: "Album not found" });
      }
      // The album's own best photo of each species, in the album's order.
      const items = await albumItemRows(request.params.id, userId);
      const speciesIds = [...new Set(items.map((r) => r.species_id))];
      return { items: await photoSetSpeciesCards(userId, speciesIds, items) };
    },
  );
}
