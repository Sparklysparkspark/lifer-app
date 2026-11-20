// Settings > Import > Lightroom Classic catalogue: read it into a preview, then apply the chosen
// kinds in the background. Desktop only: the catalogue is a file on the user's own computer.
import { existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { assertAllowedPath } from "@lifer/core/lib/allowedPaths.js";
import { log } from "@lifer/core/lib/log.js";
import { requireAuth } from "../../auth/session.js";
import { desktopOnly } from "../../settings/requireDesktopMode.js";
import { createJob } from "../../lib/job.js";
import { Nullable, Ok, Open, replies, withSchemas } from "../../lib/schema.js";
import { applyChangeSet, undoImport, undoSummary, type ApplyResult } from "./apply.js";
import { readCatalog } from "./catalog.js";
import { buildPreview, GROUPS, type Group, type Preview } from "./plan.js";
import type { ChangeSet } from "./types.js";

type Read = { path: string; preview: Preview };

const readJob = createJob<Read, { processed: number | null }>("lightroom-read", { processed: null });
const applyJob = createJob<ApplyResult, { processed: number | null }>("lightroom-apply", { processed: null });

// The last catalogue read, kept so Apply doesn't read it twice; dropped once applied.
let cached: { path: string; userId: string; changes: ChangeSet } | null = null;

const PathBody = Type.Object({ path: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const Job = Open({});

function catalogPath(raw: string): string | null {
  const file = assertAllowedPath(raw);
  return file.toLowerCase().endsWith(".lrcat") && existsSync(file) ? file : null;
}

export async function lightroomRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  const guard = { preValidation: [requireAuth, desktopOnly] };

  app.post(
    "/lightroom/preview",
    { ...guard, schema: { body: PathBody, response: replies(Ok) } },
    async (request, reply) => {
      const file = catalogPath(request.body.path);
      if (!file) return reply.code(400).send({ error: "Choose a Lightroom Classic catalogue (a .lrcat file)" });
      const userId = request.user!.id;
      const started = readJob.start(async (ctx) => {
        ctx.update({ phase: "reading" });
        const changes = await readCatalog(file, userId);
        cached = { path: file, userId, changes };
        return { path: file, preview: buildPreview(changes) };
      });
      if (!started) return reply.code(409).send({ error: "A catalogue is already being read" });
      return { ok: true };
    },
  );

  app.get("/lightroom/preview", { ...guard, schema: { response: replies(Job) } }, async () => readJob.status);

  app.post(
    "/lightroom/apply",
    {
      ...guard,
      schema: {
        body: Type.Object(
          {
            path: Type.String({ minLength: 1 }),
            groups: Type.Array(Type.Union(GROUPS.map((g) => Type.Literal(g)))),
            lightroomWins: Type.Boolean(),
          },
          { additionalProperties: false },
        ),
        response: replies(Ok),
      },
    },
    async (request, reply) => {
      const file = catalogPath(request.body.path);
      if (!file) return reply.code(400).send({ error: "Choose a Lightroom Classic catalogue (a .lrcat file)" });
      const userId = request.user!.id;
      const groups = new Set<Group>(request.body.groups);
      const started = applyJob.start(async (ctx) => {
        const changes =
          cached && cached.path === file && cached.userId === userId ? cached.changes : await readCatalog(file, userId);
        cached = null;
        return applyChangeSet(ctx, userId, changes, groups, request.body.lightroomWins);
      });
      if (!started) return reply.code(409).send({ error: "An import is already running" });
      return { ok: true };
    },
  );

  app.get("/lightroom/apply", { ...guard, schema: { response: replies(Job) } }, async () => applyJob.status);

  app.get(
    "/lightroom/undo",
    {
      ...guard,
      schema: {
        response: replies(
          Type.Object({
            last: Nullable(Type.Object({ createdAt: Type.String(), photos: Type.Integer(), albums: Type.Integer() })),
          }),
        ),
      },
    },
    async (request) => ({ last: await undoSummary(request.user!.id) }),
  );

  app.post("/lightroom/undo", { ...guard, schema: { response: replies(Ok) } }, async (request, reply) => {
    if (applyJob.status.running) return reply.code(409).send({ error: "Wait for the import to finish" });
    if (!(await undoImport(request.user!.id))) return reply.code(404).send({ error: "Nothing to undo" });
    log.info("Undid the last Lightroom import");
    return { ok: true };
  });
}
