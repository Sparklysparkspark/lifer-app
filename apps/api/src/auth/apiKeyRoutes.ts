// Key management is session-auth only (requireAuth, never requireScope), so a key can't mint or revoke keys.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { IdParams, Ok, notFoundOnInvalidId, replies, withSchemas } from "../lib/schema.js";
import { requireAuth } from "./session.js";
import { generateApiKey, hashApiKey } from "./apiKeys.js";
import { linkSecret } from "../sync/linkProof.js";
import { ApiKeyList, CreatedApiKey, DesktopLink } from "./responses.js";

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
  // Companion apps (docs/plans/plugin-host-and-integration-api.md): the user's own marks and photos
  // with no catalog data; a few marks on them (userdata/writeRoutes.ts); importing new photos;
  // reference vectors under open licences.
  "userdata.read",
  "userdata.write",
  "imports.write",
  "opendata.read",
  // A connected app's "open inside Lifer" preference and asking Lifer to open it (plugins/hostPreference.ts).
  // Not offered on the API keys page.
  "host.preference",
  // The desktop app's own key (POST /auth/desktop-link): the routes that keep a linked desktop
  // and this server in step. Not offered on the API keys page.
  "sync",
  // A paired phone's key (companion/devices.ts). Not offered on the API keys page.
  "companion",
] as const;

/** What a linked desktop app's key can do. One place, so the sync routes and the link agree. */
export const DESKTOP_LINK_SCOPES = ["sync", "species.read", "photos.read", "photos.write"] as const;

/** What a paired phone's key can do: only routes that accept `companion` by name, the phone list in
 *  the desktop listener (companion_listener.rs). No general scope, so it opens nothing else. */
export const DEVICE_KEY_SCOPES = ["companion"] as const;

export async function apiKeyRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.get("/api-keys", { preValidation: requireAuth, schema: { response: replies(ApiKeyList) } }, async (request) => {
    const res = await pool.query(
      `SELECT id, name, permissions, last_used_at, created_at, plugin_id FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
      [request.user!.id],
    );
    return {
      keys: res.rows.map((r) => ({
        id: r.id,
        name: r.name,
        permissions: r.permissions,
        lastUsedAt: r.last_used_at,
        createdAt: r.created_at,
        pluginId: r.plugin_id,
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
            name: Type.String({ maxLength: 200 }),
            // An unknown scope is refused rather than dropped, so a key never has less than asked for.
            permissions: Type.Array(Type.Enum(API_KEY_SCOPES), { minItems: 1 }),
          },
          { additionalProperties: false },
        ),
        response: replies(CreatedApiKey),
      },
    },
    async (request, reply) => {
      const name = request.body.name.trim();
      const permissions = [...new Set(request.body.permissions)];
      if (!name) return reply.code(400).send({ error: "name is required" });
      // Minted only by their own routes, so a phone or desktop key always has exactly its fixed scopes.
      if (permissions.some((p) => p === "sync" || p === "companion")) {
        return reply.code(400).send({ error: "That scope is given only by pairing a phone or linking a desktop app." });
      }

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

  // The desktop app, once signed in, trades its session for a key its local API can use to talk
  // to this server while the user is away from the window (packs, pushes, the mirror). Session
  // auth only, like key creation. Visible and revocable on the API keys page like any key.
  app.post(
    "/auth/desktop-link",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object({ name: Type.String({ maxLength: 200 }) }, { additionalProperties: false }),
        response: replies(DesktopLink),
      },
    },
    async (request) => {
      const name = request.body.name.trim() || "Desktop app";
      const token = generateApiKey();
      const res = await pool.query(
        `INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES ($1, $2, $3, $4)
         RETURNING id, name, permissions, created_at`,
        [request.user!.id, name, hashApiKey(token), [...DESKTOP_LINK_SCOPES]],
      );
      const r = res.rows[0];
      return {
        id: r.id,
        name: r.name,
        permissions: r.permissions,
        createdAt: r.created_at,
        token,
        linkSecret: await linkSecret(pool, r.id),
      };
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
