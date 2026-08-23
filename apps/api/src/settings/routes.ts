import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, copyFileSync, cpSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { requireAuth } from "../auth/session.js";
import { DATA_DIR, ORIGINALS_DIR, PORT, SINGLE_USER_MODE, MAPS_DIR, MAP_DOWNLOAD_URL } from "../config.js";
import { originalsFolder } from "../uploads/organizedPath.js";
import { extractExif } from "../uploads/exif.js";
import { readLocalSettings, writeLocalSettings } from "../localSettings.js";

// Lifer's own subfolders under DATA_DIR (see config.ts) — implementation detail, never
// something a user should navigate into when picking a library folder.
const LIFER_INTERNAL_DIR_NAMES = new Set(["originals", "display", "thumb", "reference-display", "reference-thumb", "maps", "tmp"]);

interface OrganizeBody {
  enabled?: boolean;
}

interface StorageBody {
  dataDir?: string;
}

interface MigrateBody {
  serverUrl?: string;
  email?: string;
  password?: string;
}

// The folder-browser and "change storage location" endpoints below read/list arbitrary
// directories on the server's filesystem — fine for desktop mode (this server only ever
// talks to the one person running it, on their own machine), a real information-disclosure
// risk for a network-reachable Docker deployment. Docker already has its own documented way
// to do this (LIFER_STORAGE_DIR — see .env.example), so these routes simply don't exist
// outside SINGLE_USER_MODE rather than needing their own auth model.
function requireDesktopMode(reply: { code: (n: number) => { send: (b: unknown) => void } }): boolean {
  if (!SINGLE_USER_MODE) {
    reply.code(404).send({ error: "Not found" });
    return false;
  }
  return true;
}

function sanitizeForFilesystem(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "").trim();
}

// reorganize-originals moves files one at a time, which otherwise leaves the old species/
// RAW/Adjusted folders (and, switching the other way, the old Wildlife <year>/<taxon>
// folders) sitting around empty once everything's been moved out of them. Walks upward from
// where a moved file used to live, deleting each now-empty folder in turn, and stops the
// moment it hits one that still has something in it or reaches ORIGINALS_DIR itself — never
// deletes ORIGINALS_DIR, and never touches a folder something else still needs.
// OS-generated litter (Finder's folder-view metadata, Windows' thumbnail cache) that a
// species folder full of photos accumulates just from being browsed — doesn't count as
// "real content" when deciding whether a folder is actually empty and safe to remove.
const IGNORABLE_JUNK_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

function removeEmptyDirsUpward(startDir: string, stopAt: string): void {
  let dir = startDir;
  while (dir !== stopAt && dir.startsWith(stopAt + path.sep)) {
    if (!existsSync(dir)) return;
    const entries = readdirSync(dir);
    if (entries.some((name) => !IGNORABLE_JUNK_FILES.has(name))) return;
    for (const name of entries) rmSync(path.join(dir, name), { force: true });
    // rmSync requires recursive: true to remove a directory at all — even an empty one, it
    // throws EISDIR without it. Safe here regardless: everything under `dir` was either
    // nothing or the ignorable junk just deleted above.
    rmSync(dir, { recursive: true, force: true });
    dir = path.dirname(dir);
  }
}

// Whole-directory move for the storage-location change below — tries a plain rename first
// (instant, atomic, works whenever old and new are on the same filesystem/volume), and only
// falls back to a recursive copy+delete for the cross-device case (EXDEV — e.g. moving onto
// a different drive), which Node's renameSync can't do on its own.
function moveDirectoryContents(oldDir: string, newDir: string): void {
  mkdirSync(path.dirname(newDir), { recursive: true });
  try {
    renameSync(oldDir, newDir);
  } catch {
    cpSync(oldDir, newDir, { recursive: true });
    rmSync(oldDir, { recursive: true, force: true });
  }
}

