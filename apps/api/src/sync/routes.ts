// Keeping a desktop install and its linked server in step. Two sides:
//   - on any install, the sync key's routes a linked desktop app reads (changes, user species);
//   - on the desktop only, the jobs the shell drives after the window signs in to the server
//     (apps/desktop/src-tauri/src/sync.rs): packs reconcile, the mirror pull.
import { changesForDevice, spotsForDevice } from "../companion/privacy.js";
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool, withTransaction } from "@lifer/core/db.js";
import { getOrCreateLocalUser, requireAuth, requireScope } from "../auth/session.js";
import { Nullable, Ok, Open, replies, Uuid, withSchemas } from "../lib/schema.js";
import { hashApiKey } from "../auth/apiKeys.js";
import { isRateLimited, recordAttempt } from "../auth/rateLimiter.js";
import { linkProof, linkSecret } from "./linkProof.js";
import { desktopOnly } from "../settings/requireDesktopMode.js";
import { PackId, startPackDownload } from "../offlinePacks/download.js";
import { AnyJobStatus } from "../settings/responses.js";
import { packSyncJob, startPackSync } from "./packs.js";
import { linkedServer, readServerLink } from "./serverLink.js";
import {
  captureFields,
  ChangesPageSchema,
  FIRST_CURSOR,
  listChanges,
  listUserSpecies,
  UserSpeciesListSchema,
  UserSpeciesSchema,
} from "./changes.js";
import {
  adoptServer,
  DERIVATIVE_KEY,
  forgetMirrorCursor,
  mirrorJob,
  pendingServer,
  startMirrorPull,
  type MirrorDerivative,
} from "./mirror.js";
import {
  applyPushedCaptureDeletions,
  applyPushedCaptures,
  applyPushedUserSpecies,
  PushReplySchema,
} from "./pushServer.js";
import { pushJob, startPush, waitingCounts } from "./push.js";
import {
  AlbumPageSchema,
  applyPushedLibrary,
  DeletedRowSchema,
  FIRST_LIBRARY_CURSOR,
  KeptPageSchema,
  listLibraryChanges,
  MemberPageSchema,
  PushedAlbumSchema,
  PushedMemberSchema,
  PushedTripSchema,
  PushedSpotSchema,
  TripPageSchema,
  SpotPageSchema,
  type EntityName,
} from "./library.js";
import { getInstallSetting, setInstallSetting } from "../lib/installSettings.js";

