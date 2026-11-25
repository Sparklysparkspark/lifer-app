// Importing a folder again (knownFiles.ts): the batch lookup the Import page runs before uploading,
// the memory of photos left out, and on the desktop the folders imported from.
import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { SINGLE_USER_MODE } from "@lifer/core/config.js";
import { pool } from "@lifer/core/db.js";
import { assertAllowedPath, isDirectory } from "@lifer/core/lib/allowedPaths.js";
import { requireAuth } from "../auth/session.js";
import { DateTime, Nullable, Ok, replies, withSchemas } from "../lib/schema.js";
import { inSourceFolder, isImportableName, knownFingerprints, lookAtFolder, rememberSkipped } from "./knownFiles.js";
import { clearKnownSources } from "./sourceTrash.js";
import { TrashReason } from "./responses.js";
import { isShellRequest, rememberPicked, wasPicked } from "./pickedFiles.js";

const MAX_BATCH = 2000;
const MAX_PICKED = 20_000;
const Fingerprint = Type.String({
  pattern: "^[0-9a-f]{40}$",
  description: "sha1 (hex) of the file's size in decimal, its first 64 KB and its last 64 KB",
});
const Reason = Type.Enum(["removed", "not_wildlife", "no_animal"], {
  description: "Why it was left out: removed by hand, not wildlife, or marked No animal",
});
const PathBody = Type.Object(
  { path: Type.String({ minLength: 1, description: "A folder on this computer" }) },
  { additionalProperties: false },
);
const Match = Nullable(
  Type.Object(
    {
      photoId: Nullable(Type.String()),
      speciesId: Type.String(),
      commonName: Nullable(Type.String()),
      scientificName: Type.String(),
    },
    { description: "The library photo an imported file became" },
  ),
);
const FolderFile = Type.Object({
  path: Type.String(),
  name: Type.String(),
  size: Type.Number(),
  mtimeMs: Type.Number(),
  fingerprint: Nullable(Fingerprint),
  status: Type.Enum(["new", "imported", "skipped"]),
  match: Match,
  edited: Type.Boolean({ description: "Imported before at this path, changed since" }),
});

