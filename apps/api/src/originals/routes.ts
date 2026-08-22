import { existsSync, createReadStream } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireAuth } from "../auth/session.js";
import { revealFile } from "./browse.js";

export async function originalsRoutes(app: FastifyInstance): Promise<void> {
  // Downloads any original the requesting user owns, keyed by its own id rather than
  // needing a capture (unlike /photos/:id/original[-raw], which resolves through
  // photos -> captures) — covers species-scoped unmatched RAWs, which are capture-less by
  // definition.
  app.get<{ Params: { id: string } }>("/originals/:id/download", { preHandler: requireAuth }, async (request, reply) => {
    const res = await pool.query<{ ref: string }>(`SELECT ref FROM originals WHERE id = $1 AND user_id = $2`, [
      request.params.id,
      request.user!.id,
    ]);
    const original = res.rows[0];
    if (!original || !existsSync(original.ref)) return reply.code(404).send({ error: "Not found" });
    reply.header("Content-Disposition", `attachment; filename="${path.basename(original.ref)}"`);
    return reply.send(createReadStream(original.ref));
  });

  app.post<{ Body: { path?: string } }>("/originals/reveal", { preHandler: requireAuth }, async (request, reply) => {
    const { path: filePath } = request.body ?? {};
    if (!filePath) return reply.code(400).send({ error: "path is required" });

    // Ownership check before shelling out — without it, any authenticated user could get
    // this API process to pop Finder on an arbitrary host path.
    const userId = request.user!.id;
    const ownershipRes = await pool.query(
      `SELECT 1 FROM originals o JOIN captures c ON c.id = o.capture_id WHERE o.ref = $1 AND c.user_id = $2`,
      [filePath, userId],
    );
    if (ownershipRes.rows.length === 0) return reply.code(403).send({ error: "Not your file" });

    await revealFile(filePath);
    return { ok: true };
  });
}
