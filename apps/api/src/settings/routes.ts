import { existsSync, readdirSync } from "node:fs";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Type, type TSchema } from "typebox";
import { pool } from "@lifer/core/db.js";
import { requireAuth } from "../auth/session.js";
import { DATA_DIR, SINGLE_USER_MODE, LIBRARY_ROOTS } from "@lifer/core/config.js";
import { allowedRootFor, allowedRoots, assertAllowedPath } from "@lifer/core/lib/allowedPaths.js";
import { LIBRARY_UPLOAD_DIR_NAME } from "../lib/uploadWorkDir.js";
import { locateManagedOriginal, organizedFolderFor } from "../uploads/managedFolders.js";
import { extractExif } from "../uploads/exif.js";
import { syncCaptureXmpSidecarsLogged } from "../uploads/xmpSidecarSync.js";
import { resyncSpeciesMetadata } from "../captures/routes.js";
import {
  checkCatalogUpdate,
  startCatalogUpdateJob,
  catalogUpdate,
  catalogFirstBootState,
} from "../species/catalogSeedUpdate.js";
import { isWithheldPhotoFetchEnabled, setWithheldPhotoFetchEnabled } from "../species/withheldPhotos.js";
import { createJob, type JobContext } from "../lib/job.js";
import { removeEmptyDirsUpward } from "../lib/fsCleanup.js";
import { log } from "@lifer/core/lib/log.js";
import { getUserFileSettings } from "../lib/userFileSettings.js";
import { Flag, Nullable, replies, withSchemas } from "../lib/schema.js";
import { assetRoutes } from "./assets.js";
import { migrateToServerRoutes } from "./migrateToServer.js";
import { storageMoveRoutes } from "./storageMove.js";

export { recoverInterruptedStorageMigration } from "./storageMove.js";

// Lifer's own subfolders, hidden when picking a library folder (uploads: lib/uploadWorkDir.ts).
const LIFER_INTERNAL_DIR_NAMES = new Set([
  "Lifer Photos",
  "display",
  "thumb",
  "reference-display",
  "reference-thumb",
  "maps",
  "tmp",
  "uploads",
  LIBRARY_UPLOAD_DIR_NAME,
]);

// Every on/off setting is a PUT of `{ enabled }` answered with the saved value under its own name.
const EnabledBody = Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false });
const toggleSchema = (name: string) => ({
  body: EnabledBody,
  response: replies(Type.Object({ [name]: Type.Boolean() }) as TSchema),
});