const Derivative = Type.Union([Type.Literal("thumb"), Type.Literal("medium")]);
const SyncStatus = Open({
  linked: Type.Boolean({ description: "Whether the shell has recorded a server link" }),
  serverUrl: Nullable(Type.String({ description: "The link's first address" })),
  unpushed: Type.Integer({
    description: "Captures and species marks changed here that the server doesn't have yet, and deletions not sent yet",
  }),
  serverChanged: Type.Boolean({
    description:
      "The link points at a server this install hasn't synced with: waiting for the user to confirm starting over",
  }),
  waiting: Type.Object({
    photos: Type.Integer({ description: "Photos, species marks and deletions of them" }),
    albums: Type.Integer({ description: "Albums with their photos, and deletions" }),
    trips: Type.Integer({ description: "Trips and deletions" }),
  }),
  derivative: Derivative,
  packs: AnyJobStatus,
  mirror: AnyJobStatus,
  push: AnyJobStatus,
});
// Every field is required: the server writes each one as sent, so a missing one would clear it.
// Extra fields are let through so a newer desktop can still push to this server.
const PushedCaptureBody = Type.Object({
  ...captureFields,
  lat: Nullable(Type.Number({ minimum: -90, maximum: 90 })),
  lon: Nullable(Type.Number({ minimum: -180, maximum: 180 })),
  /** The server's updated_at the desktop last had (pushServer.ts), null if it never had one. */
  baseUpdatedAt: Nullable(Type.String({ format: "date-time" })),
});
const PushBody = Type.Object(
  {
    captures: Type.Array(PushedCaptureBody, { maxItems: 500 }),
    albums: Type.Optional(Type.Array(PushedAlbumSchema, { maxItems: 500 })),
    trips: Type.Optional(Type.Array(PushedTripSchema, { maxItems: 500 })),
    savedSpots: Type.Optional(Type.Array(PushedSpotSchema, { maxItems: 500 })),
    albumCaptures: Type.Optional(Type.Array(PushedMemberSchema, { maxItems: 5000 })),
    albumExclusions: Type.Optional(Type.Array(PushedMemberSchema, { maxItems: 5000 })),
    /** Photos whose old species the user kept after a split, by the server's capture id. */
    speciesSplitKept: Type.Optional(Type.Array(Uuid(), { maxItems: 5000 })),
    userSpecies: Type.Optional(
      Type.Array(
        Type.Object({
          ...UserSpeciesSchema.properties,
          baseUpdatedAt: Type.Optional(Nullable(Type.String({ format: "date-time" }))),
        }),
        { maxItems: 20000 },
      ),
    ),
    deleted: Type.Optional(
      Type.Object(
        {
          captures: Type.Optional(
            Type.Array(Type.Object({ id: Uuid(), baseUpdatedAt: Nullable(Type.String({ format: "date-time" })) }), {
              maxItems: 1000,
            }),
          ),
          userSpecies: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 20000 })),
          albums: Type.Optional(Type.Array(DeletedRowSchema, { maxItems: 1000 })),
          trips: Type.Optional(Type.Array(DeletedRowSchema, { maxItems: 1000 })),
          savedSpots: Type.Optional(Type.Array(DeletedRowSchema, { maxItems: 1000 })),
          albumCaptures: Type.Optional(Type.Array(PushedMemberSchema, { maxItems: 5000 })),
          albumExclusions: Type.Optional(Type.Array(PushedMemberSchema, { maxItems: 5000 })),
          speciesSplitKept: Type.Optional(Type.Array(Uuid(), { maxItems: 5000 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const PHONE_FEEDS = { albumCaptures: "phoneAlbumCaptures", albumExclusions: "phoneAlbumExclusions" };

export async function syncRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  // --- Read by a linked desktop app (its key has the "sync" scope) ---
  app.get(
    "/sync/changes",
    {
      preValidation: requireScope("sync", ["companion"]),
      schema: {
        querystring: Type.Object(
          {
            since: Type.Optional(Type.String({ format: "date-time" })),
            after: Type.Optional(Type.String({ format: "uuid" })),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 200 })),
          },
          { additionalProperties: false },
        ),
        response: replies(ChangesPageSchema),
      },
    },
    async (request) => {
      const { since, after, limit } = request.query;
      const cursor = { since: since ?? FIRST_CURSOR.since, after: after ?? FIRST_CURSOR.after };
      const page = await listChanges(pool, request.user!.id, cursor, limit ?? 200);
      return request.deviceKey ? { ...page, items: await changesForDevice(request.user!.id, page.items) } : page;
    },
  );

  app.get(
    "/sync/user-species",
    { preValidation: requireScope("sync", ["companion"]), schema: { response: replies(UserSpeciesListSchema) } },
    async (request) => {
      return { items: await listUserSpecies(pool, request.user!.id) };
    },
  );

  // Albums, trips and their membership, one feed each: same cursor rule as /sync/changes, with the
  // row's ref (an id, or "albumId:captureId") as the tie-break.
  const libraryFeeds: [
    string,
    EntityName,
    | typeof AlbumPageSchema
    | typeof TripPageSchema
    | typeof MemberPageSchema
    | typeof SpotPageSchema
    | typeof KeptPageSchema,
  ][] = [
    ["/sync/albums", "albums", AlbumPageSchema],
    ["/sync/trips", "trips", TripPageSchema],
    ["/sync/saved-spots", "savedSpots", SpotPageSchema],
    ["/sync/album-captures", "albumCaptures", MemberPageSchema],
    ["/sync/album-exclusions", "albumExclusions", MemberPageSchema],
    ["/sync/species-split-kept", "speciesSplitKept", KeptPageSchema],
  ];
  for (const [url, name, page] of libraryFeeds) {
    app.get(
      url,
      {
        // Phones don't keep split choices, so that feed is for linked desktops only.
        preValidation: name === "speciesSplitKept" ? requireScope("sync") : requireScope("sync", ["companion"]),
        schema: {
          querystring: Type.Object(
            {
              since: Type.Optional(Type.String({ format: "date-time" })),
              after: Type.Optional(Type.String({ maxLength: 100 })),
              limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 200 })),
            },
            { additionalProperties: false },
          ),
          response: replies(page),
        },
      },
      async (request) => {
        const { since, after, limit } = request.query;
        const cursor = { since: since ?? FIRST_LIBRARY_CURSOR.since, after: after ?? FIRST_LIBRARY_CURSOR.after };
        const own = request.deviceKey ? (PHONE_FEEDS as Partial<Record<EntityName, EntityName>>)[name] : undefined;
        const page = await listLibraryChanges(pool, request.user!.id, own ?? name, cursor, limit ?? 200);
        if (request.deviceKey && name === "savedSpots") {
          return spotsForDevice(page as Parameters<typeof spotsForDevice>[0]) as never;
        }
        return page as never;
      },
    );
  }

  // The server proves itself to a linked desktop app before the app sends its key (linkProof.ts).
  // No sign-in: the app has no session here, and the answer reveals nothing without the secret.
  app.get(
    "/sync/link/proof",
    {
      schema: {
        querystring: Type.Object(
          { keyId: Uuid(), nonce: Type.String({ minLength: 16, maxLength: 200 }) },
          { additionalProperties: false },
        ),
        response: replies(Open({ proof: Type.String() })),
      },
    },
    async (request, reply) => {
      const limitKey = `link-proof:${request.ip}`;
      if (isRateLimited(limitKey, 120, 60_000)) return reply.code(429).send({ error: "Too many requests" });
      recordAttempt(limitKey);
      const { keyId, nonce } = request.query;
      const known = await pool.query(`SELECT 1 FROM api_keys WHERE id = $1 AND 'sync' = ANY(permissions)`, [keyId]);
      if (known.rowCount === 0) return reply.code(404).send({ error: "Link not found" });
      return { proof: linkProof(await linkSecret(pool, keyId), nonce) };
    },
  );

  // A desktop app that switches to another server revokes its old key here, with that key: it
  // has no signed-in session on the old server to do it from Settings. Only a sync key, only itself.
  app.post(
    "/sync/link/revoke",
    { preValidation: requireScope("sync"), schema: { response: replies(Ok) } },
    async (request, reply) => {
      const token = request.headers["x-api-key"];
      if (typeof token !== "string" || !token)
        return reply.code(400).send({ error: "Send the key to revoke in x-api-key" });
      const res = await pool.query(
        `DELETE FROM api_keys WHERE key_hash = $1 AND user_id = $2 AND 'sync' = ANY(permissions)`,
        [hashApiKey(token), request.user!.id],
      );
      if (res.rowCount === 0) return reply.code(404).send({ error: "Key not found" });
      return { ok: true };
    },
  );

  app.post(
    "/sync/push",
    { preValidation: requireScope("sync"), schema: { body: PushBody, response: replies(PushReplySchema) } },
    async (request) => {
      const userId = request.user!.id;
      const { captures, userSpecies = [], deleted = {} } = request.body;
      return withTransaction(async (client) => {
        // Deletions first: a photo deleted on the desktop and imported again isn't its old copy.
        const trashed = await applyPushedCaptureDeletions(client, userId, deleted.captures ?? []);
        const pushed = await applyPushedCaptures(client, userId, captures);
        const marks = await applyPushedUserSpecies(client, userId, userSpecies, deleted.userSpecies ?? []);
        // Albums and trips before captures' trip links and membership, which refer to them.
        const library = await applyPushedLibrary(client, userId, request.body, deleted);
        return {
          ...pushed,
          userSpecies: marks.count,
          userSpeciesStamps: marks.stamps,
          userSpeciesConflicts: marks.conflicts,
          deleted: trashed,
          library,
        };
      });
    },
  );

  // --- Desktop only: the jobs the shell drives ---
  const guard = [requireAuth, desktopOnly];

  app.get("/sync/status", { preValidation: guard, schema: { response: replies(SyncStatus) } }, async () => {
    const link = readServerLink();
    const waiting = await waitingCounts((await getOrCreateLocalUser()).id);
    return {
      linked: link !== null,
      serverUrl: link?.urls[0] ?? null,
      waiting,
      unpushed: waiting.photos + waiting.albums + waiting.trips,
      serverChanged: (await pendingServer(pool)) !== null,
      derivative: ((await getInstallSetting<string>(pool, DERIVATIVE_KEY)) as MirrorDerivative | null) ?? "thumb",
      packs: packSyncJob.status,
      mirror: mirrorJob.status,
      push: pushJob.status,
    };
  });

  // Which copy of each photo the mirror keeps here. A change restarts the pull from the beginning
  // so existing captures get the new copy; files already here aren't fetched again.
  app.post(
    "/sync/settings",
    {
      preValidation: guard,
      schema: {
        body: Type.Object({ derivative: Derivative }, { additionalProperties: false }),
        response: replies(Open({ ok: Type.Boolean() })),
      },
    },
    async (request) => {
      await withTransaction(async (client) => {
        const before = (await getInstallSetting<string>(client, DERIVATIVE_KEY)) ?? "thumb";
        await setInstallSetting(client, DERIVATIVE_KEY, request.body.derivative);
        if (before !== request.body.derivative) await forgetMirrorCursor(client);
      });
      return { ok: true };
    },
  );

  app.post(
    "/sync/packs/reconcile",
    { preValidation: guard, schema: { response: replies(Open({ started: Type.Boolean() })) } },
    async (_request, reply) => {
      if (!readServerLink()) return reply.code(409).send({ error: "This app isn't linked to a server" });
      return { started: startPackSync() };
    },
  );

  // Downloads packs the server has onto this computer, once the user says yes.
  app.post(
    "/sync/packs/pull",
    {
      preValidation: guard,
      schema: {
        body: Type.Object(
          { packIds: Type.Array(PackId, { minItems: 1, maxItems: 100 }) },
          { additionalProperties: false },
        ),
        response: replies(Open({ started: Type.Boolean() })),
      },
    },
    async (request, reply) => {
      if (!startPackDownload(request.body.packIds)) {
        return reply.code(409).send({ error: "A region download is already in progress" });
      }
      return { started: true };
    },
  );

  // The user's answer to "this server looks new": send this library to it again from the start.
  app.post("/sync/adopt", { preValidation: guard, schema: { response: replies(Ok) } }, async (_request, reply) => {
    const server = await linkedServer();
    if (!server) return reply.code(409).send({ error: "The linked server didn't answer" });
    await adoptServer((await getOrCreateLocalUser()).id, server.instanceId, true);
    return { ok: true };
  });

  app.post(
    "/sync/push/start",
    { preValidation: guard, schema: { response: replies(Open({ started: Type.Boolean() })) } },
    async (_request, reply) => {
      if (!readServerLink()) return reply.code(409).send({ error: "This app isn't linked to a server" });
      return { started: startPush() };
    },
  );

  app.post(
    "/sync/pull",
    { preValidation: guard, schema: { response: replies(Open({ started: Type.Boolean() })) } },
    async (_request, reply) => {
      if (!readServerLink()) return reply.code(409).send({ error: "This app isn't linked to a server" });
      return { started: startMirrorPull() };
    },
  );
}
