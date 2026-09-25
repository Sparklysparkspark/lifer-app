import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, copyFileSync, cpSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { requireAuth } from "../auth/session.js";
import { DATA_DIR, ORIGINALS_DIR, LEGACY_ORIGINALS_DIR, APP_DATA_DIR, PORT, SINGLE_USER_MODE, MAPS_DIR, MAP_DOWNLOAD_URL, LIBRARY_ROOTS } from "../config.js";
import { allowedRootFor, allowedRoots, assertAllowedPath, isWithin } from "../lib/allowedPaths.js";
import { originalsFolder } from "../uploads/organizedPath.js";
import { resolveSpeciesFolderName } from "../uploads/speciesFolderName.js";
import { extractExif, findSidecarPath } from "../uploads/exif.js";
import { syncCaptureXmpSidecarsLogged } from "../uploads/xmpSidecarSync.js";
import { resyncSpeciesMetadata } from "../captures/routes.js";
import { readLocalSettings, writeLocalSettings } from "../localSettings.js";
import { checkCatalogUpdate, startCatalogUpdateJob, catalogUpdate, catalogFirstBootState } from "../species/catalogSeedUpdate.js";
import { modelDownload, startModelDownloadJob } from "../species/modelDownloadJob.js";
import { isModelDownloaded, offloadModel, MODEL_DIR } from "../species/embeddings.js";
import { isTextModelDownloaded } from "../species/textEmbedding.js";
import { createJob, type JobContext } from "../lib/job.js";
import { downloadToFile } from "../lib/download.js";
import { deleteLocalLibraryBlockedReason } from "./deleteLibraryGate.js";

// Lifer's own subfolders under DATA_DIR (see config.ts) — implementation detail, never
// something a user should navigate into when picking a library folder.
const LIFER_INTERNAL_DIR_NAMES = new Set(["Lifer Photos", "display", "thumb", "reference-display", "reference-thumb", "maps", "tmp"]);

interface OrganizeBody {
  enabled?: boolean;
}

