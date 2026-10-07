import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { requireAuth, requireScope } from "../auth/session.js";
import { syncCaptureXmpSidecarsLogged } from "../uploads/xmpSidecarSync.js";
import { IdParams, Uuid, notFoundOnInvalidId, replies, withSchemas } from "../lib/schema.js";
import { createLimiter } from "@lifer/core/lib/concurrency.js";

const Tags = Type.Array(Type.String());
const TagList = Type.Object({ tags: Tags });
const Updated = Type.Object({ ok: Type.Boolean(), updated: Type.Optional(Type.Integer()) });

// Tags are written into each photo's managed files as keywords (uploads/exif.ts). A change to
// many photos at once is written in the background, a few at a time: the tags are already saved.
function syncFilesInBackground(userId: string, captureIds: string[], log: { error: (obj: object, msg: string) => void }): void {
  const limit = createLimiter(4);
  void Promise.all(captureIds.map((id) => limit(() => syncCaptureXmpSidecarsLogged(userId, id)))).catch((err) =>
    log.error({ err }, "Writing changed tags to photo files failed"),
  );
}

export async function captureTagRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  // Free-text tags ("flight shot"). Replaces the whole list, as the tag editor sends it.
  app.patch(
    "/captures/:id/tags",
    {
      preValidation: requireScope("photos.write"),
      config: notFoundOnInvalidId("Capture not found"),
      schema: {
        params: IdParams,
        body: Type.Object({ tags: Tags }, { additionalProperties: false }),
        response: replies(TagList),
      },
    },
    async (request, reply) => {
      const { id: captureId } = request.params;
      const userId = request.user!.id;
      const rawTags = request.body.tags;
      const tags = [...new Set(rawTags.map((t) => t.trim()).filter(Boolean))];

      const res = await pool.query<{ tags: string[] }>(
        `UPDATE captures SET tags = $1 WHERE id = $2 AND user_id = $3 RETURNING tags`,
        [tags, captureId, userId],
      );
      const capture = res.rows[0];
      if (!capture) return reply.code(404).send({ error: "Capture not found" });

      await syncCaptureXmpSidecarsLogged(userId, captureId);
      return { tags: capture.tags };
    },
  );

  // Every distinct tag this user has used, for autocomplete, so tags get reused verbatim.
  app.get("/captures/tags", { preValidation: requireAuth, schema: { response: replies(TagList) } }, async (request) => {
    const res = await pool.query<{ tag: string }>(
      `SELECT DISTINCT unnest(tags) AS tag FROM captures WHERE user_id = $1 ORDER BY tag`,
      [request.user!.id],
    );
    return { tags: res.rows.map((r) => r.tag) };
  });

  // Bulk tagging only adds: each selected photo keeps the tags it already has.
  app.patch(
    "/captures/tags",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          { captureIds: Type.Array(Uuid(), { minItems: 1 }), tags: Tags },
          { additionalProperties: false },
        ),
        response: replies(Updated),
      },
    },
    async (request) => {
      const userId = request.user!.id;
      const { captureIds, tags: rawTags } = request.body;
      const tags = [...new Set(rawTags.map((t) => t.trim()).filter(Boolean))];
      if (tags.length === 0) return { ok: true };

      const res = await pool.query<{ id: string }>(
        `UPDATE captures SET tags = (
           SELECT array_agg(DISTINCT t ORDER BY t) FROM unnest(tags || $1::text[]) AS t
         ) WHERE id = ANY($2) AND user_id = $3
         RETURNING id`,
        [tags, captureIds, userId],
      );
      // Sidecar sync can be slow for a large selection; tags are already saved, so sync in the
      // background, only for rows this user owns.
      syncFilesInBackground(userId, res.rows.map((r) => r.id), request.log);
      return { ok: true, updated: res.rowCount ?? 0 };
    },
  );

  // Tags with photo counts for the management page, most used first so typos sink.
  app.get(
    "/captures/tags/manage",
    {
      preValidation: requireAuth,
      schema: {
        response: replies(
          Type.Object({ tags: Type.Array(Type.Object({ tag: Type.String(), count: Type.Integer() })) }),
        ),
      },
    },
    async (request) => {
      const res = await pool.query<{ tag: string; count: string }>(
        `SELECT unnest(tags) AS tag, count(*) AS count FROM captures WHERE user_id = $1 GROUP BY tag ORDER BY count DESC, tag ASC`,
        [request.user!.id],
      );
      return { tags: res.rows.map((r) => ({ tag: r.tag, count: Number(r.count) })) };
    },
  );

  // Renames a tag everywhere (typos, casing). The DISTINCT re-aggregate merges it into the
  // target tag on photos that already had both.
  app.patch(
    "/captures/tags/rename",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object({ from: Type.String(), to: Type.String() }, { additionalProperties: false }),
        response: replies(Updated),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      // Blank after trimming is refused here, since the schema can't trim.
      const from = request.body.from.trim();
      const to = request.body.to.trim();
      if (!from || !to) return reply.code(400).send({ error: "from and to are both required" });
      if (from === to) return { ok: true, updated: 0 };

      const res = await pool.query<{ id: string }>(
        `UPDATE captures SET tags = (
         SELECT array_agg(DISTINCT t ORDER BY t) FROM unnest(array_replace(tags, $1, $2)) AS t
       ) WHERE user_id = $3 AND $1 = ANY(tags)
       RETURNING id`,
        [from, to, userId],
      );
      syncFilesInBackground(userId, res.rows.map((r) => r.id), request.log);
      return { ok: true, updated: res.rowCount ?? 0 };
    },
  );

  // Deletes a tag everywhere it's used.
  app.delete(
    "/captures/tags",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object({ tag: Type.String() }, { additionalProperties: false }),
        response: replies(Updated),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const tag = request.body.tag.trim();
      if (!tag) return reply.code(400).send({ error: "tag is required" });

      const res = await pool.query<{ id: string }>(
        `UPDATE captures SET tags = array_remove(tags, $1) WHERE user_id = $2 AND $1 = ANY(tags) RETURNING id`,
        [tag, userId],
      );
      syncFilesInBackground(userId, res.rows.map((r) => r.id), request.log);
      return { ok: true, updated: res.rowCount ?? 0 };
    },
  );
}