const Started = Type.Object({ started: Type.Boolean() });
const Cancelled = Type.Object({ cancelled: Type.Boolean() });

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
export async function settingsRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.get("/settings", { preValidation: requireAuth, schema: {} }, async (request) => {
    const res = await pool.query<{
      organize_originals_by_year: boolean;
      organize_originals_by_location: boolean;
      hide_obscure_species: boolean;
      species_suggest_enabled: boolean;
      any_taxa_search_enabled: boolean;
      technical_diving: boolean;
      species_naming_styles: string[];
      locale: string | null;
    }>(
      `SELECT organize_originals_by_year, organize_originals_by_location, hide_obscure_species, species_suggest_enabled, any_taxa_search_enabled, technical_diving, species_naming_styles, locale FROM users WHERE id = $1`,
      [request.user!.id],
    );
    return {
      organizeOriginalsByYear: res.rows[0]?.organize_originals_by_year ?? false,
      organizeOriginalsByLocation: res.rows[0]?.organize_originals_by_location ?? false,
      hideObscureSpecies: res.rows[0]?.hide_obscure_species ?? true,
      speciesSuggestEnabled: res.rows[0]?.species_suggest_enabled ?? true,
      anyTaxaSearchEnabled: res.rows[0]?.any_taxa_search_enabled ?? false,
      // Per install, not per account: the photos are shared by everyone on it.
      fetchWithheldPhotos: await isWithheldPhotoFetchEnabled(),
      technicalDiving: res.rows[0]?.technical_diving ?? false,
      speciesNamingStyles: res.rows[0]?.species_naming_styles ?? [],
      // The interface language, or null for automatic (the browser's or system's language).
      locale: res.rows[0]?.locale ?? null,
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

  app.put(
    "/settings/organize-originals",
    { preValidation: requireAuth, schema: toggleSchema("organizeOriginalsByYear") },
    async (request) => {
      const { enabled } = request.body;
      await pool.query(`UPDATE users SET organize_originals_by_year = $1 WHERE id = $2`, [enabled, request.user!.id]);
      return { organizeOriginalsByYear: enabled };
    },
  );

  // Adds an outer folder named after the location label typed at import (not GPS). Future
  // uploads only, like organize-originals.
  app.put(
    "/settings/organize-originals-by-location",
    { preValidation: requireAuth, schema: toggleSchema("organizeOriginalsByLocation") },
    async (request) => {
      const { enabled } = request.body;
      await pool.query(`UPDATE users SET organize_originals_by_location = $1 WHERE id = $2`, [
        enabled,
        request.user!.id,
      ]);
      return { organizeOriginalsByLocation: enabled };
    },
  );

  // An account preference, so it's decided once rather than per region.
  app.put(
    "/settings/hide-obscure-species",
    { preValidation: requireAuth, schema: toggleSchema("hideObscureSpecies") },
    async (request) => {
      const { enabled } = request.body;
      await pool.query(`UPDATE users SET hide_obscure_species = $1 WHERE id = $2`, [enabled, request.user!.id]);
      return { hideObscureSpecies: enabled };
    },
  );

  // Changes which depth counts as obscure (recreational ~60m vs technical 120m), separately
  // from whether obscure species are hidden at all.
  app.put(
    "/settings/technical-diving",
    { preValidation: requireAuth, schema: toggleSchema("technicalDiving") },
    async (request) => {
      const { enabled } = request.body;
      await pool.query(`UPDATE users SET technical_diving = $1 WHERE id = $2`, [enabled, request.user!.id]);
      return { technicalDiving: enabled };
    },
  );

  // Folder naming and EXIF species tags app-wide (see composeSpeciesName). Array order is display
  // order: the first part that resolves is the primary name, the rest go in parens. aba_code is
  // refused when no pack has any, since it would never do anything.
  const SpeciesNamingStyle = Type.Enum(["common", "latin", "aba_code", "ebird_code", "tree"]);
  app.put(
    "/settings/species-naming-style",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object({ styles: Type.Array(SpeciesNamingStyle) }, { additionalProperties: false }),
        response: replies(Type.Object({ speciesNamingStyles: Type.Array(SpeciesNamingStyle) })),
      },
    },
    async (request, reply) => {
      const { styles } = request.body;
      if (styles.includes("aba_code") && !(await abaCodesAvailable())) {
        return reply.code(400).send({ error: "No downloaded pack has any ABA-coded species yet" });
      }
      // De-dupe keeping each style's first position, since order is display order.
      const deduped = styles.filter((s, i) => styles.indexOf(s) === i);
      await pool.query(`UPDATE users SET species_naming_styles = $1 WHERE id = $2`, [deduped, request.user!.id]);
      return { speciesNamingStyles: deduped };
    },
  );

  // The interface language: a BCP 47 tag like "de" or "zh-Hans", or null for automatic. The web app
  // falls back to English for a language it has no translation of, so any well-formed tag is kept.
  const LocaleTag = Type.String({ pattern: "^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$", maxLength: 35 });
  app.put(
    "/settings/locale",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object({ locale: Nullable(LocaleTag) }, { additionalProperties: false }),
        response: replies(Type.Object({ locale: Nullable(Type.String()) })),
      },
    },
    async (request) => {
      const { locale } = request.body;
      await pool.query(`UPDATE users SET locale = $1 WHERE id = $2`, [locale, request.user!.id]);
      return { locale };
    },
  );

  // On by default since matching runs on-device; users can still turn the suggestion cards off.
  app.put(
    "/settings/species-suggest",
    { preValidation: requireAuth, schema: toggleSchema("speciesSuggestEnabled") },
    async (request) => {
      const { enabled } = request.body;
      await pool.query(`UPDATE users SET species_suggest_enabled = $1 WHERE id = $2`, [enabled, request.user!.id]);
      return { speciesSuggestEnabled: enabled };
    },
  );

  // Off by default: a live third-party lookup (/species/inat-search, /species/other-taxa).
  app.put(
    "/settings/any-taxa-search",
    { preValidation: requireAuth, schema: toggleSchema("anyTaxaSearchEnabled") },
    async (request) => {
      const { enabled } = request.body;
      await pool.query(`UPDATE users SET any_taxa_search_enabled = $1 WHERE id = $2`, [enabled, request.user!.id]);
      return { anyTaxaSearchEnabled: enabled };
    },
  );

  // On by default: downloads, for personal viewing, the iNaturalist photos packs can't include
  // for licensing reasons (species/withheldPhotos.ts). Turning it off stops a running fetch.
  app.put(
    "/settings/fetch-withheld-photos",
    { preValidation: requireAuth, schema: toggleSchema("fetchWithheldPhotos") },
    async (request) => {
      const { enabled } = request.body;
      await setWithheldPhotoFetchEnabled(enabled);
      return { fetchWithheldPhotos: enabled };
    },
  );

  // Check first, apply on demand, like pack updates: the fresh-install seed never reaches a
  // running install.
  app.get("/settings/catalog-update", { preValidation: requireAuth, schema: {} }, async (request) => {
    return checkCatalogUpdate(pool, request.user!.id);
  });

  // Background job + poll (see lib/job.ts): download, then one-transaction apply, then the
  // gallery vectors when the model is installed.
  app.post(
    "/settings/catalog-update/apply",
    { preValidation: requireAuth, schema: { response: replies(Started) } },
    async (_request, reply) => {
      if (!startCatalogUpdateJob(pool)) return reply.code(409).send({ error: "A catalog update is already running" });
      return { started: true };
    },
  );

  app.get(
    "/settings/catalog-update/status",
    { preValidation: requireAuth, schema: {} },
    async () => catalogUpdate.status,
  );

  app.post(
    "/settings/catalog-update/cancel",
    { preValidation: requireAuth, schema: { response: replies(Cancelled) } },
    async () => ({ cancelled: catalogUpdate.cancel() }),
  );

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
  const reorganizeJob = createJob<ReorganizeResult, ReorganizeCounts>("reorganize-originals", {
    moved: 0,
    skipped: 0,
    failed: 0,
  });

  async function runReorganize(
    ctx: JobContext<ReorganizeResult, ReorganizeCounts>,
    userId: string,
  ): Promise<ReorganizeResult> {
    const counts = reorganizeJob.status;
    const settings = await getUserFileSettings(userId);

    const originalsRes = await pool.query<{
      id: string;
      ref: string;
      kind: string;
      capture_id: string | null;
      species_id: string | null;
      scientific_name: string | null;
      taken_at: Date | null;
      location_label: string | null;
      volume_id: string | null;
      volume_relative_path: string | null;
      trip_destination: string | null;
    }>(
      // captures_all without trashed ones: a hidden photo's files are organized like any other.
      `SELECT o.id, o.ref, o.kind, o.capture_id, o.volume_id, o.volume_relative_path,
              COALESCE(c.species_id, o.species_id) AS species_id,
              COALESCE(s1.scientific_name, s2.scientific_name) AS scientific_name,
              c.taken_at, c.location_label, t.destination_folder AS trip_destination
       FROM originals o
       LEFT JOIN captures_all c ON c.id = o.capture_id AND c.deleted_at IS NULL
       LEFT JOIN trips t ON t.id = c.trip_id
       LEFT JOIN species s1 ON s1.id = c.species_id
       LEFT JOIN species s2 ON s2.id = o.species_id
       WHERE o.managed = true AND o.ref_type = 'path' AND COALESCE(c.user_id, o.user_id) = $1`,
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
      // Each file is re-filed under the folder it was filed under (the library, its drive's
      // "Lifer Originals" folder or its trip's folder), never moved to another. One on a drive
      // that isn't connected, or outside every folder Lifer files into, is left alone.
      const location =
        original.species_id && original.scientific_name ? await locateManagedOriginal(userId, original) : null;
      if (!location?.root || !existsSync(location.path)) {
        counts.skipped++;
        bump();
        continue;
      }
      const current = location.path;
      // Unmatched RAWs (capture_id NULL, filed straight into a species' own folder) have no
      // captures.taken_at to read a year from; the file's own EXIF is the only place left to look.
      const takenAt = original.capture_id ? original.taken_at : (await extractExif(current)).takenAt;

      const folder = await organizedFolderFor(
        userId,
        location,
        { kind: original.kind, speciesId: original.species_id!, takenAt, locationLabel: original.location_label },
        settings,
      );
      const dest = folder ? path.join(folder, path.basename(current)) : current;
      if (!folder || path.resolve(dest) === path.resolve(current)) {
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
        const oldFolder = path.dirname(current);
        let copied = false;
        try {
          await rename(current, dest);
        } catch {
          try {
            await copyFile(current, dest);
          } catch (err) {
            await rm(dest, { force: true }).catch(() => {});
            throw err;
          }
          copied = true;
        }
        // A file on a drive or library root stays on it: its volume path follows the move.
        const volumeRelativePath = location.mountPath ? dest.slice(location.mountPath.length) : null;
        try {
          await pool.query(
            `UPDATE originals SET ref = $1, volume_relative_path = COALESCE($2, volume_relative_path) WHERE id = $3`,
            [dest, volumeRelativePath, original.id],
          );
        } catch (err) {
          // Put the file back so the row still points at it.
          if (copied) await rm(dest, { force: true }).catch(() => {});
          else await rename(dest, current).catch(() => {});
          throw err;
        }
        if (copied) await rm(current, { force: true });
        counts.moved++;
        if (original.capture_id) captureIdsToResync.add(original.capture_id);
        // Tidying the now-empty old folder is cosmetic, not part of the move.
        try {
          await removeEmptyDirsUpward(oldFolder, location.root);
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

  app.post(
    "/settings/reorganize-originals",
    {
      preValidation: requireAuth,
      schema: { querystring: Type.Object({ background: Flag("1 to start the job and return at once, for polling") }) },
    },
    async (request, reply) => {
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
    },
  );

  app.get(
    "/settings/reorganize-originals/status",
    { preValidation: requireAuth, schema: {} },
    async () => reorganizeJob.status,
  );

  app.post(
    "/settings/reorganize-originals/cancel",
    { preValidation: requireAuth, schema: { response: replies(Cancelled) } },
    async () => ({ cancelled: reorganizeJob.cancel() }),
  );

  app.get(
    "/settings/browse-directory",
    {
      preValidation: requireAuth,
      // The absolute-path and allowed-root checks stay in the handler (lib/allowedPaths.ts).
      schema: { querystring: Type.Object({ path: Type.Optional(Type.String()) }) },
    },
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
