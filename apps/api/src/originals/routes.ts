import { existsSync, createReadStream } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { isUuid } from "../lib/validate.js";
import { requireAuth } from "../auth/session.js";
import { revealFile } from "./browse.js";
import { resolveOriginalPath } from "../storageVolumes/resolve.js";
import { contentDisposition } from "../lib/httpFile.js";
import { requireDesktopMode } from "../settings/requireDesktopMode.js";

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

export async function originalsRoutes(app: FastifyInstance): Promise<void> {
  // Downloads an original by its own id, which covers capture-less species-scoped RAWs.
  // resolveOriginalPath lets a file on a remounted drive still resolve.
  app.get<{ Params: { id: string } }>("/originals/:id/download", { preHandler: requireAuth }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(404).send({ error: "Not found" });
    const res = await pool.query<OriginalRow>(`${OWNED_ORIGINAL_SELECT} AND o.id = $1`, [request.params.id, request.user!.id]);
    const original = res.rows[0];
    if (!original || original.ref_type !== "path") return reply.code(404).send({ error: "Not found" });
    const resolved = await resolveOriginalPath(original);
    if (!resolved.connected) {
      return reply.code(409).send({ error: "This file's drive isn't connected right now", volumeLabel: resolved.volumeLabel });
    }
    if (!resolved.path || !existsSync(resolved.path)) return reply.code(404).send({ error: "Not found" });
    reply.header("Content-Disposition", contentDisposition(path.basename(resolved.path)));
    return reply.send(createReadStream(resolved.path));
  });

  app.post<{ Body: { path?: string } }>("/originals/reveal", { preHandler: requireAuth }, async (request, reply) => {
    // Shells out on the API's machine, which is only the user's own screen on desktop.
    if (!requireDesktopMode(reply)) return;
    const { path: filePath } = request.body ?? {};
    if (!filePath) return reply.code(400).send({ error: "path is required" });

    // Ownership check first, or any user could open an arbitrary host path.
    const res = await pool.query<OriginalRow>(`${OWNED_ORIGINAL_SELECT} AND o.ref = $1 LIMIT 1`, [filePath, request.user!.id]);
    const original = res.rows[0];
    if (!original) return reply.code(403).send({ error: "Not your file" });

    const resolved = await resolveOriginalPath(original);
    if (!resolved.connected || !resolved.path) {
      return reply.code(409).send({ error: "This file's drive isn't connected right now", volumeLabel: resolved.volumeLabel });
    }
    await revealFile(resolved.path);
    return { ok: true };
  });
}
