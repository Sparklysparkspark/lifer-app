// Key management is session-auth only (requireAuth, never requireScope), so a key can't mint or revoke keys.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { IdParams, Ok, notFoundOnInvalidId, replies, withSchemas } from "../lib/schema.js";
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
  // Integrations (docs/docs/api/overview.md): the photo feed and image files; imports and photo edits; the life list
  // and the species you added to checklists yourself.
  "photos.read",
  "photos.write",
  "collection.read",
  "collection.write",
] as const;

export async function apiKeyRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.get("/api-keys", { preValidation: requireAuth, schema: {} }, async (request) => {
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

  app.post(
    "/api-keys",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          {
            name: Type.String(),
            // An unknown scope is refused rather than dropped, so a key never has less than asked for.
            permissions: Type.Array(Type.Enum(API_KEY_SCOPES), { minItems: 1 }),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const name = request.body.name.trim();
      const permissions = [...new Set(request.body.permissions)];
      if (!name) return reply.code(400).send({ error: "name is required" });

      const token = generateApiKey();
      const res = await pool.query(
        `INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES ($1, $2, $3, $4)
         RETURNING id, name, permissions, created_at`,
        [request.user!.id, name, hashApiKey(token), permissions],
      );
      const r = res.rows[0];
      // The only time the raw token is returned; only its hash is stored.
      return { id: r.id, name: r.name, permissions: r.permissions, createdAt: r.created_at, token };
    },
  );

  app.delete(
    "/api-keys/:id",
    {
      preValidation: requireAuth,
      config: notFoundOnInvalidId("Key not found"),
      schema: { params: IdParams, response: replies(Ok) },
    },
    async (request, reply) => {
      const res = await pool.query(`DELETE FROM api_keys WHERE id = $1 AND user_id = $2`, [
        request.params.id,
        request.user!.id,
      ]);
      if (res.rowCount === 0) return reply.code(404).send({ error: "Key not found" });
      return { ok: true };
    },
  );
}