// Every place a full absolute path (rooted at DATA_DIR) is stored in the database — moving
// the library means these need to point at the new root too, or every photo/reference-photo/
// managed-original would 404 the instant the files land at their new location. Deliberately
// excludes link-mode/s3 originals (ref_type != 'path', or managed = false) — those were never
// under DATA_DIR to begin with and are never Lifer's to move or rewrite.
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
         WHERE ${column} LIKE $1 || '/%'`,
        [oldDir, newDir],
      );
    }
  }
  await client.query(
    `UPDATE originals SET ref = $2 || substring(ref from length($1) + 1)
     WHERE managed = true AND ref_type = 'path' AND ref LIKE $1 || '/%'`,
    [oldDir, newDir],
  );
}

// Called once at server startup (see index.ts), before anything else touches DATA_DIR —
// recovers from a crash mid-migration (e.g. a closed laptop lid or a NAS losing power). The
// PUT /settings/storage handler below
// writes a `migration` marker to disk BEFORE moving a single file, and only clears it after
// the move AND the database relink have both fully succeeded — so if the process dies
// anywhere in between, this marker is still sitting there on the next boot, and exactly where
// things got to is fully determined by one simple, durable fact: does the OLD folder still
// exist with content in it?
//
//   - Yes → the move itself never finished (crashed before the rename/copy completed, or
//     mid-copy on a cross-device move). The original data is still safe at `from` untouched;
//     any partial junk that landed at `to` is discarded, and the migration is rolled back to
//     "still on `from`" — never resumed blind with nobody watching. Retrying is left to the
//     user, from Settings, whenever they're ready.
//   - No → the move already completed before the crash; only the database relink and/or
//     clearing the marker were still pending. Both are safe to just finish now — the relink's
//     `WHERE ref LIKE from || '/%'` naturally matches nothing once already applied, so
//     re-running it is a no-op rather than a double-move, not something that needs its own
//     "did this already happen" check.
export async function recoverInterruptedStorageMigration(): Promise<void> {
  const { migration } = readLocalSettings();
  if (!migration) return;
  const { from, to } = migration;

  const moveNeverCompleted = existsSync(from) && readdirSync(from).length > 0;
  if (moveNeverCompleted) {
    if (existsSync(to)) rmSync(to, { recursive: true, force: true });
    writeLocalSettings({ dataDir: from, migration: undefined });
    console.warn(
      `[storage] An interrupted move to ${to} was rolled back on startup — still using ${from}. Retry from Settings when ready.`,
    );
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await relinkAbsolutePaths(client, from, to);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  writeLocalSettings({ dataDir: to, migration: undefined });
  console.warn(
    `[storage] Finished an interrupted move to ${to} on startup. If this was JUST resolved, restart Lifer once more so this process's own storage path picks it up too.`,
  );
}

