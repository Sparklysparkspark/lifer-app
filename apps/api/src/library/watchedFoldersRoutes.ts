// Settings > Library: the folders Lifer watches for new photos. Desktop only; a server watches
// its own library root.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { SINGLE_USER_MODE } from "@lifer/core/config.js";
import { assertAllowedPath, isDirectory } from "@lifer/core/lib/allowedPaths.js";
import { requireAuth } from "../auth/session.js";
import { Ok, replies, withSchemas } from "../lib/schema.js";
import { listWatchedFolders, saveWatchedFolders } from "./watchedFolders.js";

const Folder = Type.Object({ path: Type.String(), enabled: Type.Boolean(), available: Type.Boolean() });
const PathBody = Type.Object({ path: Type.String({ minLength: 1 }) }, { additionalProperties: false });

export async function watchedFoldersRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  const desktopOnly = (reply: { code(n: number): { send(b: unknown): unknown } }) =>
    SINGLE_USER_MODE ? null : reply.code(404).send({ error: "Not found" });

  app.get(
    "/library/watched-folders",
    { preValidation: requireAuth, schema: { response: replies(Type.Object({ folders: Type.Array(Folder) })) } },
    async (_request, reply) => {
      if (!SINGLE_USER_MODE) return reply.code(404).send({ error: "Not found" });
      const folders = await listWatchedFolders();
      return {
        folders: await Promise.all(
          folders.map(async (f) => ({ path: f.path, enabled: f.enabled, available: await isDirectory(f.path) })),
        ),
      };
    },
  );

  app.post(
    "/library/watched-folders",
    { preValidation: requireAuth, schema: { body: PathBody, response: replies(Ok) } },
    async (request, reply) => {
      if (desktopOnly(reply)) return reply;
      const { path: raw } = request.body;
      if (!(await isDirectory(raw))) return reply.code(400).send({ error: "That folder doesn't exist" });
      const folder = assertAllowedPath(raw);
      const folders = await listWatchedFolders();
      if (!folders.some((f) => f.path === folder))
        await saveWatchedFolders([
          ...folders,
          { path: folder, enabled: true, userId: request.user!.id, signature: null },
        ]);
      return { ok: true };
    },
  );

  app.patch(
    "/library/watched-folders",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          { path: Type.String({ minLength: 1 }), enabled: Type.Boolean() },
          { additionalProperties: false },
        ),
        response: replies(Ok),
      },
    },
    async (request, reply) => {
      if (desktopOnly(reply)) return reply;
      const { path: target, enabled } = request.body;
      const folders = await listWatchedFolders();
      if (!folders.some((f) => f.path === target)) return reply.code(404).send({ error: "Not found" });
      await saveWatchedFolders(folders.map((f) => (f.path === target ? { ...f, enabled } : f)));
      return { ok: true };
    },
  );

  app.post(
    "/library/watched-folders/remove",
    { preValidation: requireAuth, schema: { body: PathBody, response: replies(Ok) } },
    async (request, reply) => {
      if (desktopOnly(reply)) return reply;
      const folders = await listWatchedFolders();
      await saveWatchedFolders(folders.filter((f) => f.path !== request.body.path));
      return { ok: true };
    },
  );
}
