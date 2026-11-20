// A curated static site and public life list. The owner builds it from albums, species and the life
// list; it is exported as a folder (desktop and server) or served from a revocable link (server).
// The public routes at the bottom never use requireAuth. Pages carry no coordinates, no place
// names, no scripts and no outside address, and images are the metadata-free display copies.
import { randomBytes } from "node:crypto";
import { constants, createReadStream, existsSync } from "node:fs";
import { access, copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { idleJobStatus } from "@lifer/shared";
import { pool } from "@lifer/core/db.js";
import { ORIGINALS_DIR, SINGLE_USER_MODE } from "@lifer/core/config.js";
import { ensureRoom } from "@lifer/core/lib/freeSpace.js";
import { assertAllowedPath, isDirectory } from "@lifer/core/lib/allowedPaths.js";
import { isWithinResolved } from "@lifer/core/lib/pathContainment.js";
import { hashToken, requireAuth, requireScope } from "../auth/session.js";
import { createJob, type JobContext } from "../lib/job.js";
import { friendlyFsErrorMessage } from "../lib/friendlyFsError.js";
import { Nullable, Ok, Open, DateTime, jobStatusFields, replies, withSchemas } from "../lib/schema.js";
import { loadPortfolioContent } from "./content.js";
import { renderPortfolio, type PortfolioContent } from "./render.js";
import { EMPTY_SPEC, PortfolioSpec } from "./spec.js";

interface ExportExtra {
  destination: string | null;
  copied: number;
  /** Not on disk any more. */
  missing: number;
}
const freshExtra = (): ExportExtra => ({ destination: null, copied: 0, missing: 0 });
export const portfolioExportJob = createJob<null, ExportExtra>("portfolio-export", freshExtra());
let jobUserId: string | null = null;
const isJobOwner = (userId: string) => jobUserId == null || jobUserId === userId;

const ExportStatus = Open({
  ...jobStatusFields(Type.Null()),
  destination: Nullable(Type.String()),
  copied: Type.Integer(),
  missing: Type.Integer(),
});

async function savedSpec(userId: string): Promise<PortfolioSpec> {
  const res = await pool.query<{ spec: PortfolioSpec }>(`SELECT spec FROM portfolios WHERE user_id = $1`, [userId]);
  return res.rows[0]?.spec ?? EMPTY_SPEC;
}

const photoFile = (photoId: string, kind: "display" | "thumb") =>
  kind === "display" ? `${photoId}.webp` : `${photoId}-thumb.webp`;

async function runExport(ctx: JobContext<null, ExportExtra>, userId: string, destination: string) {
  const job = portfolioExportJob.status;
  try {
    const content = await loadPortfolioContent(userId, await savedSpec(userId));
    const files = await pool.query<{ id: string; display_path: string | null; thumb_path: string | null }>(
      `SELECT p.id, p.display_path, p.thumb_path FROM photos p JOIN captures c ON c.current_photo_id = p.id
        WHERE c.user_id = $1 AND p.id = ANY($2::uuid[])`,
      [userId, content.photos.map((p) => p.photoId)],
    );
    const plan = files.rows.flatMap((r) => [
      { from: r.display_path, to: photoFile(r.id, "display") },
      { from: r.thumb_path, to: photoFile(r.id, "thumb") },
    ]);
    let bytes = 0;
    for (const f of plan)
      bytes += f.from
        ? await stat(f.from).then(
            (s) => s.size,
            () => 0,
          )
        : 0;
    await ensureRoom(destination, bytes);
    ctx.update({ phase: "copying", processed: 0, total: plan.length });
    const photosDir = path.join(destination, "photos");
    await mkdir(photosDir, { recursive: true });
    for (const [i, f] of plan.entries()) {
      ctx.throwIfCancelled();
      ctx.update({ currentItem: f.to });
      if (!f.from || !existsSync(f.from)) job.missing++;
      else {
        // A copy from an earlier export is replaced, so a changed photo never goes stale.
        await copyFile(f.from, path.join(photosDir, f.to));
        job.copied++;
      }
      ctx.update({ processed: i + 1 });
    }
    // Only photos that exist are linked, so the site never shows a broken picture.
    const present = new Set(
      plan.filter((f) => f.from && existsSync(f.from)).map((f) => f.to.replace(/(-thumb)?\.webp$/, "")),
    );
    const shown: PortfolioContent = { ...content, photos: content.photos.filter((p) => present.has(p.photoId)) };
    const pages = renderPortfolio(shown, {
      index: "index.html",
      lifeList: "life-list.html",
      photo: (id, kind) => `photos/${photoFile(id, kind)}`,
    });
    await writeFile(path.join(destination, "index.html"), pages.index);
    if (pages.lifeList) await writeFile(path.join(destination, "life-list.html"), pages.lifeList);
    return null;
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    throw new Error(friendlyFsErrorMessage(err), { cause: err });
  }
}

// A public page loads every thumbnail at once, so the owner's content is kept briefly.
const CONTENT_TTL_MS = 30_000;
const contentCache = new Map<string, { at: number; content: PortfolioContent }>();

async function sharedContent(token: string) {
  const res = await pool.query<{ user_id: string; spec: PortfolioSpec }>(
    `SELECT user_id, spec FROM portfolios WHERE share_token_hash = $1`,
    [hashToken(token)],
  );
  const row = res.rows[0];
  if (!row) return null;
  const hit = contentCache.get(row.user_id);
  if (hit && Date.now() - hit.at < CONTENT_TTL_MS) return { userId: row.user_id, content: hit.content };
  const content = await loadPortfolioContent(row.user_id, row.spec);
  if (contentCache.size > 50) contentCache.delete(contentCache.keys().next().value!);
  contentCache.set(row.user_id, { at: Date.now(), content });
  return { userId: row.user_id, content };
}

const PUBLIC_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

const TokenParams = Type.Object({ token: Type.String({ minLength: 1 }) });
const PhotoFileParams = Type.Object({
  token: Type.String({ minLength: 1 }),
  file: Type.String({ pattern: "^[0-9a-fA-F-]{36}(-thumb)?\\.webp$" }),
});

export async function portfolioRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  const Saved = Open({
    spec: PortfolioSpec,
    shared: Type.Boolean(),
    sharedAt: Nullable(DateTime()),
  });

  app.get("/portfolio", { preValidation: requireAuth, schema: { response: replies(Saved) } }, async (request) => {
    const res = await pool.query<{ spec: PortfolioSpec; share_token_hash: string | null; shared_at: Date | null }>(
      `SELECT spec, share_token_hash, shared_at FROM portfolios WHERE user_id = $1`,
      [request.user!.id],
    );
    const row = res.rows[0];
    return { spec: row?.spec ?? EMPTY_SPEC, shared: !!row?.share_token_hash, sharedAt: row?.shared_at ?? null };
  });

  app.put(
    "/portfolio",
    { preValidation: requireAuth, schema: { body: PortfolioSpec, response: replies(Ok) } },
    async (request) => {
      await pool.query(
        `INSERT INTO portfolios (user_id, spec) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET spec = EXCLUDED.spec, updated_at = now()`,
        [request.user!.id, JSON.stringify(request.body)],
      );
      contentCache.delete(request.user!.id);
      return { ok: true };
    },
  );

  // The pages as they'd be exported, for the builder's preview; pictures come from the app itself.
  app.post(
    "/portfolio/preview",
    {
      preValidation: requireAuth,
      schema: {
        body: PortfolioSpec,
        response: replies(Open({ index: Type.String(), lifeList: Nullable(Type.String()) })),
      },
    },
    async (request) =>
      renderPortfolio(await loadPortfolioContent(request.user!.id, request.body), {
        index: "#",
        lifeList: "#",
        photo: (id, kind) => `/api/photos/${id}/${kind === "display" ? "display" : "thumb"}`,
      }),
  );

  // Session only, like the other routes that write to the filesystem.
  app.post(
    "/portfolio/export",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          { destination: Type.String({ minLength: 1, description: "An existing folder" }) },
          { additionalProperties: false },
        ),
        response: replies(Type.Object({ started: Type.Boolean() })),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const { destination } = request.body;
      if (!path.isAbsolute(destination))
        return reply.code(400).send({ error: "destination must be an absolute folder path" });
      const dir = assertAllowedPath(destination);
      if (!(await isDirectory(dir))) return reply.code(400).send({ error: "That folder doesn't exist" });
      if (isWithinResolved(ORIGINALS_DIR, dir))
        return reply.code(400).send({ error: "Choose a folder outside your Lifer library" });
      if (
        !(await access(dir, constants.W_OK).then(
          () => true,
          () => false,
        ))
      )
        return reply.code(400).send({ error: "Lifer can't write to that folder" });
      const started = portfolioExportJob.start((ctx) => runExport(ctx, userId, dir), { destination: dir });
      if (!started) return reply.code(409).send({ error: "An export is already running" });
      jobUserId = userId;
      return { started: true };
    },
  );

  app.get(
    "/portfolio/export/status",
    { preValidation: requireAuth, schema: { response: replies(ExportStatus) } },
    async (request) =>
      isJobOwner(request.user!.id)
        ? portfolioExportJob.status
        : { ...idleJobStatus<null>(), ...freshExtra(), running: portfolioExportJob.status.running },
  );

  app.post(
    "/portfolio/export/cancel",
    { preValidation: requireAuth, schema: { response: replies(Ok) } },
    async (request, reply) => {
      if (!isJobOwner(request.user!.id) || !portfolioExportJob.cancel())
        return reply.code(409).send({ error: "No export is running" });
      return { ok: true };
    },
  );

  // A new link replaces the old one, which stops working. The link is shown once, here.
  app.post(
    "/portfolio/share",
    {
      preValidation: requireScope("share.write"),
      schema: { response: replies(Type.Object({ token: Type.String() })) },
    },
    async (request, reply) => {
      // A desktop app isn't reachable from the internet; the link is for a server.
      if (SINGLE_USER_MODE) return reply.code(409).send({ error: "Share links need a Lifer server" });
      const token = randomBytes(32).toString("base64url");
      await pool.query(
        `INSERT INTO portfolios (user_id, spec, share_token_hash, shared_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id) DO UPDATE SET share_token_hash = EXCLUDED.share_token_hash, shared_at = now()`,
        [request.user!.id, JSON.stringify(EMPTY_SPEC), hashToken(token)],
      );
      contentCache.delete(request.user!.id);
      return { token };
    },
  );

  app.delete(
    "/portfolio/share",
    { preValidation: requireScope("share.write"), schema: { response: replies(Ok) } },
    async (request) => {
      await pool.query(`UPDATE portfolios SET share_token_hash = NULL, shared_at = NULL WHERE user_id = $1`, [
        request.user!.id,
      ]);
      contentCache.delete(request.user!.id);
      return { ok: true };
    },
  );

  // ---- Public (no requireAuth past this point) ----

  const gone = { error: "This link doesn't exist or is no longer available" };
  const pageHrefs = (token: string) => ({
    index: `/api/p/${token}`,
    lifeList: `/api/p/${token}/life-list`,
    photo: (id: string, kind: "display" | "thumb") => `/api/p/${token}/photos/${photoFile(id, kind)}`,
  });

  for (const [route, key] of [
    ["/p/:token", "index"],
    ["/p/:token/life-list", "lifeList"],
  ] as const) {
    app.get(route, { schema: { params: TokenParams } }, async (request, reply) => {
      const shared = await sharedContent(request.params.token);
      if (!shared) return reply.code(404).send(gone);
      const html = renderPortfolio(shared.content, pageHrefs(request.params.token))[key];
      if (html == null) return reply.code(404).send(gone);
      return reply.headers(PUBLIC_HEADERS).header("Content-Type", "text/html; charset=utf-8").send(html);
    });
  }

  app.get("/p/:token/photos/:file", { schema: { params: PhotoFileParams } }, async (request, reply) => {
    const shared = await sharedContent(request.params.token);
    if (!shared) return reply.code(404).send(gone);
    const photoId = request.params.file.replace(/(-thumb)?\.webp$/, "").toLowerCase();
    if (!shared.content.photos.some((p) => p.photoId.toLowerCase() === photoId))
      return reply.code(404).send({ error: "Photo not found" });
    const column = request.params.file.endsWith("-thumb.webp") ? "p.thumb_path" : "p.display_path";
    // Through the captures view's current photo, so a trashed capture is never served.
    const res = await pool.query<{ path: string | null }>(
      `SELECT ${column} AS path FROM photos p JOIN captures c ON c.current_photo_id = p.id
        WHERE c.user_id = $1 AND p.id = $2`,
      [shared.userId, photoId],
    );
    const filePath = res.rows[0]?.path;
    if (!filePath || !existsSync(filePath)) return reply.code(404).send({ error: "Photo not found" });
    return reply
      .headers(PUBLIC_HEADERS)
      .header("Content-Type", "image/webp")
      .header("Cache-Control", "private, max-age=300")
      .send(createReadStream(filePath));
  });
}