// This endpoint is the explicit, user-triggered reorganize move: toggling the setting alone
// (see PUT /settings) only changes where FUTURE uploads land, since silently rewriting every
// existing file's location as a side effect of a checkbox would be a surprising, hard-to-undo
// mass file move. Only ever touches managed=true originals — a link-mode file lives wherever
// the user put it, and is never Lifer's to relocate.
export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/settings", { preHandler: requireAuth }, async (request) => {
    const res = await pool.query<{ organize_originals_by_year: boolean }>(
      `SELECT organize_originals_by_year FROM users WHERE id = $1`,
      [request.user!.id],
    );
    return { organizeOriginalsByYear: res.rows[0]?.organize_originals_by_year ?? false };
  });

  app.put<{ Body: OrganizeBody }>("/settings/organize-originals", { preHandler: requireAuth }, async (request, reply) => {
    const { enabled } = request.body ?? {};
    if (typeof enabled !== "boolean") return reply.code(400).send({ error: "enabled must be a boolean" });
    await pool.query(`UPDATE users SET organize_originals_by_year = $1 WHERE id = $2`, [enabled, request.user!.id]);
    return { organizeOriginalsByYear: enabled };
  });

  app.post("/settings/reorganize-originals", { preHandler: requireAuth }, async (request) => {
    const userId = request.user!.id;
    const organizeRes = await pool.query<{ organize_originals_by_year: boolean }>(
      `SELECT organize_originals_by_year FROM users WHERE id = $1`,
      [userId],
    );
    const organizeByYear = organizeRes.rows[0]?.organize_originals_by_year ?? false;

    const originalsRes = await pool.query<{
      id: string;
      ref: string;
      kind: "raw" | "jpeg";
      capture_id: string | null;
      common_name: string | null;
      scientific_name: string | null;
      taxon_class: string | null;
      taken_at: Date | null;
    }>(
      `SELECT o.id, o.ref, o.kind, o.capture_id,
              COALESCE(s1.common_name, s2.common_name) AS common_name,
              COALESCE(s1.scientific_name, s2.scientific_name) AS scientific_name,
              COALESCE(s1.taxon_class, s2.taxon_class) AS taxon_class,
              c.taken_at
       FROM originals o
       LEFT JOIN captures c ON c.id = o.capture_id
       LEFT JOIN species s1 ON s1.id = c.species_id
       LEFT JOIN species s2 ON s2.id = o.species_id
       WHERE o.managed = true AND COALESCE(c.user_id, o.user_id) = $1`,
      [userId],
    );

    let moved = 0;
    let skipped = 0;
    let failed = 0;
    for (const original of originalsRes.rows) {
      if (!original.scientific_name || !existsSync(original.ref)) {
        skipped++;
        continue;
      }
      // Unmatched RAWs (capture_id NULL, filed straight into a species' own folder) have no
      // captures.taken_at to read a year from — the file's own EXIF is the only place left to
      // look. Read lazily, only for exactly this case, rather than for every original.
      const takenAt = original.capture_id ? original.taken_at : (await extractExif(original.ref)).takenAt;

      const folder = originalsFolder(ORIGINALS_DIR, {
        organizeByYear,
        speciesFolderName: sanitizeForFilesystem(original.common_name ?? original.scientific_name),
        taxonClass: original.taxon_class,
        takenAt,
        subfolder: original.kind === "raw" ? "RAW" : "Adjusted",
      });
      const dest = `${folder}/${original.ref.split("/").pop()}`;
      if (dest === original.ref) {
        skipped++;
        continue;
      }
      try {
        mkdirSync(folder, { recursive: true });
        if (existsSync(dest)) {
          // Something else already sits at the exact same organized path (rare — same
          // species+year+filename from two different original rows) — skip rather than
          // silently overwrite or guess which one should win.
          skipped++;
          continue;
        }
        const oldFolder = path.dirname(original.ref);
        try {
          renameSync(original.ref, dest);
        } catch {
          copyFileSync(original.ref, dest);
          rmSync(original.ref, { force: true });
        }
        await pool.query(`UPDATE originals SET ref = $1 WHERE id = $2`, [dest, original.id]);
        moved++;
        // The move itself already succeeded and is already committed above — a problem
        // tidying up the now-empty old folder afterward is cosmetic, not a failed move, and
        // shouldn't be counted or reported as one.
        try {
          removeEmptyDirsUpward(oldFolder, ORIGINALS_DIR);
        } catch (err) {
          console.warn(`[reorganize] Couldn't clean up ${oldFolder}: ${(err as Error).message}`);
        }
      } catch {
        failed++;
      }
    }

    return { moved, skipped, failed, total: originalsRes.rows.length };
  });

  // Desktop-mode storage location (see this file's top comment on requireDesktopMode).
  app.get("/settings/storage", { preHandler: requireAuth }, async (_request, reply) => {
    if (!requireDesktopMode(reply)) return;
    return { dataDir: DATA_DIR };
  });

  app.get<{ Querystring: { path?: string } }>(
    "/settings/browse-directory",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!requireDesktopMode(reply)) return;
      const target = request.query.path || os.homedir();
      if (!path.isAbsolute(target)) return reply.code(400).send({ error: "path must be absolute" });
      let entries: string[];
      try {
        entries = readdirSync(target, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !LIFER_INTERNAL_DIR_NAMES.has(e.name))
          .map((e) => e.name)
          .sort((a, b) => a.localeCompare(b));
      } catch (err) {
        return reply.code(400).send({ error: `Can't read that folder: ${(err as Error).message}` });
      }
      const parent = path.dirname(target);
      return {
        path: target,
        parent: parent === target ? null : parent,
        entries: entries.map((name) => ({ name, path: path.join(target, name) })),
      };
    },
  );

  // Moves everything under the current DATA_DIR to the newly chosen folder and rewrites
  // every stored absolute path to match, so the switch works immediately rather than leaving
  // the user to move gigabytes of RAW files by hand. Symmetric: picking the OLD location
  // again later moves everything straight back, the same way. Confirmation itself lives in
  // the Settings UI (a plain confirm(), same pattern as /settings/reorganize-originals) —
  // this endpoint does the move the moment it's called, same trust model as that endpoint
  // already has.
  app.put<{ Body: StorageBody }>("/settings/storage", { preHandler: requireAuth }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    const { dataDir } = request.body ?? {};
    if (!dataDir || !path.isAbsolute(dataDir)) {
      return reply.code(400).send({ error: "dataDir must be an absolute path" });
    }
    if (dataDir === DATA_DIR) {
      return reply.code(400).send({ error: "That's already the current storage location" });
    }

    const oldDir = DATA_DIR;
    const hadExistingContent = existsSync(oldDir) && readdirSync(oldDir).length > 0;

    if (hadExistingContent) {
      if (existsSync(dataDir) && readdirSync(dataDir).length > 0) {
        return reply.code(400).send({ error: "That folder isn't empty — choose an empty folder to move your library into" });
      }
      // Recorded BEFORE a single file moves (see recoverInterruptedStorageMigration's own
      // comment) — a crash from this point on is recoverable on next startup instead of
      // leaving `dataDir` pointing somewhere that may no longer match reality.
      writeLocalSettings({ migration: { from: oldDir, to: dataDir } });
      try {
        moveDirectoryContents(oldDir, dataDir);
      } catch (err) {
        // Nothing (or only a partial copy) actually moved — `from` still holds the real data,
        // so drop the marker and leave dataDir untouched rather than leave a migration marker
        // pointing at a move that was never really underway.
        writeLocalSettings({ migration: undefined });
        return reply.code(500).send({ error: `Couldn't move your library: ${(err as Error).message}` });
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await relinkAbsolutePaths(client, oldDir, dataDir);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        // The marker is deliberately left in place here: the files already moved, so this
        // is exactly the state recoverInterruptedStorageMigration knows how to finish
        // automatically on next restart, rather than a state to silently swallow.
        throw err;
      } finally {
        client.release();
      }
    } else {
      mkdirSync(dataDir, { recursive: true });
    }

    writeLocalSettings({ dataDir, migration: undefined });

    return {
      dataDir,
      previousDataDir: oldDir,
      filesMoved: hadExistingContent,
      restartRequired: true,
    };
  });

  // Migrates local storage to a remote Lifer server by replaying every local capture as a
  // normal upload against the remote server's own /uploads endpoint. Species ids are
  // NEVER assumed to match between the two databases (each install's species.id is a fresh
  // gen_random_uuid(), even seeded from the same source data) — every capture is resolved by
  // scientific_name against the remote server's own species search instead. Only ever reads
  // local data and calls the remote server's public API; never touches its database directly.
  //
  // Runs as a background job (this handler returns as soon as login succeeds, not once the
  // whole library is done) so a large library doesn't hold one HTTP request open for
  // however long that takes, and so the header spinner (GET .../status, polled) can reflect
  // real progress from any page, not just the one that started it. Resumability and partial-
  // transfer safety both come from the same place: capture_migrations only ever gets a
  // 'migrated' row for a capture AFTER the remote server confirms the upload — so a dropped
  // connection, a closed app, or a server restart mid-job just means the affected capture(s)
  // stay unmarked and get retried the next time this runs, never double-counted, never
  // silently dropped. Only one job runs at a time (migrationJob.running guards re-entry).
  interface MigrationJobState {
    running: boolean;
    serverUrl: string | null;
    migrated: number;
    skipped: number;
    failed: number;
    total: number;
    error: string | null;
    finishedAt: number | null;
  }
  const migrationJob: MigrationJobState = {
    running: false,
    serverUrl: null,
    migrated: 0,
    skipped: 0,
    failed: 0,
    total: 0,
    error: null,
    finishedAt: null,
  };

  async function runMigrationJob(baseUrl: string, cookieHeader: string, userId: string): Promise<void> {
    try {
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
      migrationJob.total = capturesRes.rows.length;

      const speciesIdCache = new Map<string, string | null>();
      async function resolveRemoteSpeciesId(scientificName: string): Promise<string | null> {
        if (speciesIdCache.has(scientificName)) return speciesIdCache.get(scientificName) ?? null;
        let remoteId: string | null = null;
        try {
          const res = await fetch(`${baseUrl}/api/species?q=${encodeURIComponent(scientificName)}`, {
            headers: { Cookie: cookieHeader },
          });
          if (res.ok) {
            const body = (await res.json()) as { results: Array<{ id: string; scientific_name: string }> };
            remoteId = body.results.find((r) => r.scientific_name === scientificName)?.id ?? null;
          }
        } catch {
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
        // Only a real JPEG/PNG original can be re-uploaded as a photo — the /uploads endpoint
        // only accepts those two formats (see ACCEPTED_PHOTO_EXTENSION_BY_MIMETYPE), so a
        // capture with no original on disk (only the app's own internal WebP derivative) has
        // nothing valid to migrate. Permanent, not transient — marked 'skipped' so it's never
        // retried on a later run.
        if (!row.jpeg_ref || !existsSync(row.jpeg_ref)) {
          await markCapture(row.capture_id, "skipped");
          migrationJob.skipped++;
          continue;
        }
        const remoteSpeciesId = await resolveRemoteSpeciesId(row.scientific_name);
        if (!remoteSpeciesId) {
          // Could be transient (remote server hiccup) — 'failed', not 'skipped', so it's
          // retried on the next run instead of given up on permanently.
          await markCapture(row.capture_id, "failed");
          migrationJob.failed++;
          continue;
        }
        try {
          const photoExt = path.extname(row.jpeg_ref).toLowerCase();
          const photoMime = photoExt === ".png" ? "image/png" : "image/jpeg";
          const form = new FormData();
          form.set("speciesId", remoteSpeciesId);
          form.set("mode", "store");
          form.set("file", new Blob([readFileSync(row.jpeg_ref)], { type: photoMime }), path.basename(row.jpeg_ref));
          if (row.raw_ref && existsSync(row.raw_ref)) {
            form.set("rawFile", new Blob([readFileSync(row.raw_ref)]), path.basename(row.raw_ref));
          }
          const uploadRes = await fetch(`${baseUrl}/api/uploads`, {
            method: "POST",
            headers: { Cookie: cookieHeader },
            body: form,
          });
          if (uploadRes.ok) {
            await markCapture(row.capture_id, "migrated");
            migrationJob.migrated++;
          } else {
            await markCapture(row.capture_id, "failed");
            migrationJob.failed++;
          }
        } catch {
          await markCapture(row.capture_id, "failed");
          migrationJob.failed++;
        }
      }
    } catch (err) {
      migrationJob.error = (err as Error).message;
    } finally {
      migrationJob.running = false;
      migrationJob.finishedAt = Date.now();
    }
  }

  app.get("/settings/migrate-to-server/status", { preHandler: requireAuth }, async (_request, reply) => {
    if (!requireDesktopMode(reply)) return;
    return migrationJob;
  });

  app.post<{ Body: MigrateBody }>("/settings/migrate-to-server", { preHandler: requireAuth }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    if (migrationJob.running) {
      return reply.code(409).send({ error: "A migration to a server is already in progress" });
    }
    const { serverUrl, email, password } = request.body ?? {};
    if (!serverUrl || !email || !password) {
      return reply.code(400).send({ error: "serverUrl, email, and password are required" });
    }
    const baseUrl = serverUrl.replace(/\/+$/, "");

    // Migrating a server to ITSELF creates a runaway loop: each "migrated" capture is really
    // just a new upload landing back in the same database, which the next run then sees as
    // one more thing to migrate, forever. A real local→remote migration can never hit this —
    // they're separate databases — so this guards only the accidental case of pointing
    // "migrate to server" at this same instance.
    let targetUrl: URL | null = null;
    try {
      targetUrl = new URL(baseUrl);
    } catch {
      return reply.code(400).send({ error: "That doesn't look like a valid URL" });
    }
    if (["localhost", "127.0.0.1", "::1"].includes(targetUrl.hostname) && Number(targetUrl.port || 80) === PORT) {
      return reply.code(400).send({ error: "That's this same Lifer instance — migrate to a different server, not this one" });
    }
    // A LAN address (192.168.x.x, a home NAS's own IP, etc.) is the normal, expected target
    // here, so those are never blocked. Only two categories are rejected outright: loopback
    // at any OTHER port (this could still be a different local service, not just this
    // process) and the well-known cloud-provider metadata address, which has no legitimate
    // use as a Lifer server and is a classic SSRF target.
    if (["localhost", "127.0.0.1", "::1"].includes(targetUrl.hostname)) {
      return reply.code(400).send({ error: "Refusing to migrate to a loopback address" });
    }
    if (targetUrl.hostname === "169.254.169.254" || targetUrl.hostname === "metadata.google.internal") {
      return reply.code(400).send({ error: "That address isn't a valid migration target" });
    }

    let cookieHeader: string;
    try {
      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!loginRes.ok) {
        const body = (await loginRes.json().catch(() => ({}))) as { error?: string };
        return reply.code(400).send({ error: body.error ?? "Couldn't log in to that server" });
      }
      const setCookie = loginRes.headers.get("set-cookie");
      if (!setCookie) return reply.code(400).send({ error: "Login succeeded but no session was returned" });
      cookieHeader = setCookie.split(";")[0];
    } catch (err) {
      return reply.code(400).send({ error: `Couldn't reach that server: ${(err as Error).message}` });
    }

    migrationJob.running = true;
    migrationJob.serverUrl = baseUrl;
    migrationJob.migrated = 0;
    migrationJob.skipped = 0;
    migrationJob.failed = 0;
    migrationJob.total = 0;
    migrationJob.error = null;
    migrationJob.finishedAt = null;

    // Deliberately not awaited — the request returns as soon as login is confirmed, and the
    // actual upload loop runs in the background (see this fn's own comment on why).
    void runMigrationJob(baseUrl, cookieHeader, request.user!.id);

    return { started: true };
  });

  // The explicit, separate "delete local files now that they're on the server" step (see
  // MigrateToServerSection.tsx's own comment) — deliberately its own action, never automatic
  // at the end of a migration, and gated on the LAST migration run having actually finished
  // clean (no failures) so there's no way to wipe local data the server never actually
  // received. SINGLE_USER_MODE means exactly one real user per local install, so "delete the
  // local library" is unambiguous: this user's captures, full stop.
  app.post<{ Body: { confirm?: boolean } }>("/settings/delete-local-library", { preHandler: requireAuth }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    if (!request.body?.confirm) return reply.code(400).send({ error: "confirm is required" });
    if (migrationJob.finishedAt == null || migrationJob.running || migrationJob.failed > 0) {
      return reply.code(409).send({
        error: "Local files can only be deleted right after a migration that finished with zero failures.",
      });
    }

    const userId = request.user!.id;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM user_species WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM captures WHERE user_id = $1`, [userId]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // The captures/photos rows are gone (cascaded), but the actual files on disk aren't
    // touched by that delete — clear the derivative/original folders directly. Recreated
    // empty rather than removed outright, since DATA_DIR itself (and its expected
    // subfolders) needs to keep existing for the next photo this install ever gets.
    for (const dir of [ORIGINALS_DIR, path.join(DATA_DIR, "display"), path.join(DATA_DIR, "thumb")]) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
    }

    return { ok: true };
  });

  // Offline basemap download (see config.ts's MAP_DOWNLOAD_URL comment for why this is opt-in
  // rather than bundled). Streams straight to disk instead of buffering the ~500MB response in
  // memory, and reports progress via byte counts rather than percent so the frontend doesn't
  // need to guess at a total when the server doesn't send Content-Length. Not desktop-only
  // (requireDesktopMode) — a self-hosted server deployment wants this exact same opt-in
  // download, into the same MAPS_DIR the static-file route in index.ts already serves.
  interface MapJobState {
    downloading: boolean;
    downloadedBytes: number;
    totalBytes: number | null;
    error: string | null;
  }
  const mapJob: MapJobState = { downloading: false, downloadedBytes: 0, totalBytes: null, error: null };
  const MAP_FILE_PATH = path.join(MAPS_DIR, "world-z8.pmtiles");

  app.get("/settings/map/status", { preHandler: requireAuth }, async () => ({
    available: MAP_DOWNLOAD_URL != null,
    downloaded: existsSync(MAP_FILE_PATH),
    ...mapJob,
  }));

  app.post("/settings/map/download", { preHandler: requireAuth }, async (_request, reply) => {
    if (!MAP_DOWNLOAD_URL) return reply.code(400).send({ error: "No offline map is configured for this instance" });
    if (mapJob.downloading) return reply.code(409).send({ error: "The map is already downloading" });

    mapJob.downloading = true;
    mapJob.downloadedBytes = 0;
    mapJob.totalBytes = null;
    mapJob.error = null;

    // Not awaited — same "return immediately, poll /status for progress" shape as the
    // migration job above.
    void (async () => {
      const tmpPath = `${MAP_FILE_PATH}.download`;
      try {
        mkdirSync(MAPS_DIR, { recursive: true });
        const res = await fetch(MAP_DOWNLOAD_URL);
        if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
        const contentLength = res.headers.get("content-length");
        mapJob.totalBytes = contentLength ? Number(contentLength) : null;

        const { createWriteStream } = await import("node:fs");
        const { Readable } = await import("node:stream");
        const { finished } = await import("node:stream/promises");
        const out = createWriteStream(tmpPath);
        const nodeStream = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
        nodeStream.on("data", (chunk: Buffer) => {
          mapJob.downloadedBytes += chunk.length;
        });
        nodeStream.pipe(out);
        await finished(out);
        renameSync(tmpPath, MAP_FILE_PATH);
      } catch (err) {
        mapJob.error = (err as Error).message;
        rmSync(tmpPath, { force: true });
      } finally {
        mapJob.downloading = false;
      }
    })();

    return { started: true };
  });

  // Deletes the downloaded map to reclaim disk space — the reverse of the opt-in above.
  app.delete("/settings/map", { preHandler: requireAuth }, async () => {
    rmSync(MAP_FILE_PATH, { force: true });
    return { ok: true };
  });
}
