import { existsSync, readdirSync } from "node:fs";
import { cp, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { withTransaction } from "../db.js";
import { requireAuth } from "../auth/session.js";
import { DATA_DIR, SINGLE_USER_MODE } from "../config.js";
import { readLocalSettings, writeLocalSettings } from "../localSettings.js";
import { createJob, type JobContext } from "../lib/job.js";
import { log } from "../lib/log.js";
import { requireDesktopMode } from "./requireDesktopMode.js";

interface StorageBody {
  dataDir?: string;
}

interface StorageMoveResult {
  dataDir: string;
  previousDataDir: string;
  filesMoved: boolean;
  restartRequired: true;
}

// Rename when possible (same volume, instant); otherwise copy then delete. Async throughout so a
// large copy never blocks the event loop.
export async function moveDirectoryContents(oldDir: string, newDir: string, onCopied?: () => void): Promise<void> {
  await mkdir(path.dirname(newDir), { recursive: true });
  try {
    await rename(oldDir, newDir);
  } catch {
    try {
      await cp(oldDir, newDir, { recursive: true, preserveTimestamps: true });
    } catch (err) {
      // The caller only gets here with an empty (or missing) destination, so a partial copy is
      // safe to clear; the originals are still intact under oldDir.
      await rm(newDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    // The new folder is complete from here on, so a crash while deleting the old one must finish
    // the move at startup, never roll it back.
    onCopied?.();
    await rm(oldDir, { recursive: true, force: true });
  }
}

// Rewrites every absolute path stored under the old library root. Link-mode and S3 originals
// were never under DATA_DIR, so they're left alone.
async function relinkAbsolutePaths(client: PoolClient, oldDir: string, newDir: string): Promise<void> {
  const columnsByTable: Array<[string, string[]]> = [
    ["photos", ["display_path", "thumb_path"]],
    ["species", ["reference_display_path", "reference_thumb_path"]],
    ["species_reference_photos", ["display_path", "thumb_path"]],
  ];
  for (const [table, columns] of columnsByTable) {
    for (const column of columns) {
      await client.query(
        `UPDATE ${table} SET ${column} = $2 || substring(${column} from length($1) + 1)
         WHERE left(${column}, length($1) + 1) = $1 || '/'`,
        [oldDir, newDir],
      );
    }
  }
  await client.query(
    `UPDATE originals SET ref = $2 || substring(ref from length($1) + 1)
     WHERE managed = true AND ref_type = 'path' AND left(ref, length($1) + 1) = $1 || '/'`,
    [oldDir, newDir],
  );
}

// Runs at startup before anything touches DATA_DIR. A leftover `migration` marker means a move
// was interrupted: if the old folder still has content the move never finished, so roll back;
// otherwise only the relink was pending, and it's safe to rerun (it matches nothing once applied).
export async function recoverInterruptedStorageMigration(): Promise<void> {
  const { migration } = readLocalSettings();
  if (!migration) return;
  const { from, to } = migration;

  const moveNeverCompleted = !migration.copied && existsSync(from) && readdirSync(from).length > 0;
  if (moveNeverCompleted) {
    await rm(to, { recursive: true, force: true });
    writeLocalSettings({ dataDir: from, migration: undefined });
    log.warn(`[storage] An interrupted move to ${to} was rolled back on startup, still using ${from}. Retry from Settings when ready.`);
    return;
  }

  // A finished copy whose old folder was only partly deleted: delete the rest.
  if (migration.copied) await rm(from, { recursive: true, force: true });
  await withTransaction((client) => relinkAbsolutePaths(client, from, to));
  writeLocalSettings({ dataDir: to, migration: undefined });
  log.warn(
    `[storage] Finished an interrupted move to ${to} on startup. If this was JUST resolved, restart Lifer once more so this process's own storage path picks it up too.`,
  );
}

export async function storageMoveRoutes(app: FastifyInstance): Promise<void> {
  // Readable on every install; only desktop can change it (a server's library folder is its
  // LIFER_STORAGE_DIR bind mount).
  app.get("/settings/storage", { preHandler: requireAuth }, async () => {
    return { dataDir: DATA_DIR, changeable: SINGLE_USER_MODE };
  });

  // A background job so a cross-drive copy can run as long as it needs. PUT still waits for the
  // result by default; ?background=1 returns at once and GET /settings/storage/status reports it.
  const storageMoveJob = createJob<StorageMoveResult>("storage-move");

  async function runStorageMove(ctx: JobContext<StorageMoveResult>, oldDir: string, dataDir: string, hadExistingContent: boolean): Promise<StorageMoveResult> {
    if (hadExistingContent) {
      // Recorded before a single file moves, so a crash from here on is recoverable at startup.
      writeLocalSettings({ migration: { from: oldDir, to: dataDir } });
      ctx.update({ phase: "moving" });
      try {
        await moveDirectoryContents(oldDir, dataDir, () => writeLocalSettings({ migration: { from: oldDir, to: dataDir, copied: true } }));
      } catch (err) {
        // Nothing (or only a since-cleared partial copy) moved, so `from` still holds the real
        // data: drop the marker and leave dataDir untouched.
        writeLocalSettings({ migration: undefined });
        throw new Error(`Couldn't move your library: ${(err as Error).message}`);
      }
      ctx.update({ phase: "relinking" });
      // On failure the marker stays: the files already moved, so startup recovery finishes it.
      await withTransaction((client) => relinkAbsolutePaths(client, oldDir, dataDir));
    } else {
      await mkdir(dataDir, { recursive: true });
    }

    writeLocalSettings({ dataDir, migration: undefined });
    return { dataDir, previousDataDir: oldDir, filesMoved: hadExistingContent, restartRequired: true };
  }

  // Moves everything under DATA_DIR to the chosen folder and rewrites stored paths to match.
  // Picking the old location again moves it back. Confirmation lives in the Settings UI.
  app.put<{ Body: StorageBody; Querystring: { background?: string } }>("/settings/storage", { preHandler: requireAuth }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    const { dataDir } = request.body ?? {};
    if (!dataDir || !path.isAbsolute(dataDir)) {
      return reply.code(400).send({ error: "dataDir must be an absolute path" });
    }
    if (dataDir === DATA_DIR) {
      return reply.code(400).send({ error: "That's already the current storage location" });
    }
    if (storageMoveJob.status.running || storageMoveJob.status.result) {
      // A finished move still needs a restart before DATA_DIR reflects it; moving again from the
      // stale DATA_DIR would try to move a folder that is already gone.
      return reply.code(409).send({ error: storageMoveJob.status.running ? "Your library is already being moved" : "Restart Lifer before moving the library again" });
    }

    const oldDir = DATA_DIR;
    const hadExistingContent = existsSync(oldDir) && readdirSync(oldDir).length > 0;
    if (hadExistingContent && existsSync(dataDir) && readdirSync(dataDir).length > 0) {
      return reply.code(400).send({ error: "That folder isn't empty. Choose an empty folder to move your library into" });
    }

    if (!storageMoveJob.start((ctx) => runStorageMove(ctx, oldDir, dataDir, hadExistingContent), { phase: "preparing", currentItem: dataDir })) {
      return reply.code(409).send({ error: "Your library is already being moved" });
    }
    if (request.query.background === "1") return { started: true };
    await storageMoveJob.settled();
    const status = storageMoveJob.status;
    if (status.result) return status.result;
    // The job's error is already a user-facing message, so it's sent as is.
    return reply.code(500).send({ error: status.error ?? "Couldn't move this library", code: "storage_move_failed" });
  });

  app.get("/settings/storage/status", { preHandler: requireAuth }, async (_request, reply) => {
    if (!requireDesktopMode(reply)) return;
    return storageMoveJob.status;
  });
}
