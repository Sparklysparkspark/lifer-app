import { existsSync, readdirSync } from "node:fs";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireAuth } from "../auth/session.js";
import { DATA_DIR, ORIGINALS_DIR, SINGLE_USER_MODE, LIBRARY_ROOTS } from "../config.js";
import { allowedRootFor, allowedRoots, assertAllowedPath } from "../lib/allowedPaths.js";
import { LIBRARY_UPLOAD_DIR_NAME } from "../lib/uploadWorkDir.js";
import { originalsFolder } from "../uploads/organizedPath.js";
import { resolveSpeciesFolderName } from "../uploads/speciesFolderName.js";
import { extractExif } from "../uploads/exif.js";
import { syncCaptureXmpSidecarsLogged } from "../uploads/xmpSidecarSync.js";
import { resyncSpeciesMetadata } from "../captures/routes.js";
import { checkCatalogUpdate, startCatalogUpdateJob, catalogUpdate, catalogFirstBootState } from "../species/catalogSeedUpdate.js";
import { createJob, type JobContext } from "../lib/job.js";
import { removeEmptyDirsUpward } from "../lib/fsCleanup.js";
import { log } from "../lib/log.js";
import { getUserFileSettings } from "../lib/userFileSettings.js";
import { assetRoutes } from "./assets.js";
import { migrateToServerRoutes } from "./migrateToServer.js";
import { storageMoveRoutes } from "./storageMove.js";

export { recoverInterruptedStorageMigration } from "./storageMove.js";

// Lifer's own subfolders, hidden when picking a library folder (uploads: lib/uploadWorkDir.ts).
const LIFER_INTERNAL_DIR_NAMES = new Set(["Lifer Photos", "display", "thumb", "reference-display", "reference-thumb", "maps", "tmp", "uploads", LIBRARY_UPLOAD_DIR_NAME]);

interface OrganizeBody {
  enabled?: boolean;
}

