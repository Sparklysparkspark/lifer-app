import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool, withTransaction } from "@lifer/core/db.js";
import { requireAuth } from "../auth/session.js";
import { DATA_DIR, ORIGINALS_DIR, LEGACY_ORIGINALS_DIR, APP_DATA_DIR, PORT } from "@lifer/core/config.js";
import { isWithinResolved } from "@lifer/core/lib/pathContainment.js";
import { removeEmptyDirsUpward } from "../lib/fsCleanup.js";
import { createJob, type JobContext } from "../lib/job.js";
import { findSidecarPath } from "../uploads/exif.js";
import { PHOTO_FORMATS, photoFormatFor } from "@lifer/core/uploads/formats.js";
import { TUS_INITIAL_CHUNK_SIZE, tusUploadFile, type TusClientOptions } from "../lib/tusClient.js";
import { invalidateUserVectors } from "@lifer/core/species/embeddings.js";
import { deleteLocalLibraryBlockedReason } from "./deleteLibraryGate.js";
import { Ok, replies, withSchemas } from "../lib/schema.js";
import { desktopOnly } from "./requireDesktopMode.js";
import type { Agent } from "undici";
import { assertAllowedTarget, guardedDispatcher, RefusedAddressError, viaDispatcher } from "../lib/outboundGuard.js";
import { trimEndChars } from "../lib/trimChars.js";

