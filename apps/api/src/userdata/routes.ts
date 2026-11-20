// The userdata.read routes: the user's own marks and photos for companion apps, with no catalog
// data (no regions, checklists, tiers, seasonality, common names, descriptions or reference photos).
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import type { CullLabel } from "@lifer/shared";
import { pool } from "@lifer/core/db.js";
import { captureVectors, cosineSimilarity, CLIP_SPACE, l2Normalize } from "@lifer/core/species/embeddings.js";
import { CLIENT_VECTOR_DIMS } from "@lifer/core/species/clientVectors.js";
import { IdParams, notFoundOnInvalidId, replies, withSchemas } from "../lib/schema.js";
import { requireScope } from "../auth/session.js";
import { sendCachedImage, statFile } from "../lib/cachedFile.js";
import { FeaturedPhoto, SimilarPhotos, SpeciesPhotos, UserSpeciesPage } from "./responses.js";
import {
  DEFAULT_SPECIES_NAME_DISPLAY,
  getSpeciesNameDisplay,
  SpeciesNameDisplay,
} from "../settings/speciesNameDisplay.js";
import { userdataWriteRoutes } from "./writeRoutes.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const TS = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const SUBJECT = `(c.species_id = m.species_id
  OR EXISTS (SELECT 1 FROM capture_species cs WHERE cs.capture_id = c.id AND cs.species_id = m.species_id))`;
const MAX_SIMILAR = 50;
const MAX_PHOTOS = 200;

// Opaque to callers: "<time>|<key>", base64url. Keys are "s<species id>" for marks and
// "d<tombstone id>" for deletions, so both page in one order.
const encodeCursor = (time: string, key: string) => Buffer.from(`${time}|${key}`).toString("base64url");
function decodeCursor(cursor: string): { time: string; key: string } | null {
  const [time, key] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  // Exactly the shape TS() writes, so a forged cursor can't reach Postgres as a bad timestamp.
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(time ?? "") || !/^(s[0-9a-f-]{36}|d\d+)$/.test(key ?? ""))
    return null;
  return { time, key };
}

export async function userdataRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  await app.register(userdataWriteRoutes);

  // Every species the user marked or photographed, oldest change first, then removed marks.
  app.get(
    "/userdata/v1/species",
    {
      preValidation: requireScope("userdata.read"),
      schema: {
        querystring: Type.Object({
          since: Type.Optional(
            Type.String({
              format: "date-time",
              description: "Only changes after this time (an `updatedAt` from an earlier call)",
            }),
          ),
          cursor: Type.Optional(Type.String({ description: "`nextCursor` from the previous page" })),
          limit: Type.Optional(Type.Integer({ minimum: 1, description: "Page size, 1-500 (default 100)" })),
        }),
        response: replies(UserSpeciesPage),
      },
    },
    async (request, reply) => {
      const limit = Math.min(request.query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const params: unknown[] = [request.user!.id];
      const where: string[] = [];
      if (request.query.since) {
        params.push(request.query.since);
        where.push(`ts > $${params.length}::timestamptz`);
      }
      if (request.query.cursor) {
        const cursor = decodeCursor(request.query.cursor);
        if (!cursor) return reply.code(400).send({ error: "Invalid cursor" });
        params.push(cursor.time, cursor.key);
        where.push(`(ts, k) > ($${params.length - 1}::timestamptz, $${params.length}::text)`);
      }
      params.push(limit + 1);

      // The `captures` view leaves out hidden and trashed photos, for the counts and the cover alike.
      // Photos count where the species is the main or an additional subject, as Lifer counts them.
      const res = await pool.query(
        `WITH marks AS (
           SELECT GREATEST(us.updated_at, us.photos_changed_at) AS ts, 's' || us.species_id::text AS k, us.species_id, s.scientific_name,
                  us.state, us.is_target, us.first_collected, us.best_quality, us.cover_photo_id, NULL::timestamptz AS deleted_at
           FROM user_species us JOIN species s ON s.id = us.species_id
           WHERE us.user_id = $1
           UNION ALL
           SELECT t.deleted_at, 'd' || t.id::text,
                  (SELECT s.id FROM species s WHERE s.scientific_name = t.ref ORDER BY s.id LIMIT 1), t.ref,
                  NULL, false, NULL, NULL, NULL, t.deleted_at
           FROM sync_tombstones t
           WHERE t.user_id = $1 AND t.kind = 'user_species'
         )
         SELECT m.*, ${TS("m.ts")} AS ts_text,
                CASE WHEN m.deleted_at IS NULL THEN
                  (SELECT count(*)::int FROM captures c WHERE c.user_id = $1 AND ${SUBJECT})
                ELSE 0 END AS photo_count,
                CASE WHEN m.deleted_at IS NULL THEN
                  (SELECT max(c.taken_at) FROM captures c WHERE c.user_id = $1 AND ${SUBJECT})
                END AS last_photographed,
                (SELECT p.id FROM photos p JOIN captures c ON c.id = p.capture_id
                  WHERE p.id = m.cover_photo_id AND c.user_id = $1) AS own_cover
         FROM marks m
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY m.ts, m.k
         LIMIT $${params.length}`,
        params,
      );
      const rows = res.rows.slice(0, limit);
      const last = rows[rows.length - 1];
      return {
        items: rows.map((r) => ({
          speciesId: r.species_id,
          scientificName: r.scientific_name,
          state: r.state === "collected" ? ("photographed" as const) : r.state === "seen" ? ("seen" as const) : null,
          isTarget: r.is_target,
          firstCollected: r.first_collected,
          lastPhotographed: r.last_photographed,
          photoCount: r.photo_count,
          bestRating: r.best_quality,
          coverPhotoId: r.own_cover,
          updatedAt: r.ts_text,
          deletedAt: r.deleted_at ? r.ts_text : null,
        })),
        nextCursor: res.rows.length > limit && last ? encodeCursor(last.ts_text, last.k) : null,
      };
    },
  );

  // How the user wants species named (main name, and what else shows under it), for apps that list species.
  app.get(
    "/userdata/v1/name-display",
    {
      preValidation: requireScope("userdata.read"),
      schema: { response: replies(SpeciesNameDisplay) },
    },
    async (request) => (await getSpeciesNameDisplay(request.user!.id)) ?? DEFAULT_SPECIES_NAME_DISPLAY,
  );

  // The display image or thumbnail of one of the user's own visible photos. Serves the stored file
  // only: no repair, so this GET never writes.
  for (const kind of ["display", "thumb"] as const)
    app.get(
      `/userdata/v1/photos/:id/${kind}`,
      {
        preValidation: requireScope("userdata.read"),
        config: notFoundOnInvalidId("Photo not found"),
        schema: { params: IdParams },
      },
      async (request, reply) => {
        const res = await pool.query<{ path: string | null }>(
          `SELECT p.${kind}_path AS path FROM photos p JOIN captures c ON c.id = p.capture_id
           WHERE p.id = $1 AND c.user_id = $2`,
          [request.params.id, request.user!.id],
        );
        const filePath = res.rows[0]?.path;
        const st = filePath ? await statFile(filePath) : null;
        if (!filePath || !st) return reply.code(404).send({ error: "Photo not found" });
        return sendCachedImage(request, reply, filePath, st);
      },
    );

  // The user's photos of a species, best first, by the same rule as the species-pin cards
  // (collection/map.ts pinPhotosSql).
  app.get(
    "/userdata/v1/species/:id/photos",
    {
      preValidation: requireScope("userdata.read"),
      config: notFoundOnInvalidId("Species not found"),
      schema: {
        params: IdParams,
        querystring: Type.Object({
          limit: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_PHOTOS, description: `1-${MAX_PHOTOS} (default 50)` }),
          ),
        }),
        response: replies(SpeciesPhotos),
      },
    },
    async (request, reply) => {
      const speciesId = request.params.id;
      const known = await pool.query(`SELECT 1 FROM species WHERE id = $1`, [speciesId]);
      if (!known.rows[0]) return reply.code(404).send({ error: "Species not found" });
      // The `captures` view: hidden and trashed photos are left out, as in the Gallery.
      const res = await pool.query(
        `SELECT c.id AS capture_id, c.current_photo_id AS photo_id, c.quality_rating, c.cull_verdict, c.cull_label,
                c.taken_at, COALESCE(us.cover_photo_id = c.current_photo_id, false) AS featured
         FROM captures c
         LEFT JOIN user_species us ON us.user_id = c.user_id AND us.species_id = $2
         WHERE c.user_id = $1 AND c.current_photo_id IS NOT NULL
           AND (c.species_id = $2 OR EXISTS (SELECT 1 FROM capture_species cs WHERE cs.capture_id = c.id AND cs.species_id = $2))
         ORDER BY c.quality_rating DESC NULLS LAST, c.taken_at DESC NULLS LAST, c.id
         LIMIT $3`,
        [request.user!.id, speciesId, request.query.limit ?? 50],
      );
      return {
        items: res.rows.map((r) => ({
          photoId: r.photo_id,
          captureId: r.capture_id,
          thumbnailUrl: `/api/userdata/v1/photos/${r.photo_id}/thumb`,
          rating: r.quality_rating,
          flag: r.cull_verdict,
          label: r.cull_label,
          takenAt: r.taken_at,
          featured: r.featured,
        })),
      };
    },
  );
  // The species' featured photo, with its crop and marks. 404 when the user has no mark for it.
  app.get(
    "/userdata/v1/species/:id/featured",
    {
      preValidation: requireScope("userdata.read"),
      config: notFoundOnInvalidId("Species not found"),
      schema: { params: IdParams, response: replies(FeaturedPhoto) },
    },
    async (request, reply) => {
      const res = await pool.query(
        // The `captures` view: a cover whose photo is hidden, trashed or someone else's isn't handed out.
        `SELECT us.needs_better_photo, p.id AS photo_id, us.cover_chosen_photo_id = p.id AS chosen, c.id AS capture_id,
                us.card_crop_x, us.card_crop_y, us.card_crop_size, c.quality_rating, c.cull_verdict, c.cull_label
         FROM user_species us
         LEFT JOIN photos p ON p.id = us.cover_photo_id
         LEFT JOIN captures c ON c.id = p.capture_id AND c.user_id = us.user_id
         WHERE us.user_id = $1 AND us.species_id = $2`,
        [request.user!.id, request.params.id],
      );
      const r = res.rows[0];
      if (!r) return reply.code(404).send({ error: "Species not found" });
      const visible = r.capture_id !== null;
      const crop =
        visible && r.card_crop_size !== null
          ? { x: Number(r.card_crop_x), y: Number(r.card_crop_y), size: Number(r.card_crop_size) }
          : null;
      return {
        photo: visible
          ? {
              photoId: r.photo_id,
              chosenByUser: r.chosen === true,
              cardCrop: crop,
              rating: r.quality_rating,
              flag: r.cull_verdict,
              label: r.cull_label,
            }
          : null,
        needsBetterPhoto: r.needs_better_photo,
      };
    },
  );

  // The user's photos of a species nearest to an image vector, by the same whole-photo CLIP vectors
  // Lifer's similar-photo finder compares (gallery/similar.ts). A POST only because a vector
  // doesn't fit in a URL: it reads and changes nothing.
  app.post(
    "/userdata/v1/species/:id/similar-photos",
    {
      preValidation: requireScope("userdata.read"),
      config: notFoundOnInvalidId("Species not found"),
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            model: Type.Literal(CLIP_SPACE.modelVersion, {
              description: "The model the vector came from; only this one compares with Lifer's",
            }),
            vector: Type.Array(Type.Number(), {
              minItems: CLIENT_VECTOR_DIMS,
              maxItems: CLIENT_VECTOR_DIMS,
              description: `A ${CLIENT_VECTOR_DIMS}-number image embedding`,
            }),
            limit: Type.Optional(
              Type.Integer({ minimum: 1, maximum: MAX_SIMILAR, description: `1-${MAX_SIMILAR} (default 10)` }),
            ),
          },
          { additionalProperties: false },
        ),
        response: replies(SimilarPhotos),
      },
    },
    async (request) => {
      const userId = request.user!.id;
      const speciesId = request.params.id;
      // The `captures` view: hidden and trashed photos are left out, as everywhere else.
      const res = await pool.query<{
        capture_id: string;
        photo_id: string;
        computed_at: string | null;
        quality_rating: number | null;
        cull_verdict: "pick" | "reject" | null;
        cull_label: CullLabel | null;
        taken_at: Date | null;
        featured: boolean;
      }>(
        `SELECT c.id AS capture_id, c.current_photo_id AS photo_id, ce.computed_at::text AS computed_at,
                c.quality_rating, c.cull_verdict, c.cull_label, c.taken_at,
                COALESCE(us.cover_photo_id = c.current_photo_id, false) AS featured
         FROM captures c
         JOIN ${CLIP_SPACE.captureTable} ce ON ce.capture_id = c.id AND ce.model_version = $3
         LEFT JOIN user_species us ON us.user_id = c.user_id AND us.species_id = $2
         WHERE c.user_id = $1 AND c.current_photo_id IS NOT NULL
           AND (c.species_id = $2 OR EXISTS (SELECT 1 FROM capture_species cs WHERE cs.capture_id = c.id AND cs.species_id = $2))`,
        [userId, speciesId, CLIP_SPACE.modelVersion],
      );
      const vectors = await captureVectors(pool, CLIP_SPACE.captureTable, CLIP_SPACE.modelVersion, res.rows);
      const query = l2Normalize(request.body.vector);
      const items = res.rows
        .filter((r) => vectors.has(r.capture_id))
        .map((r) => ({
          photoId: r.photo_id,
          similarity: Math.round(cosineSimilarity(query, vectors.get(r.capture_id)!) * 10_000) / 10_000,
          rating: r.quality_rating,
          flag: r.cull_verdict,
          label: r.cull_label,
          takenAt: r.taken_at,
          featured: r.featured,
        }))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, request.body.limit ?? 10);
      return { model: CLIP_SPACE.modelVersion, items };
    },
  );
}
