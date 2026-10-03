import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireAuth, requireScope } from "../auth/session.js";
import { syncCaptureXmpSidecarsLogged } from "../uploads/xmpSidecarSync.js";
import { isUuid } from "../lib/validate.js";
import { createLimiter } from "../lib/concurrency.js";

export async function captureTagRoutes(app: FastifyInstance): Promise<void> {
  // Free-text tags ("flight shot"). Replaces the whole list, as the tag editor sends it.
  app.patch<{ Params: { id: string }; Body: { tags: string[] } }>(
    "/captures/:id/tags",
    { preHandler: requireScope("photos.write") },
    async (request, reply) => {
      if (!isUuid(request.params.id)) return reply.code(404).send({ error: "Capture not found" });
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

      await syncCaptureXmpSidecarsLogged(userId, captureId);
      return { tags: capture.tags };
    },
  );

  // Every distinct tag this user has used, for autocomplete, so tags get reused verbatim.
  app.get("/captures/tags", { preHandler: requireAuth }, async (request) => {
    const res = await pool.query<{ tag: string }>(
      `SELECT DISTINCT unnest(tags) AS tag FROM captures WHERE user_id = $1 ORDER BY tag`,
      [request.user!.id],
    );
    return { tags: res.rows.map((r) => r.tag) };
  });

  // Bulk tagging only adds: each selected photo keeps the tags it already has.
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

      const res = await pool.query<{ id: string }>(
        `UPDATE captures SET tags = (
           SELECT array_agg(DISTINCT t ORDER BY t) FROM unnest(tags || $1::text[]) AS t
         ) WHERE id = ANY($2) AND user_id = $3
         RETURNING id`,
        [tags, captureIds.filter(isUuid), userId],
      );
      // Sidecar sync can be slow for a large selection; tags are already saved, so sync in the
      // background, only for rows this user owns.
      const updatedIds = res.rows.map((r) => r.id);
      const limit = createLimiter(4);
      void Promise.all(updatedIds.map((id) => limit(() => syncCaptureXmpSidecarsLogged(userId, id)))).catch((err) =>
        request.log.error({ err }, "Bulk tag sidecar sync failed"),
      );
      return { ok: true, updated: res.rowCount ?? 0 };
    },
  );

  // Tags with photo counts for the management page, most used first so typos sink.
  app.get("/captures/tags/manage", { preHandler: requireAuth }, async (request) => {
    const res = await pool.query<{ tag: string; count: string }>(
      `SELECT unnest(tags) AS tag, count(*) AS count FROM captures WHERE user_id = $1 GROUP BY tag ORDER BY count DESC, tag ASC`,
      [request.user!.id],
    );
    return { tags: res.rows.map((r) => ({ tag: r.tag, count: Number(r.count) })) };
  });

  // Renames a tag everywhere (typos, casing). The DISTINCT re-aggregate merges it into the
  // target tag on photos that already had both.
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

  // Deletes a tag everywhere it's used.
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
}
