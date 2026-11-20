import { existsSync, createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { IdParams, Nullable, Ok, Open, notFoundOnInvalidId, replies, withSchemas } from "../lib/schema.js";
import { requireAuth, requireScope } from "../auth/session.js";
import { revealFile } from "./browse.js";
import { resolveOriginalPath } from "../storageVolumes/resolve.js";
import { contentDisposition } from "../lib/httpFile.js";
import { desktopOnly } from "../settings/requireDesktopMode.js";
import { DATA_DIR } from "@lifer/core/config.js";
import {
  healthSummary,
  ignoreAllHealthProblems,
  ignoreHealthProblem,
  listHealthProblems,
  setArchiveHealthEnabled,
} from "./health.js";

const HealthSummaryBody = Type.Object({
  enabled: Type.Boolean(),
  running: Type.Boolean(),
  processed: Nullable(Type.Number()),
  total: Nullable(Type.Number()),
  lastCheckedAt: Nullable(Type.String({ format: "date-time" })),
  checkedCount: Type.Number(),
  problemCount: Type.Number(),
  notChecked: Type.Array(Type.Object({ label: Type.String(), count: Type.Number() })),
});

const HealthProblemsBody = Type.Object({
  total: Type.Number(),
  items: Type.Array(
    Type.Object({
      id: Type.String(),
      path: Type.String(),
      problem: Type.Union([Type.Literal("changed"), Type.Literal("unreadable"), Type.Literal("missing")]),
      photoId: Nullable(Type.String()),
      captureId: Nullable(Type.String()),
      speciesId: Nullable(Type.String()),
      commonName: Nullable(Type.String()),
      scientificName: Nullable(Type.String()),
    }),
  ),
});

const RevealSamplesBody = Type.Object({
  roots: Type.Array(Type.Object({ root: Type.String(), relativePath: Type.String(), size: Type.Number() })),
});

// For each folder the server keeps originals under, one of the user's files that's there now,
// with its current size. The desktop app looks for that file on the Mac's mounted drives to find
// where the same folder is mounted (Reveal in Finder for a server's files).
async function revealSamples(userId: string): Promise<{ root: string; relativePath: string; size: number }[]> {
  const extra = await pool.query<{ root_path: string }>(
    `SELECT root_path FROM storage_volumes WHERE kind = 'root' AND removed_at IS NULL AND root_path IS NOT NULL`,
  );
  const samples = [];
  for (const root of [DATA_DIR, ...extra.rows.map((r) => r.root_path)]) {
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    // A RAW first: Lifer never writes into one, so its size is the most stable.
    const candidates = await pool.query<{ ref: string }>(
      `SELECT ref FROM originals WHERE user_id = $1 AND starts_with(ref, $2) AND NOT stale
       ORDER BY (kind = 'raw') DESC LIMIT 5`,
      [userId, prefix],
    );
    for (const { ref } of candidates.rows) {
      const st = await stat(ref).catch(() => null);
      if (!st?.isFile()) continue;
      samples.push({ root, relativePath: path.relative(root, ref), size: st.size });
      break;
    }
  }
  return samples;
}

interface OriginalRow {
  ref: string;
  volume_id: string | null;
  volume_relative_path: string | null;
}

// Every original records its owner, so species-scoped RAWs (no capture) and the files of a
// trashed or hidden capture are found the same way.
const OWNED_ORIGINAL_SELECT = `SELECT o.ref, o.volume_id, o.volume_relative_path
  FROM originals o
  WHERE o.user_id = $2`;

export async function originalsRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  // Downloads an original by its own id, which covers capture-less species-scoped RAWs.
  // resolveOriginalPath lets a file on a remounted drive still resolve.
  app.get(
    "/originals/:id/download",
    { preValidation: requireAuth, config: notFoundOnInvalidId("Not found"), schema: { params: IdParams } },
    async (request, reply) => {
      const res = await pool.query<OriginalRow>(`${OWNED_ORIGINAL_SELECT} AND o.id = $1`, [
        request.params.id,
        request.user!.id,
      ]);
      const original = res.rows[0];
      if (!original) return reply.code(404).send({ error: "Not found" });
      const resolved = await resolveOriginalPath(original);
      if (!resolved.connected) {
        return reply
          .code(409)
          .send({ error: "This file's drive isn't connected right now", volumeLabel: resolved.volumeLabel });
      }
      if (!resolved.path || !existsSync(resolved.path)) return reply.code(404).send({ error: "Not found" });
      reply.header("Content-Disposition", contentDisposition(path.basename(resolved.path)));
      return reply.send(createReadStream(resolved.path));
    },
  );

  // Also read by the desktop app itself, with its sync key, so a page can't choose what it probes.
  app.get(
    "/originals/reveal-samples",
    { preValidation: requireScope("sync"), schema: { response: replies(RevealSamplesBody) } },
    async (request) => ({ roots: await revealSamples(request.user!.id) }),
  );

  app.get(
    "/originals/health",
    { preValidation: requireAuth, schema: { response: replies(HealthSummaryBody) } },
    async (request) => healthSummary(request.user!.id),
  );

  // Install-wide, like the pass itself.
  app.put(
    "/originals/health",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false }),
        response: replies(Ok),
      },
    },
    async (request) => {
      await setArchiveHealthEnabled(request.body.enabled);
      return { ok: true };
    },
  );

  app.get(
    "/originals/health/problems",
    { preValidation: requireAuth, schema: { response: replies(HealthProblemsBody) } },
    async (request) => listHealthProblems(request.user!.id),
  );

  app.post(
    "/originals/health/ignore-all",
    { preValidation: requireAuth, schema: { response: replies(Type.Object({ ignored: Type.Number() })) } },
    async (request) => ({ ignored: await ignoreAllHealthProblems(request.user!.id) }),
  );

  app.post(
    "/originals/:id/health/ignore",
    {
      preValidation: requireAuth,
      config: notFoundOnInvalidId("Not found"),
      schema: { params: IdParams, response: replies(Ok) },
    },
    async (request, reply) => {
      if (!(await ignoreHealthProblem(request.user!.id, request.params.id)))
        return reply.code(404).send({ error: "Not found" });
      return { ok: true };
    },
  );

  // Where the files of these photos are on this computer, the RAW when there is one, for "Open in"
  // an editor. Desktop only, like Reveal: the paths mean nothing on a server.
  app.post(
    "/originals/editor-paths",
    {
      preValidation: [requireAuth, desktopOnly],
      schema: {
        body: Type.Object(
          { captureIds: Type.Array(Type.String({ format: "uuid" }), { minItems: 1, maxItems: 200 }) },
          { additionalProperties: false },
        ),
        response: replies(Type.Object({ paths: Type.Array(Type.String()) })),
      },
    },
    async (request) => {
      const res = await pool.query<OriginalRow>(
        `SELECT DISTINCT ON (c.id) o.ref, o.volume_id, o.volume_relative_path
         FROM captures_all c
         JOIN originals o ON o.capture_id = c.id AND o.kind IN ('raw', 'jpeg')
         WHERE c.id = ANY($1::uuid[]) AND c.user_id = $2
         ORDER BY c.id, (o.kind = 'raw') DESC`,
        [request.body.captureIds, request.user!.id],
      );
      const paths: string[] = [];
      for (const row of res.rows) {
        const resolved = await resolveOriginalPath(row);
        if (resolved.connected && resolved.path && existsSync(resolved.path)) paths.push(resolved.path);
      }
      return { paths };
    },
  );

  app.post(
    "/originals/reveal",
    {
      // Shells out on the API's machine, which is only the user's own screen on desktop. A server
      // says so before it looks at the body.
      preValidation: [requireAuth, desktopOnly],
      schema: {
        body: Type.Object({ path: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
        response: {
          ...replies(Ok),
          409: Open({ error: Type.String(), volumeLabel: Type.Optional(Nullable(Type.String())) }),
        },
      },
    },
    async (request, reply) => {
      const { path: filePath } = request.body;

      // Ownership check first, or any user could open an arbitrary host path.
      const res = await pool.query<OriginalRow>(`${OWNED_ORIGINAL_SELECT} AND o.ref = $1 LIMIT 1`, [
        filePath,
        request.user!.id,
      ]);
      const original = res.rows[0];
      if (!original) return reply.code(403).send({ error: "Not your file" });

      const resolved = await resolveOriginalPath(original);
      if (!resolved.connected || !resolved.path) {
        return reply
          .code(409)
          .send({ error: "This file's drive isn't connected right now", volumeLabel: resolved.volumeLabel });
      }
      await revealFile(resolved.path);
      return { ok: true };
    },
  );
}
