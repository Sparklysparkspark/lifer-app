import { mkdir, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Type, type TSchema } from "typebox";
import { pool } from "@lifer/core/db.js";
import { requireAuth } from "../auth/session.js";
import { DATA_DIR, SINGLE_USER_MODE, LIBRARY_ROOTS } from "@lifer/core/config.js";
import { allowedRootFor, allowedRoots, assertAllowedPath } from "@lifer/core/lib/allowedPaths.js";
import { LIBRARY_UPLOAD_DIR_NAME } from "../lib/uploadWorkDir.js";
import {
  REORGANIZE_IDLE_COUNTS,
  runReorganize,
  type ReorganizeCounts,
  type ReorganizeResult,
} from "../uploads/reorganizeOriginals.js";
import {
  checkCatalogUpdate,
  startCatalogUpdateJob,
  catalogUpdate,
  catalogFirstBootState,
  catalogLoadProgress,
} from "../species/catalogSeedUpdate.js";
import { isWithheldPhotoFetchEnabled, setWithheldPhotoFetchEnabled } from "../species/withheldPhotos.js";
import { createJob, runningJobsProgress } from "../lib/job.js";
import { desktopOnly } from "./requireDesktopMode.js";
import { Flag, Nullable, replies, withSchemas } from "../lib/schema.js";
import { assetRoutes } from "./assets.js";
import { deleteLocalLibraryRoutes } from "./deleteLocalLibrary.js";
import { storageMoveRoutes } from "./storageMove.js";
import { AnyJobStatus, FolderLayout, ReorganizeOutcome, Settings } from "./responses.js";
import { FOLDER_LEVELS, type FolderLevel } from "@lifer/shared";
import { getUserFileSettings } from "../lib/userFileSettings.js";
import { folderLayoutExample } from "../uploads/managedFolders.js";
import { SpeciesNameDisplay, getSpeciesNameDisplay, setSpeciesNameDisplay } from "./speciesNameDisplay.js";

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

