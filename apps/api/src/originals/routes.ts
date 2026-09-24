import { existsSync, createReadStream } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireAuth } from "../auth/session.js";
import { revealFile } from "./browse.js";
import { resolveOriginalPath } from "../storageVolumes/resolve.js";
import { contentDisposition } from "../lib/httpFile.js";

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
  // Downloads any original the requesting user owns, keyed by its own id rather than
  // needing a capture (unlike /photos/:id/original[-raw], which resolves through
  // photos -> captures) — covers species-scoped unmatched RAWs, which are capture-less by
  // definition. Goes through resolveOriginalPath so a file on a remounted drive still resolves.
  app.get<{ Params: { id: string } }>("/originals/:id/download", { preHandler: requireAuth }, async (request, reply) => {
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
    const { path: filePath } = request.body ?? {};
    if (!filePath) return reply.code(400).send({ error: "path is required" });

    // Ownership check before shelling out — without it, any authenticated user could get
    // this API process to pop Finder on an arbitrary host path.
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