const MigrateBody = Type.Object(
  {
    // Parsed and checked against loopback and link-local addresses in the handler, and again on
    // every connection (lib/outboundGuard.ts).
    serverUrl: Type.String({ minLength: 1 }),
    email: Type.String({ minLength: 1 }),
    password: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

interface MigrationExtra {
  serverUrl: string | null;
  migrated: number;
  skipped: number;
  failed: number;
}

interface MigrationResult {
  migrated: number;
  skipped: number;
  failed: number;
  total: number;
}

/** Sends one capture to a remote Lifer server: each file as a resumable upload in chunks (so a
 *  proxy's body limit never matters), then an import naming them. True when the server took it. */
export async function sendCaptureToServer(
  baseUrl: string,
  authHeaders: Record<string, string>,
  capture: { speciesId: string; photoPath: string; rawPath: string | null },
  opts: {
    signal?: AbortSignal;
    chunkState?: { size: number };
    tus?: Partial<TusClientOptions>;
    dispatcher?: Agent;
  } = {},
): Promise<boolean> {
  const tusOpts: TusClientOptions = {
    endpoint: `${baseUrl}/api/uploads/tus`,
    headers: authHeaders,
    signal: opts.signal,
    chunkState: opts.chunkState,
    dispatcher: opts.dispatcher,
    ...opts.tus,
  };
  const send = (filePath: string) => {
    const format = photoFormatFor(filePath);
    return tusUploadFile(
      filePath,
      { filename: path.basename(filePath), filetype: format ? PHOTO_FORMATS[format].mimeTypes[0] : null },
      tusOpts,
    );
  };
  const form = new FormData();
  form.set("speciesId", capture.speciesId);
  form.set("mode", "store");
  // A capture the server already has (a run cut off before it was marked migrated) comes back
  // as that photo instead of a second copy.
  form.set("skipDuplicates", "1");
  form.set("uploadId", await send(capture.photoPath));
  if (capture.rawPath) form.set("rawUploadId", await send(capture.rawPath));
  // Generous: importing a large file (hashing it, writing derivatives) can take a while.
  const res = await fetch(`${baseUrl}/api/uploads`, {
    method: "POST",
    headers: authHeaders,
    body: form,
    ...viaDispatcher(opts.dispatcher),
    signal: opts.signal
      ? AbortSignal.any([opts.signal, AbortSignal.timeout(15 * 60_000)])
      : AbortSignal.timeout(15 * 60_000),
  });
  await res.arrayBuffer().catch(() => {});
  return res.ok;
}

// Replays every local capture as a normal upload to a remote Lifer server's public API. Species
// are matched by scientific name, since ids differ between databases. A capture is marked
// 'migrated' only after the server confirms it, so an interrupted run just retries the rest.
export async function migrateToServerRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  const migrationJob = createJob<MigrationResult, MigrationExtra>("migrate-to-server", {
    serverUrl: null,
    migrated: 0,
    skipped: 0,
    failed: 0,
  });

  async function runMigrationJob(
    ctx: JobContext<MigrationResult>,
    baseUrl: string,
    cookieHeader: string,
    userId: string,
    dispatcher: Agent,
  ): Promise<MigrationResult> {
    const job = migrationJob.status;
    const capturesRes = await pool.query<{
      capture_id: string;
      scientific_name: string;
      jpeg_ref: string | null;
      raw_ref: string | null;
    }>(
      `SELECT c.id AS capture_id, s.scientific_name,
              oj.ref AS jpeg_ref,
              orw.ref AS raw_ref
       FROM captures c
       JOIN species s ON s.id = c.species_id
       LEFT JOIN originals oj ON oj.capture_id = c.id AND oj.kind = 'jpeg'
       LEFT JOIN originals orw ON orw.capture_id = c.id AND orw.kind = 'raw'
       WHERE c.user_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM capture_migrations cm
           WHERE cm.capture_id = c.id AND cm.server_url = $2 AND cm.status IN ('migrated', 'skipped')
         )`,
      [userId, baseUrl],
    );
    const total = capturesRes.rows.length;
    ctx.update({ phase: "uploading", total, processed: 0 });
    const bump = () => ctx.update({ processed: job.migrated + job.skipped + job.failed });

    // The client header gets a cookie-authenticated write past the server's cross-site guard.
    const authHeaders = { Cookie: cookieHeader, "x-lifer-client": "1" };
    const chunkState = { size: TUS_INITIAL_CHUNK_SIZE };
    const speciesIdCache = new Map<string, string | null>();
    async function resolveRemoteSpeciesId(scientificName: string): Promise<string | null> {
      if (speciesIdCache.has(scientificName)) return speciesIdCache.get(scientificName) ?? null;
      let remoteId: string | null = null;
      try {
        const res = await fetch(`${baseUrl}/api/species?q=${encodeURIComponent(scientificName)}`, {
          headers: authHeaders,
          ...viaDispatcher(dispatcher),
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]),
        });
        if (res.ok) {
          const body = (await res.json()) as { results: Array<{ id: string; scientific_name: string }> };
          remoteId = body.results.find((r) => r.scientific_name === scientificName)?.id ?? null;
        }
      } catch {
        ctx.throwIfCancelled();
        remoteId = null;
      }
      speciesIdCache.set(scientificName, remoteId);
      return remoteId;
    }

    async function markCapture(captureId: string, status: "migrated" | "skipped" | "failed"): Promise<void> {
      await pool.query(
        `INSERT INTO capture_migrations (capture_id, server_url, status) VALUES ($1, $2, $3)
         ON CONFLICT (capture_id, server_url) DO UPDATE SET status = EXCLUDED.status, migrated_at = now()`,
        [captureId, baseUrl, status],
      );
    }

    for (const row of capturesRes.rows) {
      ctx.throwIfCancelled();
      ctx.update({ currentItem: row.scientific_name });
      // /uploads accepts JPEG, PNG, WebP, TIFF and HEIC, so a capture with no such original on
      // disk has nothing to send. That's permanent, so 'skipped' (never retried).
      if (!row.jpeg_ref || !existsSync(row.jpeg_ref)) {
        await markCapture(row.capture_id, "skipped");
        job.skipped++;
        bump();
        continue;
      }
      const remoteSpeciesId = await resolveRemoteSpeciesId(row.scientific_name);
      if (!remoteSpeciesId) {
        // Could be transient, so 'failed' (retried next run) rather than 'skipped'.
        await markCapture(row.capture_id, "failed");
        job.failed++;
        bump();
        continue;
      }
      try {
        const rawPath = row.raw_ref && existsSync(row.raw_ref) ? row.raw_ref : null;
        const ok = await sendCaptureToServer(
          baseUrl,
          authHeaders,
          { speciesId: remoteSpeciesId, photoPath: row.jpeg_ref, rawPath },
          { signal: ctx.signal, chunkState, dispatcher },
        );
        await markCapture(row.capture_id, ok ? "migrated" : "failed");
        if (ok) job.migrated++;
        else job.failed++;
      } catch {
        // A cancel mid-upload isn't a failed capture; it just stays unmarked for next time.
        ctx.throwIfCancelled();
        await markCapture(row.capture_id, "failed");
        job.failed++;
      }
      bump();
    }
    return { migrated: job.migrated, skipped: job.skipped, failed: job.failed, total };
  }

  app.get(
    "/settings/migrate-to-server/status",
    { preValidation: [requireAuth, desktopOnly], schema: {} },
    async () => migrationJob.status,
  );

  // Stops between captures. The capture in flight either lands (and is marked) or stays
  // unmarked and is retried next run.
  app.post(
    "/settings/migrate-to-server/cancel",
    {
      preValidation: [requireAuth, desktopOnly],
      schema: { response: replies(Type.Object({ cancelled: Type.Boolean() })) },
    },
    async () => ({ cancelled: migrationJob.cancel() }),
  );

  app.post(
    "/settings/migrate-to-server",
    { preValidation: [requireAuth, desktopOnly], schema: { body: MigrateBody } },
    async (request, reply) => {
      if (migrationJob.status.running) {
        return reply.code(409).send({ error: "A migration to a server is already in progress" });
      }
      const { serverUrl, email, password } = request.body;
      const baseUrl = trimEndChars(serverUrl, "/");

      // Migrating to this same instance would loop forever: each upload lands back here as one
      // more capture to migrate.
      let targetUrl: URL;
      try {
        targetUrl = new URL(baseUrl);
      } catch {
        return reply.code(400).send({ error: "That doesn't look like a valid URL" });
      }
      if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
        return reply.code(400).send({ error: "That doesn't look like a valid URL" });
      }
      // URL keeps the brackets on an IPv6 hostname.
      const isLoopbackName =
        targetUrl.hostname === "localhost" || targetUrl.hostname === "[::1]" || /^127\./.test(targetUrl.hostname);
      if (isLoopbackName && Number(targetUrl.port || 80) === PORT) {
        return reply
          .code(400)
          .send({ error: "That's this same Lifer instance. Migrate to a different server, not this one" });
      }
      // LAN addresses are the normal target and stay allowed. Loopback and link-local addresses
      // (cloud metadata services among them) are refused: a classic SSRF target with no use as a
      // Lifer server. Checked on the resolved addresses here for a clear message, and again on
      // every connection the migration makes, so DNS rebinding and redirects can't get around it.
      try {
        await assertAllowedTarget(targetUrl);
      } catch (err) {
        if (err instanceof RefusedAddressError) {
          return reply.code(400).send({ error: "Refusing to migrate to a loopback or link-local address" });
        }
        return reply.code(400).send({ error: `Couldn't reach that server: ${(err as Error).message}` });
      }
      const dispatcher = guardedDispatcher();

      let cookieHeader: string;
      try {
        const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
          ...viaDispatcher(dispatcher),
          signal: AbortSignal.timeout(30_000),
        });
        if (!loginRes.ok) {
          const body = (await loginRes.json().catch(() => ({}))) as { error?: string };
          return reply.code(400).send({ error: body.error ?? "Couldn't log in to that server" });
        }
        const setCookie = loginRes.headers.get("set-cookie");
        if (!setCookie) return reply.code(400).send({ error: "Login succeeded but no session was returned" });
        cookieHeader = setCookie.split(";")[0];
      } catch (err) {
        await dispatcher.close().catch(() => {});
        const refusedAddress = (err as Error).cause instanceof RefusedAddressError;
        if (refusedAddress)
          return reply.code(400).send({ error: "Refusing to migrate to a loopback or link-local address" });
        return reply.code(400).send({ error: `Couldn't reach that server: ${(err as Error).message}` });
      }

      // Claimed after the slow login; start() is atomic, so a second request gets a 409.
      const userId = request.user!.id;
      const started = migrationJob.start(
        (ctx) =>
          runMigrationJob(ctx, baseUrl, cookieHeader, userId, dispatcher).finally(() =>
            dispatcher.close().catch(() => {}),
          ),
        { serverUrl: baseUrl },
      );
      if (!started) {
        await dispatcher.close().catch(() => {});
        return reply.code(409).send({ error: "A migration to a server is already in progress" });
      }

      return { started: true };
    },
  );

  // The separate, explicit "delete local files now that they're on the server" step. Only
  // allowed after the last migration finished clean, so nothing the server lacks is deleted.
  app.post(
    "/settings/delete-local-library",
    {
      preValidation: [requireAuth, desktopOnly],
      schema: {
        body: Type.Object({ confirm: Type.Literal(true) }, { additionalProperties: false }),
        response: replies(Ok),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const job = migrationJob.status;
      let unmigrated = 0;
      if (job.serverUrl) {
        const res = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM captures c
           WHERE c.user_id = $1 AND NOT EXISTS (
             SELECT 1 FROM capture_migrations cm WHERE cm.capture_id = c.id AND cm.server_url = $2 AND cm.status = 'migrated'
           )`,
          [userId, job.serverUrl],
        );
        unmigrated = res.rows[0]?.n ?? 0;
      }
      const blocked = deleteLocalLibraryBlockedReason(job, unmigrated);
      if (blocked) return reply.code(409).send({ error: blocked });

      // In the flat layout the library folder is one the user chose, and may hold their own files
      // too: delete only the originals Lifer saved there (listed before their rows go), never the
      // folder itself. The older "Lifer Photos" subfolder is Lifer's alone and is cleared whole.
      const ownsWholeFolder = ORIGINALS_DIR === LEGACY_ORIGINALS_DIR;
      const managedFiles = ownsWholeFolder
        ? []
        : (
            await pool.query<{ ref: string }>(
              `SELECT o.ref FROM originals o JOIN captures_all c ON c.id = o.capture_id
               WHERE c.user_id = $1 AND o.managed = true AND o.ref_type = 'path'`,
              [userId],
            )
          ).rows.map((r) => r.ref);

      await withTransaction(async (client) => {
        await client.query(`DELETE FROM user_species WHERE user_id = $1`, [userId]);
        await client.query(`DELETE FROM captures WHERE user_id = $1`, [userId]);
      });
      invalidateUserVectors(userId);

      // The rows cascaded, but the files didn't: clear the derivative and original folders,
      // recreated empty since the next photo still needs them.
      const clearedDirs = [
        path.join(APP_DATA_DIR, "display"),
        path.join(APP_DATA_DIR, "medium"),
        path.join(APP_DATA_DIR, "thumb"),
      ];
      if (ownsWholeFolder) clearedDirs.unshift(ORIGINALS_DIR);
      for (const dir of clearedDirs) {
        await rm(dir, { recursive: true, force: true });
        await mkdir(dir, { recursive: true });
      }
      for (const file of managedFiles) {
        if (!isWithinResolved(ORIGINALS_DIR, file)) continue;
        const sidecar = findSidecarPath(file);
        await rm(file, { force: true });
        if (sidecar) await rm(sidecar, { force: true });
        await removeEmptyDirsUpward(path.dirname(file), ORIGINALS_DIR);
      }
      // Old derivative caches under DATA_DIR that migrateDerivativesLocation couldn't move. Not
      // recreated: nothing writes there anymore.
      if (DATA_DIR !== APP_DATA_DIR) {
        for (const sub of ["display", "thumb"]) await rm(path.join(DATA_DIR, sub), { recursive: true, force: true });
      }

      return { ok: true };
    },
  );
}