// ABA (really IBP/AOS) alpha codes only exist for birds in North America, Mexico, Central
// America, and the Caribbean (see backfill-aba-codes.ts) — gating this setting's availability
// on whether the user's OWN downloaded packs actually reach that coverage, rather than always
// offering it, since it'd otherwise silently do nothing for someone who's only ever downloaded,
// say, an Australia or Kenya pack. Data-driven (checks whether any downloaded pack's species
// actually got an aba_code) rather than a hardcoded country list, so it stays correct as pack
// coverage changes without needing to be kept in sync by hand.
async function abaCodesAvailable(): Promise<boolean> {
  const res = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM pack_species ps JOIN species s ON s.id = ps.species_id WHERE s.aba_code IS NOT NULL
     ) AS available`,
  );
  return res.rows[0]?.available ?? false;
}

interface StorageBody {
  dataDir?: string;
}

interface MigrateBody {
  serverUrl?: string;
  email?: string;
  password?: string;
}

// For routes that only make sense on a local single-user install: moving the whole library
// folder (a server's is its LIFER_STORAGE_DIR bind mount), migrating a local library to a
// server, deleting the local library, and revealing a file in the OS file manager. Routes that
// merely take a path from the request are NOT gated with this anymore; they go through
// lib/allowedPaths.ts, which confines a server to DATA_DIR plus LIFER_LIBRARY_ROOTS.
export function requireDesktopMode(reply: { code: (n: number) => { send: (b: unknown) => void } }): boolean {
  if (!SINGLE_USER_MODE) {
    reply.code(404).send({ error: "Not found" });
    return false;
  }
  return true;
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

// Called once at server startup (see index.ts), before anything touches DATA_DIR — recovers
// from a crash mid-migration. PUT /settings/storage writes a `migration` marker before moving
// any file and clears it only after the move AND db relink both succeed, so a marker still
// present on boot means resume based on one fact: does the OLD folder still exist with content?
// Yes → the move never finished; roll back to "still on `from`" and let the user retry from
// Settings. No → the move finished, only the relink/marker-clear were pending; safe to finish
// now (the relink's WHERE clause naturally matches nothing once already applied).
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
    await client.query("ROLLBACK").catch(() => {});
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
    const res = await pool.query<{
      organize_originals_by_year: boolean;
      organize_originals_by_location: boolean;
      hide_obscure_species: boolean;
      species_suggest_enabled: boolean;
      any_taxa_search_enabled: boolean;
      technical_diving: boolean;
      species_naming_styles: string[];
    }>(
      `SELECT organize_originals_by_year, organize_originals_by_location, hide_obscure_species, species_suggest_enabled, any_taxa_search_enabled, technical_diving, species_naming_styles FROM users WHERE id = $1`,
      [request.user!.id],
    );
    return {
      organizeOriginalsByYear: res.rows[0]?.organize_originals_by_year ?? false,
      organizeOriginalsByLocation: res.rows[0]?.organize_originals_by_location ?? false,
      hideObscureSpecies: res.rows[0]?.hide_obscure_species ?? true,
      speciesSuggestEnabled: res.rows[0]?.species_suggest_enabled ?? true,
      anyTaxaSearchEnabled: res.rows[0]?.any_taxa_search_enabled ?? false,
      technicalDiving: res.rows[0]?.technical_diving ?? false,
      speciesNamingStyles: res.rows[0]?.species_naming_styles ?? [],
      abaCodesAvailable: await abaCodesAvailable(),
      // Where the photo library lives (not APP_DATA_DIR, which is app-internal downloads), and
      // which kind of install this is, so the web app never has to infer the mode from a 404.
      dataDir: DATA_DIR,
      deploymentMode: SINGLE_USER_MODE ? "desktop" : "server",
      // "running" while a fresh server is still loading its species/region catalog.
      catalogLoading: catalogFirstBootState(),
      libraryRoots: SINGLE_USER_MODE ? [] : LIBRARY_ROOTS,
    };
  });

  app.put<{ Body: OrganizeBody }>("/settings/organize-originals", { preHandler: requireAuth }, async (request, reply) => {
    const { enabled } = request.body ?? {};
    if (typeof enabled !== "boolean") return reply.code(400).send({ error: "enabled must be a boolean" });
    await pool.query(`UPDATE users SET organize_originals_by_year = $1 WHERE id = $2`, [enabled, request.user!.id]);
    return { organizeOriginalsByYear: enabled };
  });

  // Same "toggle only changes future uploads" contract as organize-originals above — an
  // outermost folder level named after whatever free-text location label a user typed at
  // import time (migration 093), not derived from GPS.
  app.put<{ Body: OrganizeBody }>("/settings/organize-originals-by-location", { preHandler: requireAuth }, async (request, reply) => {
    const { enabled } = request.body ?? {};
    if (typeof enabled !== "boolean") return reply.code(400).send({ error: "enabled must be a boolean" });
    await pool.query(`UPDATE users SET organize_originals_by_location = $1 WHERE id = $2`, [enabled, request.user!.id]);
    return { organizeOriginalsByLocation: enabled };
  });

  // Moved off the collection page's per-view filter bar (migration 038) — a persisted account
  // preference instead, so it's decided once rather than re-checked on every region.
  app.put<{ Body: { enabled?: boolean } }>("/settings/hide-obscure-species", { preHandler: requireAuth }, async (request, reply) => {
    const { enabled } = request.body ?? {};
    if (typeof enabled !== "boolean") return reply.code(400).send({ error: "enabled must be a boolean" });
    await pool.query(`UPDATE users SET hide_obscure_species = $1 WHERE id = $2`, [enabled, request.user!.id]);
    return { hideObscureSpecies: enabled };
  });

  // See migration 068's own comment — a separate toggle from hide-obscure-species itself, since
  // this changes WHICH depth counts as obscure (recreational ~60m vs technical diving's 120m)
  // rather than whether obscurity hiding is on at all.
  app.put<{ Body: { enabled?: boolean } }>("/settings/technical-diving", { preHandler: requireAuth }, async (request, reply) => {
    const { enabled } = request.body ?? {};
    if (typeof enabled !== "boolean") return reply.code(400).send({ error: "enabled must be a boolean" });
    await pool.query(`UPDATE users SET technical_diving = $1 WHERE id = $2`, [enabled, request.user!.id]);
    return { technicalDiving: enabled };
  });

  // Controls folder naming + EXIF species tags app-wide (see speciesFolderName.ts's own
  // composeSpeciesName comment for exactly how these four parts combine). Order in the array IS
  // display order — the first part that actually resolves for a given species becomes the
  // unparenthesized primary name, the rest are appended in parens. 'aba_code' is only ever
  // accepted when abaCodesAvailable() is true — a species without a given part (most
  // non-North-American birds for aba_code; any non-bird, or a bird eBird's own taxonomy doesn't
  // cover, for ebird_code) still falls back gracefully regardless of this setting, handled in
  // application code, not here; this check just stops the setting from being turned on when it
  // would never do anything.
  const SPECIES_NAMING_STYLES = new Set(["common", "latin", "aba_code", "ebird_code", "tree"]);
  app.put<{ Body: { styles?: string[] } }>("/settings/species-naming-style", { preHandler: requireAuth }, async (request, reply) => {
    const { styles } = request.body ?? {};
    if (!Array.isArray(styles) || styles.some((s) => !SPECIES_NAMING_STYLES.has(s))) {
      return reply.code(400).send({ error: "styles must be an array containing only: common, latin, aba_code, ebird_code, tree" });
    }
    if (styles.includes("aba_code") && !(await abaCodesAvailable())) {
      return reply.code(400).send({ error: "No downloaded pack has any ABA-coded species yet" });
    }
    // De-dupe while preserving the FIRST occurrence's position — order is meaningful now (it's
    // the display order), unlike a plain Set which would silently keep a later duplicate's
    // position instead.
    const deduped = styles.filter((s, i) => styles.indexOf(s) === i);
    await pool.query(`UPDATE users SET species_naming_styles = $1 WHERE id = $2`, [deduped, request.user!.id]);
    return { speciesNamingStyles: deduped };
  });

  // Experimental (see species/embeddings.ts) — on by default since it's purely local/on-device,
  // but a user may still want to turn off the suggestion cards while it's being tuned.
  app.put<{ Body: { enabled?: boolean } }>("/settings/species-suggest", { preHandler: requireAuth }, async (request, reply) => {
    const { enabled } = request.body ?? {};
    if (typeof enabled !== "boolean") return reply.code(400).send({ error: "enabled must be a boolean" });
    await pool.query(`UPDATE users SET species_suggest_enabled = $1 WHERE id = $2`, [enabled, request.user!.id]);
    return { speciesSuggestEnabled: enabled };
  });

  // Off by default (unlike species-suggest) — this is a live, uncached third-party lookup with
  // no local dataset behind it (see species/routes.ts's /species/inat-search and
  // /species/other-taxa), a deliberately different default from the on-device suggestion
  // feature above.
  app.put<{ Body: { enabled?: boolean } }>("/settings/any-taxa-search", { preHandler: requireAuth }, async (request, reply) => {
    const { enabled } = request.body ?? {};
    if (typeof enabled !== "boolean") return reply.code(400).send({ error: "enabled must be a boolean" });
    await pool.query(`UPDATE users SET any_taxa_search_enabled = $1 WHERE id = $2`, [enabled, request.user!.id]);
    return { anyTaxaSearchEnabled: enabled };
  });

  // Same "check first, apply on demand" shape as the pack-update flow (offlinePacks/routes.ts) —
  // see catalogSeedUpdate.ts's own header comment for why this needs to exist at all (the
  // fresh-install-only restore path never reaches an already-running install).
  app.get("/settings/catalog-update", { preHandler: requireAuth }, async (request) => {
    return checkCatalogUpdate(pool, request.user!.id);
  });

  // Background job + poll (see lib/job.ts): download, then one-transaction apply, then the
  // gallery vectors when the model is installed.
  app.post("/settings/catalog-update/apply", { preHandler: requireAuth }, async (_request, reply) => {
    if (!startCatalogUpdateJob(pool)) return reply.code(409).send({ error: "A catalog update is already running" });
    return { started: true };
  });

  app.get("/settings/catalog-update/status", { preHandler: requireAuth }, async () => catalogUpdate.status);

  app.post("/settings/catalog-update/cancel", { preHandler: requireAuth }, async () => ({ cancelled: catalogUpdate.cancel() }));

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
      species_id: string | null;
      common_name: string | null;
      scientific_name: string | null;
      taxon_class: string | null;
      taken_at: Date | null;
    }>(
      `SELECT o.id, o.ref, o.kind, o.capture_id,
              COALESCE(c.species_id, o.species_id) AS species_id,
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
    // A folder only changes when the resolved species label itself changed (composeSpeciesName
    // is a pure function of species + the current naming style), so "this file needed to move"
    // is exactly the same condition as "this capture's embedded EXIF/XMP label is now stale" —
    // collect distinct captures here and refresh both once the move loop finishes, rather than
    // redundantly re-writing metadata for every original (RAW + JPEG) of the same capture.
    const captureIdsToResync = new Set<string>();
    for (const original of originalsRes.rows) {
      if (!original.species_id || !original.scientific_name || !existsSync(original.ref)) {
        skipped++;
        continue;
      }
      // Unmatched RAWs (capture_id NULL, filed straight into a species' own folder) have no
      // captures.taken_at to read a year from — the file's own EXIF is the only place left to
      // look. Read lazily, only for exactly this case, rather than for every original.
      const takenAt = original.capture_id ? original.taken_at : (await extractExif(original.ref)).takenAt;

      const folder = originalsFolder(ORIGINALS_DIR, {
        organizeByYear,
        speciesFolderName: await resolveSpeciesFolderName(userId, original.species_id),
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
        // Clears volume_id/volume_relative_path too — a foreign-import file organized here now
        // lives inside ORIGINALS_DIR on the primary library, not on whatever external volume it
        // was originally tracked against, so keeping those columns set would make drive-
        // reconnect logic look for it in the wrong place.
        await pool.query(`UPDATE originals SET ref = $1, volume_id = NULL, volume_relative_path = NULL WHERE id = $2`, [
          dest,
          original.id,
        ]);
        moved++;
        if (original.capture_id) captureIdsToResync.add(original.capture_id);
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

    // Best-effort, same as every other call site of these two — a photo's folder having moved
    // successfully is the important part; a stale embedded label or XMP sidecar is recoverable
    // (the next reassignment or reorganize pass fixes it) and shouldn't fail the whole request.
    for (const captureId of captureIdsToResync) {
      await resyncSpeciesMetadata(userId, captureId).catch(() => {});
      await syncCaptureXmpSidecarsLogged(userId, captureId);
    }

    return { moved, skipped, failed, total: originalsRes.rows.length };
  });

  // Readable on every install; only desktop can change it from the UI (a server's library
  // folder is its LIFER_STORAGE_DIR bind mount, set in docker-compose).
  app.get("/settings/storage", { preHandler: requireAuth }, async () => {
    return { dataDir: DATA_DIR, changeable: SINGLE_USER_MODE };
  });

  app.get<{ Querystring: { path?: string } }>(
    "/settings/browse-directory",
    { preHandler: requireAuth },
    async (request, reply) => {
      // On a server the browser is confined to the allowed roots: with no path it lists them,
      // and it can't climb above one (see lib/allowedPaths.ts).
      if (!SINGLE_USER_MODE && !request.query.path) {
        return {
          path: null,
          parent: null,
          entries: allowedRoots().map((r) => ({ name: r.label, path: r.path })),
        };
      }
      const requested = request.query.path || os.homedir();
      if (!path.isAbsolute(requested)) return reply.code(400).send({ error: "path must be absolute" });
      const target = assertAllowedPath(requested);
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
      const parentAllowed = parent !== target && (SINGLE_USER_MODE || allowedRootFor(parent) != null);
      return {
        path: target,
        parent: parentAllowed ? parent : null,
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
        await client.query("ROLLBACK").catch(() => {});
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
  // silently dropped. Only one job runs at a time (createJob's synchronous claim guards
  // re-entry). Live counters are top-level fields; `result` holds the final tally.
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
  const migrationJob = createJob<MigrationResult, MigrationExtra>("migrate-to-server", {
    serverUrl: null,
    migrated: 0,
    skipped: 0,
    failed: 0,
  });

  async function runMigrationJob(ctx: JobContext<MigrationResult>, baseUrl: string, cookieHeader: string, userId: string): Promise<MigrationResult> {
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

    const speciesIdCache = new Map<string, string | null>();
    async function resolveRemoteSpeciesId(scientificName: string): Promise<string | null> {
      if (speciesIdCache.has(scientificName)) return speciesIdCache.get(scientificName) ?? null;
      let remoteId: string | null = null;
      try {
        const res = await fetch(`${baseUrl}/api/species?q=${encodeURIComponent(scientificName)}`, {
          headers: { Cookie: cookieHeader },
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
      // Only a real JPEG/PNG original can be re-uploaded as a photo, the /uploads endpoint
      // only accepts those two formats (see ACCEPTED_PHOTO_EXTENSION_BY_MIMETYPE), so a
      // capture with no original on disk (only the app's own internal WebP derivative) has
      // nothing valid to migrate. Permanent, not transient, marked 'skipped' so it's never
      // retried on a later run.
      if (!row.jpeg_ref || !existsSync(row.jpeg_ref)) {
        await markCapture(row.capture_id, "skipped");
        job.skipped++;
        bump();
        continue;
      }
      const remoteSpeciesId = await resolveRemoteSpeciesId(row.scientific_name);
      if (!remoteSpeciesId) {
        // Could be transient (remote server hiccup), 'failed', not 'skipped', so it's
        // retried on the next run instead of given up on permanently.
        await markCapture(row.capture_id, "failed");
        job.failed++;
        bump();
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
        // Generous: one upload can carry a large RAW over a slow link.
        const uploadRes = await fetch(`${baseUrl}/api/uploads`, {
          method: "POST",
          headers: { Cookie: cookieHeader },
          body: form,
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(15 * 60_000)]),
        });
        if (uploadRes.ok) {
          await markCapture(row.capture_id, "migrated");
          job.migrated++;
        } else {
          await markCapture(row.capture_id, "failed");
          job.failed++;
        }
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

  app.get("/settings/migrate-to-server/status", { preHandler: requireAuth }, async (_request, reply) => {
    if (!requireDesktopMode(reply)) return;
    return migrationJob.status;
  });

  // Stops between captures. The capture in flight either lands (and is marked) or stays
  // unmarked and is retried next run.
  app.post("/settings/migrate-to-server/cancel", { preHandler: requireAuth }, async (_request, reply) => {
    if (!requireDesktopMode(reply)) return;
    return { cancelled: migrationJob.cancel() };
  });

  app.post<{ Body: MigrateBody }>("/settings/migrate-to-server", { preHandler: requireAuth }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    if (migrationJob.status.running) {
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
      return reply.code(400).send({ error: `Couldn't reach that server: ${(err as Error).message}` });
    }

    // The claim happens here, after the (slow) login, but start() is atomic: a second request
    // that also got this far gets false and a 409 instead of a second concurrent run.
    const userId = request.user!.id;
    const started = migrationJob.start((ctx) => runMigrationJob(ctx, baseUrl, cookieHeader, userId), { serverUrl: baseUrl });
    if (!started) return reply.code(409).send({ error: "A migration to a server is already in progress" });

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

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM user_species WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM captures WHERE user_id = $1`, [userId]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    // The captures/photos rows are gone (cascaded), but the actual files on disk aren't
    // touched by that delete — clear the derivative/original folders directly. Recreated
    // empty rather than removed outright, since DATA_DIR itself (and its expected
    // subfolders) needs to keep existing for the next photo this install ever gets.
    const clearedDirs = [path.join(APP_DATA_DIR, "display"), path.join(APP_DATA_DIR, "medium"), path.join(APP_DATA_DIR, "thumb")];
    if (ownsWholeFolder) clearedDirs.unshift(ORIGINALS_DIR);
    for (const dir of clearedDirs) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
    }
    for (const file of managedFiles) {
      if (!isWithin(path.resolve(ORIGINALS_DIR), path.resolve(file))) continue;
      const sidecar = findSidecarPath(file);
      rmSync(file, { force: true });
      if (sidecar) rmSync(sidecar, { force: true });
      removeEmptyDirsUpward(path.dirname(file), ORIGINALS_DIR);
    }
    // Pre-fix derivative caches that migrateDerivativesLocation couldn't move, if any. Not
    // recreated: nothing writes there anymore.
    if (DATA_DIR !== APP_DATA_DIR) {
      for (const sub of ["display", "thumb"]) rmSync(path.join(DATA_DIR, sub), { recursive: true, force: true });
    }

    return { ok: true };
  });

  // Offline basemap download (see config.ts's MAP_DOWNLOAD_URL comment for why this is opt-in
  // rather than bundled). Streams straight to disk instead of buffering the ~500MB response in
  // memory, and reports progress via byte counts rather than percent so the frontend doesn't
  // need to guess at a total when the server doesn't send Content-Length. Not desktop-only
  // (requireDesktopMode) — a self-hosted server deployment wants this exact same opt-in
  // download, into the same MAPS_DIR the static-file route in index.ts already serves.
  const mapJob = createJob<{ bytes: number }>("offline-map");
  const MAP_FILE_PATH = path.join(MAPS_DIR, "world-z8.pmtiles");

  app.get("/settings/map/status", { preHandler: requireAuth }, async () => ({
    available: MAP_DOWNLOAD_URL != null,
    downloaded: existsSync(MAP_FILE_PATH),
    // The real on-disk size, not the job's downloadedBytes, that's in-memory download-progress
    // state that resets on every server restart, so it can't be trusted to still reflect
    // an already-downloaded map's size once this process has restarted since the download.
    sizeBytes: existsSync(MAP_FILE_PATH) ? statSync(MAP_FILE_PATH).size : null,
    ...mapJob.status,
    // Legacy alias for `running`, kept until every client reads the shared JobStatus shape.
    downloading: mapJob.status.running,
  }));

  app.post("/settings/map/download", { preHandler: requireAuth }, async (_request, reply) => {
    const url = MAP_DOWNLOAD_URL;
    if (!url) return reply.code(400).send({ error: "No offline map is configured for this instance" });
    const started = mapJob.start(
      async (ctx) => {
        const tmpPath = `${MAP_FILE_PATH}.download`;
        mkdirSync(MAPS_DIR, { recursive: true });
        const { bytes } = await downloadToFile(url, tmpPath, {
          signal: ctx.signal,
          onProgress: (downloadedBytes, totalBytes) => ctx.update({ downloadedBytes, totalBytes }),
        });
        ctx.throwIfCancelled();
        renameSync(tmpPath, MAP_FILE_PATH);
        return { bytes };
      },
      { phase: "downloading", downloadedBytes: 0 },
    );
    if (!started) return reply.code(409).send({ error: "The map is already downloading" });
    return { started: true };
  });

  app.post("/settings/map/download/cancel", { preHandler: requireAuth }, async () => ({ cancelled: mapJob.cancel() }));

  // Deletes the downloaded map to reclaim disk space — the reverse of the opt-in above.
  app.delete("/settings/map", { preHandler: requireAuth }, async () => {
    rmSync(MAP_FILE_PATH, { force: true });
    return { ok: true };
  });

  // The CLIP embedding model (species auto-suggest + Gallery semantic/content search) — same
  // opt-in/download/offload shape as the offline basemap above, not bundled on any platform (see
  // config.ts's EMBEDDING_MODEL_URL comment). Two halves are downloaded together here even
  // though they're fetched by two different mechanisms (embeddings.ts streams the vision .onnx
  // file directly; textEmbedding.ts defers to @xenova/transformers' own cache-and-fetch) — the
  // user only ever sees "the model" as one thing.
  function dirSizeBytes(dir: string): number {
    if (!existsSync(dir)) return 0;
    let total = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      total += entry.isDirectory() ? dirSizeBytes(entryPath) : statSync(entryPath).size;
    }
    return total;
  }

  // JobStatus plus `downloaded`/`sizeBytes`; `downloading` stays as an alias of `running` for
  // older web builds.
  app.get("/settings/embedding-model/status", { preHandler: requireAuth }, async () => ({
    ...modelDownload.status,
    downloading: modelDownload.status.running,
    downloaded: isModelDownloaded() && isTextModelDownloaded(),
    sizeBytes: dirSizeBytes(MODEL_DIR) || null,
  }));

  app.post("/settings/embedding-model/download", { preHandler: requireAuth }, async (_request, reply) => {
    if (!startModelDownloadJob(pool, app.log)) return reply.code(409).send({ error: "The model is already downloading" });
    return { started: true };
  });

  app.post("/settings/embedding-model/download/cancel", { preHandler: requireAuth }, async () => ({
    cancelled: modelDownload.cancel(),
  }));

  // Offloading also turns off species-suggest for every user rather than leaving it silently
  // broken — see SpeciesPicker/PhotoImportRows, which would otherwise keep showing a suggestion
  // UI that can never return results once the model backing it is gone. Not scoped to
  // request.user!.id: SINGLE_USER_MODE aside, a shared server deployment offloading the model
  // affects everyone's suggestions equally, since there's only ever one copy of the model.
  app.delete("/settings/embedding-model", { preHandler: requireAuth }, async () => {
    offloadModel();
    await pool.query(`UPDATE users SET species_suggest_enabled = false`);
    return { ok: true };
  });
}
