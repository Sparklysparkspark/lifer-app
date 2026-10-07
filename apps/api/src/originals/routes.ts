import { existsSync, createReadStream } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { IdParams, notFoundOnInvalidId, withSchemas } from "../lib/schema.js";
import { requireAuth } from "../auth/session.js";
import { revealFile } from "./browse.js";
import { resolveOriginalPath } from "../storageVolumes/resolve.js";
import { contentDisposition } from "../lib/httpFile.js";
import { desktopOnly } from "../settings/requireDesktopMode.js";

interface OriginalRow {
  ref: string;
  ref_type: string;
  volume_id: string | null;
  volume_relative_path: string | null;
}

// Owned via the capture when there is one, else via originals.user_id (species-scoped RAWs
// have no capture).
const OWNED_ORIGINAL_SELECT = `SELECT o.ref, o.ref_type, o.volume_id, o.volume_relative_path
  FROM originals o
  LEFT JOIN captures c ON c.id = o.capture_id
  WHERE COALESCE(c.user_id, o.user_id) = $2`;

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
      if (!original || original.ref_type !== "path") return reply.code(404).send({ error: "Not found" });
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

  app.post(
    "/originals/reveal",
    {
      // Shells out on the API's machine, which is only the user's own screen on desktop. A server
      // says so before it looks at the body.
      preValidation: [requireAuth, desktopOnly],
      schema: {
        body: Type.Object({ path: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
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