// ABA alpha codes only exist for North and Central American birds, so the naming option is only
// offered once a downloaded pack actually has aba-coded species.
async function abaCodesAvailable(): Promise<boolean> {
  const res = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM pack_species ps JOIN species s ON s.id = ps.species_id WHERE s.aba_code IS NOT NULL
     ) AS available`,
  );
  return res.rows[0]?.available ?? false;
}

// Toggling an organize setting only changes where future uploads land; moving existing files is
// the explicit POST /settings/reorganize-originals. Only managed originals are ever moved.
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

  // Adds an outer folder named after the location label typed at import (not GPS). Future
  // uploads only, like organize-originals.
  app.put<{ Body: OrganizeBody }>("/settings/organize-originals-by-location", { preHandler: requireAuth }, async (request, reply) => {
    const { enabled } = request.body ?? {};
    if (typeof enabled !== "boolean") return reply.code(400).send({ error: "enabled must be a boolean" });
    await pool.query(`UPDATE users SET organize_originals_by_location = $1 WHERE id = $2`, [enabled, request.user!.id]);
    return { organizeOriginalsByLocation: enabled };
  });

  // An account preference, so it's decided once rather than per region.
  app.put<{ Body: { enabled?: boolean } }>("/settings/hide-obscure-species", { preHandler: requireAuth }, async (request, reply) => {
    const { enabled } = request.body ?? {};
    if (typeof enabled !== "boolean") return reply.code(400).send({ error: "enabled must be a boolean" });
    await pool.query(`UPDATE users SET hide_obscure_species = $1 WHERE id = $2`, [enabled, request.user!.id]);
    return { hideObscureSpecies: enabled };
  });

  // Changes which depth counts as obscure (recreational ~60m vs technical 120m), separately
  // from whether obscure species are hidden at all.
  app.put<{ Body: { enabled?: boolean } }>("/settings/technical-diving", { preHandler: requireAuth }, async (request, reply) => {
    const { enabled } = request.body ?? {};
    if (typeof enabled !== "boolean") return reply.code(400).send({ error: "enabled must be a boolean" });
    await pool.query(`UPDATE users SET technical_diving = $1 WHERE id = $2`, [enabled, request.user!.id]);
    return { technicalDiving: enabled };
  });

  // Folder naming and EXIF species tags app-wide (see composeSpeciesName). Array order is display
  // order: the first part that resolves is the primary name, the rest go in parens. aba_code is
  // refused when no pack has any, since it would never do anything.
  const SPECIES_NAMING_STYLES = new Set(["common", "latin", "aba_code", "ebird_code", "tree"]);
  app.put<{ Body: { styles?: string[] } }>("/settings/species-naming-style", { preHandler: requireAuth }, async (request, reply) => {
    const { styles } = request.body ?? {};
    if (!Array.isArray(styles) || styles.some((s) => !SPECIES_NAMING_STYLES.has(s))) {
      return reply.code(400).send({ error: "styles must be an array containing only: common, latin, aba_code, ebird_code, tree" });
    }
    if (styles.includes("aba_code") && !(await abaCodesAvailable())) {
      return reply.code(400).send({ error: "No downloaded pack has any ABA-coded species yet" });
    }
    // De-dupe keeping each style's first position, since order is display order.
    const deduped = styles.filter((s, i) => styles.indexOf(s) === i);
    await pool.query(`UPDATE users SET species_naming_styles = $1 WHERE id = $2`, [deduped, request.user!.id]);
    return { speciesNamingStyles: deduped };
  });

  // On by default since matching runs on-device; users can still turn the suggestion cards off.
  app.put<{ Body: { enabled?: boolean } }>("/settings/species-suggest", { preHandler: requireAuth }, async (request, reply) => {
    const { enabled } = request.body ?? {};
    if (typeof enabled !== "boolean") return reply.code(400).send({ error: "enabled must be a boolean" });
    await pool.query(`UPDATE users SET species_suggest_enabled = $1 WHERE id = $2`, [enabled, request.user!.id]);
    return { speciesSuggestEnabled: enabled };
  });

  // Off by default: a live third-party lookup (/species/inat-search, /species/other-taxa).
  app.put<{ Body: { enabled?: boolean } }>("/settings/any-taxa-search", { preHandler: requireAuth }, async (request, reply) => {
    const { enabled } = request.body ?? {};
    if (typeof enabled !== "boolean") return reply.code(400).send({ error: "enabled must be a boolean" });
    await pool.query(`UPDATE users SET any_taxa_search_enabled = $1 WHERE id = $2`, [enabled, request.user!.id]);
    return { anyTaxaSearchEnabled: enabled };
  });

  // Check first, apply on demand, like pack updates: the fresh-install seed never reaches a
  // running install.
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

  // A background job, so a dropped connection doesn't stop it halfway. POST still waits for the
  // result by default; ?background=1 returns at once for polling.
  interface ReorganizeCounts {
    moved: number;
    skipped: number;
    failed: number;
  }
  interface ReorganizeResult extends ReorganizeCounts {
    total: number;
  }
  const reorganizeJob = createJob<ReorganizeResult, ReorganizeCounts>("reorganize-originals", { moved: 0, skipped: 0, failed: 0 });

  async function runReorganize(ctx: JobContext<ReorganizeResult, ReorganizeCounts>, userId: string): Promise<ReorganizeResult> {
    const counts = reorganizeJob.status;
    const { organizeByYear } = await getUserFileSettings(userId);

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
    const total = originalsRes.rows.length;
    ctx.update({ phase: "moving", total, processed: 0 });
    const bump = () => ctx.update({ processed: counts.moved + counts.skipped + counts.failed });

    // A file moves exactly when its species label changed, which also makes its embedded EXIF/XMP
    // label stale. Collect those captures and resync their metadata after the move loop.
    const captureIdsToResync = new Set<string>();
    for (const original of originalsRes.rows) {
      // Stops between files; the files already moved stay moved and get their metadata resynced.
      if (ctx.signal.aborted) break;
      ctx.update({ currentItem: path.basename(original.ref) });
      if (!original.species_id || !original.scientific_name || !existsSync(original.ref)) {
        counts.skipped++;
        bump();
        continue;
      }
      // Unmatched RAWs (capture_id NULL, filed straight into a species' own folder) have no
      // captures.taken_at to read a year from; the file's own EXIF is the only place left to look.
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
        counts.skipped++;
        bump();
        continue;
      }
      try {
        await mkdir(folder, { recursive: true });
        if (existsSync(dest)) {
          // Another original already sits at this organized path: skip rather than overwrite.
          counts.skipped++;
          bump();
          continue;
        }
        const oldFolder = path.dirname(original.ref);
        let copied = false;
        try {
          await rename(original.ref, dest);
        } catch {
          try {
            await copyFile(original.ref, dest);
          } catch (err) {
            await rm(dest, { force: true }).catch(() => {});
            throw err;
          }
          copied = true;
        }
        // Clears volume_id/volume_relative_path too: a foreign-import file organized here now
        // lives inside ORIGINALS_DIR on the primary library, not on its original external volume.
        try {
          await pool.query(`UPDATE originals SET ref = $1, volume_id = NULL, volume_relative_path = NULL WHERE id = $2`, [
            dest,
            original.id,
          ]);
        } catch (err) {
          // Put the file back so the row still points at it.
          if (copied) await rm(dest, { force: true }).catch(() => {});
          else await rename(dest, original.ref).catch(() => {});
          throw err;
        }
        if (copied) await rm(original.ref, { force: true });
        counts.moved++;
        if (original.capture_id) captureIdsToResync.add(original.capture_id);
        // Tidying the now-empty old folder is cosmetic, not part of the move.
        try {
          await removeEmptyDirsUpward(oldFolder, ORIGINALS_DIR);
        } catch (err) {
          log.warn(`[reorganize] Couldn't clean up ${oldFolder}: ${(err as Error).message}`);
        }
      } catch {
        counts.failed++;
      }
      bump();
    }

    // Best-effort: a stale embedded label or XMP sidecar is recoverable (the next reassignment or
    // reorganize pass fixes it) and shouldn't fail the whole job.
    ctx.update({ phase: "updating_metadata", currentItem: null });
    for (const captureId of captureIdsToResync) {
      await resyncSpeciesMetadata(userId, captureId).catch(() => {});
      await syncCaptureXmpSidecarsLogged(userId, captureId);
    }

    return { moved: counts.moved, skipped: counts.skipped, failed: counts.failed, total };
  }

  app.post<{ Querystring: { background?: string } }>("/settings/reorganize-originals", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.user!.id;
    if (!reorganizeJob.start((ctx) => runReorganize(ctx, userId), { phase: "preparing" })) {
      return reply.code(409).send({ error: "Photos are already being reorganized" });
    }
    if (request.query.background === "1") return { started: true };
    await reorganizeJob.settled();
    const status = reorganizeJob.status;
    if (status.error) return reply.code(500).send({ error: status.error, code: "reorganize_failed" });
    if (status.result) return status.result;
    const { moved, skipped, failed } = status;
    return { moved, skipped, failed, total: status.total ?? moved + skipped + failed };
  });

  app.get("/settings/reorganize-originals/status", { preHandler: requireAuth }, async () => reorganizeJob.status);

  app.post("/settings/reorganize-originals/cancel", { preHandler: requireAuth }, async () => ({ cancelled: reorganizeJob.cancel() }));

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

  await app.register(storageMoveRoutes);
  await app.register(migrateToServerRoutes);
  await app.register(assetRoutes);
}