export async function knownFilesRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.post(
    "/uploads/known",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          {
            fingerprints: Type.Array(Fingerprint, {
              maxItems: MAX_BATCH,
              description: "Quick fingerprints of picked files, up to 2,000 per request",
            }),
          },
          { additionalProperties: false },
        ),
        response: replies(
          Type.Object({
            known: Type.Array(
              Type.Object({
                fingerprint: Type.String(),
                status: Type.Enum(["imported", "skipped"]),
                reason: Nullable(Reason),
                match: Match,
              }),
              { description: "Only the fingerprints already imported or left out before; the rest are new" },
            ),
          }),
        ),
      },
    },
    async (request) => {
      const known = await knownFingerprints(request.user!.id, request.body.fingerprints);
      return { known: [...known].map(([fingerprint, k]) => ({ fingerprint, ...k })) };
    },
  );

  app.post(
    "/uploads/skipped",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          {
            files: Type.Array(
              Type.Object(
                {
                  fingerprint: Fingerprint,
                  name: Type.String({ minLength: 1, maxLength: 1024 }),
                  size: Type.Integer({ minimum: 0 }),
                  reason: Reason,
                },
                { additionalProperties: false },
              ),
              { maxItems: MAX_BATCH, description: "Photos left out of an import, offered again only after Forget" },
            ),
          },
          { additionalProperties: false },
        ),
        response: replies(Ok),
      },
    },
    async (request) => {
      await rememberSkipped(request.user!.id, request.body.files);
      return { ok: true };
    },
  );

  app.get(
    "/uploads/skipped",
    {
      preValidation: requireAuth,
      schema: {
        response: replies(
          Type.Object({
            total: Type.Integer(),
            files: Type.Array(
              Type.Object({
                fingerprint: Type.String(),
                name: Type.String(),
                size: Type.Number(),
                reason: Reason,
                createdAt: DateTime(),
              }),
              { description: "The most recent 1,000" },
            ),
          }),
        ),
      },
    },
    async (request) => {
      const userId = request.user!.id;
      const [files, total] = await Promise.all([
        pool.query<{ fingerprint: string; name: string; size: string; reason: string; created_at: Date }>(
          `SELECT fingerprint, name, size, reason, created_at FROM import_skipped_files
            WHERE user_id = $1 ORDER BY created_at DESC, name LIMIT 1000`,
          [userId],
        ),
        pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM import_skipped_files WHERE user_id = $1`, [userId]),
      ]);
      return {
        total: total.rows[0].n,
        files: files.rows.map((r) => ({
          fingerprint: r.fingerprint,
          name: r.name,
          size: Number(r.size),
          reason: r.reason as "removed" | "not_wildlife" | "no_animal",
          createdAt: r.created_at.toISOString(),
        })),
      };
    },
  );

  app.post(
    "/uploads/skipped/forget",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          {
            fingerprints: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_BATCH })),
            all: Type.Optional(Type.Boolean({ description: "Forget every left-out photo" })),
          },
          { additionalProperties: false },
        ),
        response: replies(Ok),
      },
    },
    async (request) => {
      const { fingerprints = [], all } = request.body;
      await pool.query(
        `DELETE FROM import_skipped_files WHERE user_id = $1 AND ($3 OR fingerprint = ANY($2::text[]))`,
        [request.user!.id, fingerprints, all === true],
      );
      return { ok: true };
    },
  );

  // --- Desktop: folders imported from. The server is this computer, so it can read them. ---

  app.get(
    "/uploads/source-folders",
    {
      preValidation: requireAuth,
      schema: {
        response: replies(
          Type.Object({
            folders: Type.Array(
              Type.Object({ path: Type.String(), lastImportedAt: DateTime(), photoCount: Type.Integer() }),
              { description: "The 8 most recently imported from" },
            ),
          }),
        ),
      },
    },
    async (request, reply) => {
      if (!SINGLE_USER_MODE) return reply.code(404).send({ error: "Not found" });
      const res = await pool.query<{ path: string; last_imported_at: Date; photo_count: number }>(
        `SELECT path, last_imported_at, photo_count FROM import_source_folders
          WHERE user_id = $1 ORDER BY last_imported_at DESC LIMIT 8`,
        [request.user!.id],
      );
      return {
        folders: res.rows.map((r) => ({
          path: r.path,
          lastImportedAt: r.last_imported_at.toISOString(),
          photoCount: r.photo_count,
        })),
      };
    },
  );

  // Stat-only: no file is read, so it's cheap enough to run each time the Import page opens.
  app.post(
    "/uploads/source-folders/new-count",
    {
      preValidation: requireAuth,
      schema: {
        body: PathBody,
        response: replies(
          Type.Object({
            available: Type.Boolean({ description: "false when the folder is gone or its drive unplugged" }),
            newCount: Type.Integer(),
          }),
        ),
      },
    },
    async (request, reply) => {
      if (!SINGLE_USER_MODE) return reply.code(404).send({ error: "Not found" });
      const folder = assertAllowedPath(request.body.path);
      if (!(await isDirectory(folder))) return { available: false, newCount: 0 };
      const files = await lookAtFolder(request.user!.id, folder, { hash: false });
      return { available: true, newCount: files.filter((f) => f.status === "new").length };
    },
  );

  app.post(
    "/uploads/source-folders/scan",
    {
      preValidation: requireAuth,
      schema: { body: PathBody, response: replies(Type.Object({ files: Type.Array(FolderFile) })) },
    },
    async (request, reply) => {
      if (!SINGLE_USER_MODE) return reply.code(404).send({ error: "Not found" });
      if (!(await isDirectory(request.body.path)))
        return reply.code(400).send({ error: "That folder isn't there any more" });
      const folder = assertAllowedPath(request.body.path);
      return { files: await lookAtFolder(request.user!.id, folder, { hash: true }) };
    },
  );

  // The desktop shell's Choose files dialog reports what the user picked (pickedFiles.ts). Hidden
  // from pages: without the shell's secret it isn't there.
  app.post(
    "/uploads/picked-files",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          { paths: Type.Array(Type.String({ minLength: 1 }), { maxItems: MAX_PICKED }) },
          { additionalProperties: false },
        ),
        response: replies(Ok),
      },
    },
    async (request, reply) => {
      if (!SINGLE_USER_MODE || !isShellRequest(request.headers)) return reply.code(404).send({ error: "Not found" });
      rememberPicked(request.body.paths);
      return { ok: true };
    },
  );

  // The file itself, for the import screen to queue like a picked one. Only inside a folder the
  // user imported from, or picked in the desktop's Choose files dialog.
  app.get(
    "/uploads/source-folders/file",
    {
      preValidation: requireAuth,
      schema: { querystring: Type.Object({ path: Type.String({ minLength: 1 }) }, { additionalProperties: false }) },
    },
    async (request, reply) => {
      if (!SINGLE_USER_MODE) return reply.code(404).send({ error: "Not found" });
      const file = request.query.path;
      if (!isImportableName(file) || !(wasPicked(file) || (await inSourceFolder(request.user!.id, file))))
        return reply.code(403).send({ error: "Not a photo in a folder you imported from" });
      return reply.type("application/octet-stream").send(createReadStream(file));
    },
  );

  // "Clear out the ones already in Lifer": files in a folder imported from whose exact bytes the
  // library holds, checked again here, go to the system Trash. dryRun only counts them.
  app.post(
    "/uploads/source-folders/clear",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          {
            paths: Type.Array(Type.String({ minLength: 1 }), { maxItems: MAX_BATCH }),
            dryRun: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
        response: replies(
          Type.Object({
            cleared: Type.Integer(),
            sidecars: Type.Integer({ description: "XMP sidecars that went (or would go) with them" }),
            trashed: Type.Array(Type.String(), { description: "Every file sent to the Trash, sidecars included" }),
            kept: Type.Array(Type.Object({ path: Type.String(), reason: TrashReason })),
          }),
        ),
      },
    },
    async (request, reply) => {
      if (!SINGLE_USER_MODE) return reply.code(404).send({ error: "Not found" });
      return clearKnownSources(request.user!.id, request.body.paths, request.body.dryRun === true);
    },
  );
}
