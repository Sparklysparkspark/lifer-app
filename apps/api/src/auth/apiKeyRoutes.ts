// Key management is session-auth only (requireAuth, never requireScope), so a key can't mint or revoke keys.
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { isUuid } from "../lib/validate.js";
import { requireAuth } from "./session.js";
import { generateApiKey, hashApiKey } from "./apiKeys.js";

// The enforceable scopes, shared with ApiKeysPage.tsx. See requireScope's call sites for where each is checked.
export const API_KEY_SCOPES = [
  "gallery.read",
  "species.read",
  "stats.read",
  "trips.read",
  "album.read",
  "album.write",
  "share.read",
  "share.write",
  // Integrations (docs/API.md): the photo feed and image files; imports and photo edits; the life list.
  "photos.read",
  "photos.write",
  "collection.read",
] as const;

interface CreateApiKeyBody {
  name?: string;
  permissions?: string[];
}

export async function apiKeyRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api-keys", { preHandler: requireAuth }, async (request) => {
    const res = await pool.query(
      `SELECT id, name, permissions, last_used_at, created_at FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
      [request.user!.id],
    );
    return {
      keys: res.rows.map((r) => ({
        id: r.id,
        name: r.name,
        permissions: r.permissions,
        lastUsedAt: r.last_used_at,
        createdAt: r.created_at,
      })),
    };
  });

  app.post<{ Body: CreateApiKeyBody }>("/api-keys", { preHandler: requireAuth }, async (request, reply) => {
    const name = request.body?.name?.trim();
    const permissions = (request.body?.permissions ?? []).filter((p) => (API_KEY_SCOPES as readonly string[]).includes(p));
    if (!name) return reply.code(400).send({ error: "name is required" });
    if (permissions.length === 0) return reply.code(400).send({ error: "At least one permission is required" });

    const token = generateApiKey();
    const res = await pool.query(
      `INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES ($1, $2, $3, $4)
       RETURNING id, name, permissions, created_at`,
      [request.user!.id, name, hashApiKey(token), permissions],
    );
    const r = res.rows[0];
    // The only time the raw token is returned; only its hash is stored.
    return { id: r.id, name: r.name, permissions: r.permissions, createdAt: r.created_at, token };
  });

  app.delete<{ Params: { id: string } }>("/api-keys/:id", { preHandler: requireAuth }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(404).send({ error: "Key not found" });
    const res = await pool.query(`DELETE FROM api_keys WHERE id = $1 AND user_id = $2`, [request.params.id, request.user!.id]);
    if (res.rowCount === 0) return reply.code(404).send({ error: "Key not found" });
    return { ok: true };
  });
}
