// Send keywords to Apple Photos: Mac desktop app only, since it scripts the Photos app on the same
// Mac. A server or a Windows or Linux desktop answers "not available" and the menus stay hidden.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { SINGLE_USER_MODE } from "@lifer/core/config.js";
import { requireAuth } from "../../auth/session.js";
import { Nullable, Open, Uuid, jobStatusFields, replies, withSchemas } from "../../lib/schema.js";
import { albumItemRows } from "../../albums/routes.js";
import { SEND_IDLE, applePhotosJob, runApplePhotos } from "./send.js";

export const applePhotosAvailable = () => SINGLE_USER_MODE && process.platform === "darwin";

const MAX_PHOTOS = 20_000;

const SendStatus = Open({
  ...jobStatusFields(Type.Unknown()),
  mode: Nullable(Type.Enum(["check", "send"])),
  photos: Type.Integer(),
  found: Type.Integer(),
  notFound: Type.Integer(),
  added: Type.Integer(),
  unchanged: Type.Integer(),
  failed: Type.Integer(),
  problem: Nullable(Type.Enum(["automation_denied", "photos_unavailable"])),
});

export async function applePhotosRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  const unavailable = { error: "Only available in the Lifer app on a Mac", code: "desktop_only" };

  app.get(
    "/apple-photos/status",
    { preValidation: requireAuth, schema: { response: replies(Type.Object({ available: Type.Boolean() })) } },
    async () => ({ available: applePhotosAvailable() }),
  );

  // "check" finds the photos in Photos and counts them, changing nothing; "send" adds keywords.
  app.post(
    "/apple-photos/send",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          {
            mode: Type.Enum(["check", "send"]),
            captureIds: Type.Optional(Type.Array(Uuid(), { maxItems: MAX_PHOTOS })),
            albumId: Type.Optional(Uuid()),
          },
          { additionalProperties: false },
        ),
        response: replies(Type.Object({ started: Type.Boolean() })),
      },
    },
    async (request, reply) => {
      if (!applePhotosAvailable()) return reply.code(404).send(unavailable);
      const userId = request.user!.id;
      const { mode, albumId } = request.body;
      let ids = request.body.captureIds ?? [];
      if (albumId) {
        const rows = await albumItemRows(albumId, userId).catch(() => null);
        if (!rows) return reply.code(404).send({ error: "Album not found" });
        ids = rows.map((r) => r.capture_id as string).slice(0, MAX_PHOTOS);
      }
      if (ids.length === 0) return reply.code(400).send({ error: "Choose some photos first" });
      if (!applePhotosJob.start((ctx) => runApplePhotos(ctx, userId, ids, mode), { ...SEND_IDLE, mode }))
        return reply.code(409).send({ error: "Keywords are already being sent to Photos" });
      return { started: true };
    },
  );

  app.get(
    "/apple-photos/send/status",
    { preValidation: requireAuth, schema: { response: replies(SendStatus) } },
    async () => applePhotosJob.status,
  );

  app.post(
    "/apple-photos/send/cancel",
    { preValidation: requireAuth, schema: { response: replies(Type.Object({ cancelled: Type.Boolean() })) } },
    async () => ({ cancelled: applePhotosJob.cancel() }),
  );
}