// The folder layout only changes where future uploads land; moving existing files is the explicit
// POST /settings/reorganize-originals. Only managed originals are ever moved.
export async function settingsRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  // The desktop app's taskbar and dock progress; a server answers 404 so the poll stops.
  app.get(
    "/settings/jobs/progress",
    {
      preValidation: [requireAuth, desktopOnly],
      schema: {
        response: replies(Type.Object({ running: Type.Integer(), progress: Nullable(Type.Number()) })),
      },
    },
    async () => runningJobsProgress(),
  );

  app.get("/settings", { preValidation: requireAuth, schema: { response: replies(Settings) } }, async (request) => {
    const res = await pool.query<{
      hide_obscure_species: boolean;
      species_suggest_enabled: boolean;
      any_taxa_search_enabled: boolean;
      technical_diving: boolean;
      species_naming_styles: string[];
      tips_enabled: boolean;
      tips_seen: string[];
      locale: string | null;
    }>(
      `SELECT hide_obscure_species, species_suggest_enabled, any_taxa_search_enabled, technical_diving, species_naming_styles, tips_enabled, tips_seen, locale FROM users WHERE id = $1`,
      [request.user!.id],
    );
    return {
      folderLayout: (await getUserFileSettings(request.user!.id)).layout,
      hideObscureSpecies: res.rows[0]?.hide_obscure_species ?? true,
      speciesSuggestEnabled: res.rows[0]?.species_suggest_enabled ?? true,
      anyTaxaSearchEnabled: res.rows[0]?.any_taxa_search_enabled ?? true,
      // Per install, not per account: the photos are shared by everyone on it.
      fetchWithheldPhotos: await isWithheldPhotoFetchEnabled(),
      technicalDiving: res.rows[0]?.technical_diving ?? false,
      speciesNamingStyles: res.rows[0]?.species_naming_styles ?? [],
      speciesNameDisplay: await getSpeciesNameDisplay(request.user!.id),
      tipsEnabled: res.rows[0]?.tips_enabled ?? true,
      tipsSeen: res.rows[0]?.tips_seen ?? [],
      // The interface language, or null for automatic (the browser's or system's language).
      locale: res.rows[0]?.locale ?? null,
      abaCodesAvailable: await abaCodesAvailable(),
      // Where the photo library lives (not APP_DATA_DIR, which is app-internal downloads), and
      // which kind of install this is, so the web app never has to infer the mode from a 404.
      dataDir: DATA_DIR,
      deploymentMode: SINGLE_USER_MODE ? ("desktop" as const) : ("server" as const),
      // "running" while a fresh server is still loading its species/region catalog.
      catalogLoading: catalogFirstBootState(),
      catalogProgress: catalogLoadProgress(),
      libraryRoots: SINGLE_USER_MODE ? [] : LIBRARY_ROOTS,
    };
  });

  app.put(
    "/settings/folder-layout",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object({ layout: FolderLayout }, { additionalProperties: false }),
        response: replies(Type.Object({ folderLayout: FolderLayout })),
      },
    },
    async (request) => {
      // Each level once, in the order given, like the naming styles.
      const layout = [...new Set(request.body.layout)];
      await pool.query(`UPDATE users SET folder_layout = $1 WHERE id = $2`, [layout, request.user!.id]);
      return { folderLayout: layout };
    },
  );

  // Where a layout would file one of the user's recent photos (one with a place, trip and date when
  // there is one, so most levels show), or a sample photo before there are any.
  app.get(
    "/settings/folder-layout/example",
    {
      preValidation: requireAuth,
      schema: {
        querystring: Type.Object({
          layout: Type.String({ maxLength: 500, description: "Levels, comma-separated, outermost first" }),
        }),
        response: replies(Type.Object({ path: Type.String(), sample: Type.Boolean() })),
      },
    },
    async (request, reply) => {
      const layout = request.query.layout.split(",").filter(Boolean);
      if (!layout.every((l): l is FolderLevel => (FOLDER_LEVELS as readonly string[]).includes(l)))
        return reply.code(400).send({ error: "Unknown folder level" });
      return folderLayoutExample(request.user!.id, layout);
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

  app.put("/settings/tips", { preValidation: requireAuth, schema: toggleSchema("tipsEnabled") }, async (request) => {
    const { enabled } = request.body;
    await pool.query(`UPDATE users SET tips_enabled = $1 WHERE id = $2`, [enabled, request.user!.id]);
    return { tipsEnabled: enabled };
  });

  // A tip id the web app defines (lib/tips.ts); unknown ids are kept, harmlessly, since the list
  // grows with the app.
  const TipId = Type.String({ pattern: "^[a-z0-9-]{1,64}$" });
  app.post(
    "/settings/tips/seen",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object({ id: TipId }, { additionalProperties: false }),
        response: replies(Type.Object({ tipsSeen: Type.Array(Type.String()) })),
      },
    },
    async (request) => {
      const res = await pool.query<{ tips_seen: string[] }>(
        `UPDATE users SET tips_seen = CASE WHEN $1 = ANY(tips_seen) THEN tips_seen ELSE array_append(tips_seen, $1) END
          WHERE id = $2 RETURNING tips_seen`,
        [request.body.id, request.user!.id],
      );
      return { tipsSeen: res.rows[0]?.tips_seen ?? [] };
    },
  );

  // "Show tips again": every tip shows once more, and tips are back on.
  app.post(
    "/settings/tips/reset",
    {
      preValidation: requireAuth,
      schema: { response: replies(Type.Object({ tipsSeen: Type.Array(Type.String()), tipsEnabled: Type.Boolean() })) },
    },
    async (request) => {
      await pool.query(`UPDATE users SET tips_seen = '{}', tips_enabled = true WHERE id = $1`, [request.user!.id]);
      return { tipsSeen: [], tipsEnabled: true };
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
        return reply.code(400).send({ error: "No downloaded region has any ABA-coded species yet" });
      }
      // De-dupe keeping each style's first position, since order is display order.
      const deduped = styles.filter((s, i) => styles.indexOf(s) === i);
      await pool.query(`UPDATE users SET species_naming_styles = $1 WHERE id = $2`, [deduped, request.user!.id]);
      return { speciesNamingStyles: deduped };
    },
  );

  // How cards and share pages show species names (the View menu's Main name + Also show).
  app.put(
    "/settings/species-name-display",
    {
      preValidation: requireAuth,
      schema: { body: SpeciesNameDisplay, response: replies(Type.Object({ speciesNameDisplay: SpeciesNameDisplay })) },
    },
    async (request) => {
      return { speciesNameDisplay: await setSpeciesNameDisplay(request.user!.id, request.body) };
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
  app.get("/settings/catalog-update", { preValidation: requireAuth, schema: {} }, async () => {
    return checkCatalogUpdate(pool);
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
    { preValidation: requireAuth, schema: { response: replies(AnyJobStatus) } },
    async () => catalogUpdate.status,
  );

  app.post(
    "/settings/catalog-update/cancel",
    { preValidation: requireAuth, schema: { response: replies(Cancelled) } },
    async () => ({ cancelled: catalogUpdate.cancel() }),
  );

  // A background job, so a dropped connection doesn't stop it halfway. POST still waits for the
  // result by default; ?background=1 returns at once for polling.
  // The move engine is uploads/reorganizeOriginals.ts.
  const reorganizeJob = createJob<ReorganizeResult, ReorganizeCounts>("reorganize-originals", REORGANIZE_IDLE_COUNTS);

  app.post(
    "/settings/reorganize-originals",
    {
      preValidation: requireAuth,
      schema: {
        querystring: Type.Object({ background: Flag("1 to start the job and return at once, for polling") }),
        response: replies(ReorganizeOutcome),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      if (!reorganizeJob.start((ctx) => runReorganize(ctx, userId, reorganizeJob.status), { phase: "preparing" })) {
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
    { preValidation: requireAuth, schema: { response: replies(AnyJobStatus) } },
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
        entries = (await readdir(target, { withFileTypes: true }))
          .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !LIFER_INTERNAL_DIR_NAMES.has(e.name))
          .map((e) => e.name)
          .sort((a, b) => a.localeCompare(b));
      } catch (err) {
        request.log.warn({ err, path: target }, "Couldn't read a folder for the folder picker");
        return reply.code(400).send({ error: "Can't read that folder" });
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

  // The folder picker's "New folder": one folder, by name, inside one the picker may show.
  // A folder already there by that name is simply used.
  app.post(
    "/settings/browse-directory/new-folder",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          { parent: Type.String({ minLength: 1 }), name: Type.String({ minLength: 1, maxLength: 255 }) },
          { additionalProperties: false },
        ),
        response: replies(Type.Object({ path: Type.String() })),
      },
    },
    async (request, reply) => {
      const name = request.body.name.trim();
      if (!name || name === "." || name === ".." || /[/\\\0]/.test(name))
        return reply.code(400).send({ error: "That name can't be used for a folder" });
      if (!path.isAbsolute(request.body.parent)) return reply.code(400).send({ error: "parent must be absolute" });
      const folder = path.join(assertAllowedPath(request.body.parent), name);
      try {
        await mkdir(folder);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const existing = code === "EEXIST" ? await stat(folder).catch(() => null) : null;
        if (!existing?.isDirectory())
          return reply.code(400).send({
            error:
              code === "EACCES" || code === "EPERM" || code === "EROFS"
                ? "Lifer can't make a folder there"
                : code === "EEXIST"
                  ? "A file already has that name"
                  : "Couldn't make that folder",
          });
      }
      // Checked again once it exists: a symlink by that name must not lead outside.
      return { path: assertAllowedPath(folder) };
    },
  );

  await app.register(storageMoveRoutes);
  await app.register(deleteLocalLibraryRoutes);
  await app.register(assetRoutes);
}
