// Settings > Integrations > Immich, server only: link a server, pick albums, sync in the background.
// The desktop app answers 404 to all of it. Nothing is sent to Immich until the user links one.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { SINGLE_USER_MODE } from "@lifer/core/config.js";
import { requireAuth } from "../../auth/session.js";
import { Nullable, Ok, jobStatusFields, replies, withSchemas } from "../../lib/schema.js";
import {
  ImmichClient,
  ImmichError,
  MIN_IMMICH_VERSION,
  isSupportedVersion,
  normalizeServerUrl,
  versionText,
} from "./client.js";
import { loadLink, runSync, saveLink, syncJob } from "./sync.js";

async function serverOnly(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (SINGLE_USER_MODE) await reply.code(404).send({ error: "Immich is for a Lifer server", code: "server_only" });
}
const guard = { preValidation: [serverOnly, requireAuth] };

const SyncResult = Type.Object({
  imported: Type.Integer(),
  duplicates: Type.Integer(),
  unrecognized: Type.Integer(),
  skipped: Type.Integer(),
  failed: Type.Integer(),
  tagged: Type.Integer(),
});

const Status = Type.Object({
  linked: Type.Boolean(),
  serverUrl: Nullable(Type.String()),
  serverVersion: Nullable(Type.String()),
  albumIds: Type.Array(Type.String()),
  writeTags: Type.Boolean(),
  lastSyncAt: Nullable(Type.String({ description: "ISO 8601" })),
  lastError: Nullable(Type.String()),
  counts: Type.Object({
    imported: Type.Integer({ description: "Photos brought in, including ones already in Lifer" }),
    unrecognized: Type.Integer({ description: "Photos waiting for a species" }),
    skipped: Type.Integer({ description: "Videos and RAW files, not brought in" }),
  }),
});

const Album = Type.Object({ id: Type.String(), name: Type.String(), assetCount: Type.Integer() });

function immichFailure(reply: FastifyReply, err: unknown) {
  if (err instanceof ImmichError) return reply.code(502).send({ error: err.message, code: "immich_unreachable" });
  throw err;
}

export async function immichRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.get("/immich/status", { ...guard, schema: { response: replies(Status) } }, async (request) => {
    const userId = request.user!.id;
    const link = await loadLink(userId);
    const counts = await pool.query<{ imported: number; unrecognized: number; skipped: number }>(
      `SELECT count(*) FILTER (WHERE outcome IN ('imported', 'duplicate') AND capture_id IS NOT NULL)::int AS imported,
              count(*) FILTER (WHERE outcome = 'unrecognized')::int AS unrecognized,
              count(*) FILTER (WHERE outcome = 'skipped')::int AS skipped
         FROM immich_assets WHERE user_id = $1`,
      [userId],
    );
    return {
      linked: link !== null,
      serverUrl: link?.serverUrl ?? null,
      serverVersion: link?.serverVersion ?? null,
      albumIds: link?.albumIds ?? [],
      writeTags: link?.writeTags ?? false,
      lastSyncAt: link?.lastSyncAt?.toISOString() ?? null,
      lastError: link?.lastError ?? null,
      counts: counts.rows[0],
    };
  });

  app.get(
    "/immich/sync/status",
    { ...guard, schema: { response: replies(Type.Object(jobStatusFields(SyncResult))) } },
    async (request) => syncJob(request.user!.id).status,
  );

  // Checks the address, the key and the version before anything is saved.
  app.post(
    "/immich/link",
    {
      ...guard,
      schema: {
        body: Type.Object(
          {
            serverUrl: Type.String({ minLength: 1, maxLength: 2000 }),
            apiKey: Type.String({ minLength: 1, maxLength: 500 }),
          },
          { additionalProperties: false },
        ),
        response: replies(Type.Object({ serverVersion: Type.String() })),
      },
    },
    async (request, reply) => {
      const serverUrl = normalizeServerUrl(request.body.serverUrl);
      if (!serverUrl)
        return reply.code(400).send({ error: "Enter the address you open Immich at, like https://photos.example.com" });
      const client = new ImmichClient(serverUrl, request.body.apiKey.trim());
      try {
        const version = await client.version();
        if (!isSupportedVersion(version)) {
          return reply.code(400).send({
            error: `This Immich is version ${versionText(version)}. Update it to ${MIN_IMMICH_VERSION.join(".")} or newer to link it.`,
            code: "immich_too_old",
          });
        }
        await client.me();
        await saveLink(request.user!.id, {
          serverUrl,
          apiKey: request.body.apiKey.trim(),
          serverVersion: versionText(version),
        });
        return { serverVersion: versionText(version) };
      } catch (err) {
        return immichFailure(reply, err);
      }
    },
  );

  // Photos already brought in stay in Lifer; their link rows stay too, so linking again doesn't repeat them.
  app.delete("/immich/link", { ...guard, schema: { response: replies(Ok) } }, async (request, reply) => {
    if (syncJob(request.user!.id).status.running)
      return reply.code(409).send({ error: "Wait for the sync to finish." });
    await pool.query(`DELETE FROM immich_links WHERE user_id = $1`, [request.user!.id]);
    return { ok: true };
  });

  app.get("/immich/albums", { ...guard, schema: { response: replies(Type.Array(Album)) } }, async (request, reply) => {
    const link = await loadLink(request.user!.id);
    if (!link) return reply.code(404).send({ error: "Link an Immich server first." });
    try {
      const albums = await new ImmichClient(link.serverUrl, link.apiKey).albums();
      return albums
        .map((a) => ({ id: a.id, name: a.albumName, assetCount: a.assetCount }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      return immichFailure(reply, err);
    }
  });

  app.put(
    "/immich/settings",
    {
      ...guard,
      schema: {
        body: Type.Object(
          {
            albumIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 10000 })),
            writeTags: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
        response: replies(Ok),
      },
    },
    async (request, reply) => {
      const { albumIds, writeTags } = request.body;
      const res = await pool.query(
        `UPDATE immich_links SET album_ids = COALESCE($2, album_ids), write_tags = COALESCE($3, write_tags)
          WHERE user_id = $1`,
        [request.user!.id, albumIds ? [...new Set(albumIds)] : null, writeTags ?? null],
      );
      if (res.rowCount === 0) return reply.code(404).send({ error: "Link an Immich server first." });
      return { ok: true };
    },
  );

  app.post("/immich/sync", { ...guard, schema: { response: replies(Ok, 202) } }, async (request, reply) => {
    const userId = request.user!.id;
    const link = await loadLink(userId);
    if (!link) return reply.code(404).send({ error: "Link an Immich server first." });
    if (link.albumIds.length === 0) return reply.code(400).send({ error: "Choose at least one album first." });
    const job = syncJob(userId);
    if (!job.start((ctx) => runSync(userId, ctx))) return reply.code(409).send({ error: "A sync is already running." });
    return reply.code(202).send({ ok: true });
  });

  app.post("/immich/sync/cancel", { ...guard, schema: { response: replies(Ok) } }, async (request) => {
    return { ok: syncJob(request.user!.id).cancel() };
  });
}
