// Place names (captures.location_label): the list behind the place-name suggestions and
// Settings > Library > Places, and renaming or removing a name on every photo at once.
// A photo's files carry the name as IPTC Sublocation (uploads/exif.ts), and with place folders
// in the folder layout it's a folder too, so a rename or removal rewrites and moves the files after.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { requireScope } from "../auth/session.js";
import { Nullable, Open, Uuid, jobStatusFields, replies, withSchemas } from "../lib/schema.js";
import { photoPlaceForRegion } from "../regions/photoPlace.js";
import { followPlaceChange, refileJob } from "../uploads/reorganizeOriginals.js";

export const PLACE_NAME_MAX = 500;
const PlaceName = Type.String({ maxLength: PLACE_NAME_MAX });
const Updated = Type.Object({
  updated: Type.Integer(),
  movingFiles: Type.Boolean({ description: "Files are moving to their new folders; see /places/file-moves/status" }),
});
const FileMoves = Open({
  ...jobStatusFields(Type.Unknown()),
  moved: Type.Integer(),
  skipped: Type.Integer(),
  failed: Type.Integer(),
  lastError: Nullable(Type.String()),
});

// Hidden photos are renamed too (only the list leaves them out); trashed ones keep theirs.
async function relabel(
  userId: string,
  from: string,
  to: string | null,
): Promise<{ updated: number; movingFiles: boolean }> {
  const res = await pool.query<{ id: string }>(
    `UPDATE captures_all SET location_label = $1
      WHERE user_id = $2 AND location_label = $3 AND deleted_at IS NULL RETURNING id`,
    [to, userId, from],
  );
  const ids = res.rows.map((r) => r.id);
  return { updated: ids.length, movingFiles: await followPlaceChange(userId, ids, { replaceLabel: true }) };
}

const Place = Type.Object({
  name: Type.String(),
  count: Type.Integer(),
  /** The region most of this name's photos are in. */
  regionId: Nullable(Type.String()),
  regionName: Nullable(Type.String()),
  /** That region's country, when it isn't the country itself. */
  countryName: Nullable(Type.String()),
  lastUsedAt: Type.String(),
  /** Used in the `regionId` asked for, or a region inside it. */
  inRegion: Type.Boolean(),
});

export async function capturePlaceRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  // Hidden and trashed photos are left out, like the tag list (the `captures` view).
  app.get(
    "/places",
    {
      preValidation: requireScope("photos.read"),
      schema: {
        querystring: Type.Object({
          q: Type.Optional(
            Type.String({ maxLength: PLACE_NAME_MAX, description: "Names containing this, ignoring case and accents" }),
          ),
          regionId: Type.Optional(Uuid({ description: "Names used in this region or inside it come first" })),
          limit: Type.Optional(
            Type.Integer({ minimum: 1, maximum: 100, description: "At most this many; all of them when left out" }),
          ),
        }),
        response: replies(Type.Object({ places: Type.Array(Place) })),
      },
    },
    async (request) => {
      const q = request.query.q?.trim() || null;
      const res = await pool.query<{
        name: string;
        count: number;
        region_id: string | null;
        region_name: string | null;
        last_used: Date;
        in_region: boolean;
      }>(
        `WITH RECURSIVE inside AS (
           SELECT id FROM regions WHERE id = $2::uuid
           UNION
           -- home_country_id: a province shown under its continent still belongs to its country.
           SELECT r.id FROM regions r JOIN inside i ON r.parent_id = i.id OR r.home_country_id = i.id
         ),
         used AS (
           SELECT location_label AS name, region_id, count(*) AS n, max(updated_at) AS last_used
             FROM captures WHERE user_id = $1 AND location_label IS NOT NULL
            GROUP BY 1, 2
         ),
         places AS (
           SELECT name, sum(n)::int AS count, max(last_used) AS last_used,
                  (array_agg(region_id ORDER BY region_id IS NULL, n DESC, region_id))[1] AS region_id,
                  COALESCE(bool_or(region_id IN (SELECT id FROM inside)), false) AS in_region,
                  strpos(lower(lifer_unaccent(name)), lower(lifer_unaccent($3::text))) AS hit
             FROM used GROUP BY name
         )
         SELECT p.name, p.count, p.region_id, r.name AS region_name, p.last_used, p.in_region
           FROM places p LEFT JOIN regions r ON r.id = p.region_id
          WHERE $3::text IS NULL OR p.hit > 0
          ORDER BY p.in_region DESC, (p.hit = 1) DESC NULLS LAST, p.count DESC, p.name
          LIMIT $4`,
        [request.user!.id, request.query.regionId ?? null, q, request.query.limit ?? null],
      );
      const regionIds = [...new Set(res.rows.map((r) => r.region_id).filter((id): id is string => !!id))];
      const countries = new Map(
        await Promise.all(
          regionIds.map(async (id) => [id, (await photoPlaceForRegion(pool, id))?.country ?? null] as const),
        ),
      );
      return {
        places: res.rows.map((r) => {
          const country = r.region_id ? (countries.get(r.region_id) ?? null) : null;
          return {
            name: r.name,
            count: r.count,
            regionId: r.region_id,
            regionName: r.region_name,
            countryName: country && country !== r.region_name ? country : null,
            lastUsedAt: r.last_used.toISOString(),
            inRegion: r.in_region,
          };
        }),
      };
    },
  );

  // Fixes a typo or casing everywhere. Into a name already in use, it merges the two.
  app.post(
    "/places/rename",
    {
      preValidation: requireScope("photos.write"),
      schema: {
        body: Type.Object({ from: PlaceName, to: PlaceName }, { additionalProperties: false }),
        response: replies(Updated),
      },
    },
    async (request, reply) => {
      // Stored names are trimmed, so the match is exact after trimming. Blank is refused here,
      // since the schema can't trim.
      const from = request.body.from.trim();
      const to = request.body.to.trim();
      if (!from || !to) return reply.code(400).send({ error: "from and to are both required" });
      if (from === to) return { updated: 0, movingFiles: false };
      return relabel(request.user!.id, from, to);
    },
  );

  // Takes the name off its photos; their regions stay.
  app.post(
    "/places/remove",
    {
      preValidation: requireScope("photos.write"),
      schema: {
        body: Type.Object({ name: PlaceName }, { additionalProperties: false }),
        response: replies(Updated),
      },
    },
    async (request, reply) => {
      const name = request.body.name.trim();
      if (!name) return reply.code(400).send({ error: "name is required" });
      return relabel(request.user!.id, name, null);
    },
  );

  // Progress of the folder moves a rename, removal or region change started.
  app.get(
    "/places/file-moves/status",
    { preValidation: requireScope("photos.read"), schema: { response: replies(FileMoves) } },
    async () => refileJob.status,
  );
}
