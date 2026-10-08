import path from "node:path";
import { constants as zlibConstants } from "node:zlib";
import { existsSync, mkdirSync } from "node:fs";
import Fastify, { type FastifyError } from "fastify";
import cookie from "@fastify/cookie";
import compress from "@fastify/compress";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import helmet from "@fastify/helmet";
import {
  APP_DATA_DIR,
  desktopModeStartupError,
  MAX_JSON_BODY_BYTES,
  MAX_UPLOAD_BYTES,
  RATE_LIMIT_PER_MINUTE,
  PORT,
  SINGLE_USER_MODE,
  WEB_DIST_DIR,
  MAPS_DIR,
  TRUST_PROXY,
} from "@lifer/core/config.js";
import { desktopRequestGate } from "./auth/desktopGate.js";
import { recoverInterruptedStorageMigration } from "./settings/routes.js";
import { apiRoutes } from "./apiRoutes.js";
import { Type } from "typebox";
import { installSchemas, replyToValidationError } from "./lib/schema.js";
import { migrateDerivativesLocation } from "./uploads/migrateDerivativesLocation.js";
import { adoptFlatLibraryLayout } from "./uploads/adoptFlatLibraryLayout.js";
import { syncLibraryRootsFromEnv } from "./storageVolumes/syncLibraryRoots.js";
import { runEmbeddingBackfill } from "./species/embeddingBackfill.js";
import { seedCatalogIfEmpty } from "./species/catalogSeedUpdate.js";
import { relinkCachedReferenceFiles } from "./species/relinkReferenceFiles.js";
import { ensureGalleryEmbeddingsOnStartup } from "./species/galleryEmbeddingsAsset.js";
import { ensureIdModelOnStartup } from "./species/modelDownloadJob.js";
import { startWithheldPhotoFetch, stopWithheldPhotoFetch } from "./species/withheldPhotos.js";
import { startAccelerationSelection } from "./species/accelerationSetup.js";
import { pool } from "@lifer/core/db.js";
import { stopInference } from "@lifer/core/species/inference.js";
import { closeExiftool } from "./uploads/exif.js";
import { friendlyFsErrorMessage } from "./lib/friendlyFsError.js";
import { registerRateLimit } from "./lib/rateLimit.js";
import { checkWritableDir } from "./lib/writableDir.js";
import { startEventLoopWatchdog } from "./lib/eventLoopWatchdog.js";
import { startParentWatchdog } from "./lib/parentWatchdog.js";
import { watchLibraryFolder } from "@lifer/core/lib/libraryFolder.js";
import { registerCollectionStateSaving, syncCollectionStateOnStartup } from "./lib/collectionState.js";
import { isBlockedCrossSiteWrite } from "@lifer/core/lib/requestGuard.js";
import { startMaintenance } from "./lib/maintenance.js";
import { log } from "@lifer/core/lib/log.js";
import { servesWebApp } from "./lib/spaFallback.js";
import { registerHealthRoute } from "./lib/health.js";
import { trustProxyHint } from "./lib/trustProxyHint.js";
import { encryptStoredInatTokens } from "./inaturalist/tokenStore.js";
import { encryptStoredShareTokens } from "./shares/routes.js";

const desktopModeError = desktopModeStartupError(process.env);
if (desktopModeError) {
  log.error(`[startup] ${desktopModeError}`);
  process.exit(1);
}

// Resolve an interrupted storage-location move before serving any request against DATA_DIR.
await recoverInterruptedStorageMigration();
await migrateDerivativesLocation();
await adoptFlatLibraryLayout();
await syncLibraryRootsFromEnv();

// Named in the log at startup, rather than found by the first upload or catalog update.
const appDataError = await checkWritableDir(APP_DATA_DIR);
if (appDataError) {
  log.error(
    { err: appDataError },
    `[startup] Lifer can't write to ${APP_DATA_DIR}, so uploads, thumbnails and catalog updates will fail. ` +
      "Give that folder to the user Lifer runs as (in Docker, PUID:PGID, 568:568 by default).",
  );
}

startParentWatchdog();

// Secrets older versions stored as plain text (iNaturalist tokens, share links) are re-stored
// encrypted (lib/secretBox.ts) before any request reads them. Reads cope with plain text too, so
// a failure here only delays it to the next start.
await Promise.all([encryptStoredInatTokens(), encryptStoredShareTokens()])
  .then(([inat, shares]) => {
    if (inat || shares) log.info({ inat, shares }, "[startup] Encrypted secrets stored by an older version");
  })
  .catch((err) => log.warn({ err }, "[startup] Couldn't encrypt stored secrets; will retry at the next start"));

// trustProxy: see config.ts TRUST_PROXY.
const app = Fastify({
  loggerInstance: log,
  bodyLimit: MAX_JSON_BODY_BYTES,
  trustProxy: TRUST_PROXY,
});

// Route these to the app log. An uncaught exception may leave state half-updated, so it still exits.
process.on("unhandledRejection", (reason) => {
  app.log.error({ err: reason }, "Unhandled promise rejection");
});
process.on("uncaughtException", (err) => {
  app.log.error({ err }, "Uncaught exception, exiting");
  process.exit(1);
});

// Node as PID 1 ignores unhandled SIGTERM, so Docker would kill it after 10s. The timer caps
// a slow close.
let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`${signal} received, shutting down`);
  setTimeout(() => process.exit(0), 5000).unref();
  stopWithheldPhotoFetch();
  await app.close().catch((err) => app.log.warn({ err }, "Server close failed"));
  await Promise.allSettled([stopInference(), closeExiftool()]);
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", (signal) => void shutdown(signal));
process.on("SIGINT", (signal) => void shutdown(signal));

// Restarts the server if it ever freezes, instead of leaving the page down until a manual restart.
startEventLoopWatchdog(app);
// Keeps archived/hidden/seen/target species in the library too, so a fresh install gets them back.
registerCollectionStateSaving(app);

// Behind a reverse proxy with TRUST_PROXY unset, say once how to fix it (lib/trustProxyHint.ts).
if (!SINGLE_USER_MODE) app.addHook("onRequest", trustProxyHint(app.log, process.env.TRUST_PROXY));

// Cross-site write guard, both modes: a page on another site can still make the browser send
// our cookie on a POST. See lib/requestGuard.ts.
app.addHook("onRequest", async (request, reply) => {
  if (isBlockedCrossSiteWrite(request.method, request.headers, [request.headers.host, request.host])) {
    return reply.code(403).send({ error: "Cross-site request blocked" });
  }
});

// Every error response is { error: string, code?: string } (see integrations/openapi.ts).
// File permission errors (macOS folder access) get one actionable message for every route.
installSchemas(app);
app.setErrorHandler((err, request, reply) => {
  // Schema validation (lib/schema.ts): 400 with what was wrong, or the route's own answer.
  if (replyToValidationError(err as FastifyError, request, reply)) return;
  const code = (err as NodeJS.ErrnoException).code;
  const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
  if (code === "EPERM" || code === "EACCES" || code === "ENOENT") {
    if (statusCode >= 500) request.log.error({ err }, "File system error");
    return reply.code(statusCode).send({ error: friendlyFsErrorMessage(err) });
  }
  // A 5xx message can carry SQL, paths or stack detail, so it goes to the log only.
  if (statusCode >= 500) {
    request.log.error({ err }, "Request failed");
    return reply.code(statusCode).send({ error: "Internal server error" });
  }
  reply.code(statusCode).send({ error: (err as Error).message || "Request failed" });
});

await app.register(cookie);

// Desktop mode has no sign-in: loopback Host headers, unrelayed requests and, past the public
// routes, the desktop app's own credential only (auth/desktopGate.ts). Registered after the cookie
// plugin, whose own onRequest hook parses the credential cookie.
if (SINGLE_USER_MODE) app.addHook("onRequest", desktopRequestGate(PORT));

// Servers only: see config.ts RATE_LIMIT_PER_MINUTE.
if (!SINGLE_USER_MODE) await registerRateLimit(app, RATE_LIMIT_PER_MINUTE);

// Security headers. ipc: is the desktop shell's bridge. No HSTS, since plain http on a home
// network is supported and a reverse proxy can add it.
await app.register(helmet, {
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      mediaSrc: ["'self'", "blob:"],
      fontSrc: ["'self'", "data:"],
      workerSrc: ["'self'", "blob:"],
      connectSrc: ["'self'", "https:", "ipc:", "http://ipc.localhost"],
    },
  },
  crossOriginEmbedderPolicy: false,
  frameguard: { action: "deny" },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  strictTransportSecurity: false,
});
// Compress text responses on servers. Off in desktop mode, where it would only cost CPU.
// Brotli level 5 is nearly as small as the maximum and much cheaper on a NAS.
if (!SINGLE_USER_MODE) {
  await app.register(compress, {
    threshold: 1024,
    brotliOptions: { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } },
  });
}
// Per-file cap. 0 would make the plugin fall back to bodyLimit, so "no cap" is passed as Infinity.
await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES > 0 ? MAX_UPLOAD_BYTES : Infinity } });

// No CORS plugin: Vite proxies /api to this server in dev, and in production this server
// serves the web app itself, so cross-origin requests are never expected.
await app.register(apiRoutes, { prefix: "/api" });

registerHealthRoute(app);

// Set at Docker build time, for the web app's update banner. "dev" never shows an update.
app.get("/version", { schema: { response: { 200: Type.Object({ version: Type.String() }) } } }, async () => ({
  version: process.env.APP_VERSION ?? "dev",
}));

// Offline basemap tiles. The folder is created up front so the route works once the map arrives.
// decorateReply: false because the web app registration below owns reply.sendFile().
mkdirSync(MAPS_DIR, { recursive: true });
await app.register(staticFiles, { root: MAPS_DIR, prefix: "/maps/", decorateReply: false });

// Serves the built web app on the same origin. Absent in local dev, where Vite serves it.
if (existsSync(WEB_DIST_DIR)) {
  await app.register(staticFiles, {
    root: WEB_DIST_DIR,
    // Hashed files under assets/ can be cached forever; index.html is always re-checked.
    setHeaders: (res, filePath) => {
      if (filePath.includes(`${path.sep}assets${path.sep}`))
        res.header("Cache-Control", "public, max-age=31536000, immutable");
      else res.header("Cache-Control", "no-cache");
    },
  });
  // SPA fallback: an app route that isn't a static file gets index.html for client routing.
  app.setNotFoundHandler((request, reply) => {
    if (!servesWebApp(request.url)) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile("index.html");
  });
}

try {
  // Desktop mode signs every request in, so it binds to loopback only.
  await app.listen({ port: PORT, host: SINGLE_USER_MODE ? "127.0.0.1" : "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

startMaintenance(app.log);

// Logs when the library folder goes missing under a running server.
watchLibraryFolder();

// Background, best-effort startup work: never delays listening, and a failure only means the
// feature waits for the next restart (or a manual retry in Settings).
runEmbeddingBackfill().catch((err) => app.log.warn({ err }, "Species-suggestion embedding backfill failed to start"));
// Moves species matching onto a GPU when this machine has a faster one that gives the same answers.
startAccelerationSelection();

// Seed an empty catalog (a fresh Docker install); a no-op when the catalog already has data.
seedCatalogIfEmpty(pool)
  .then((result) => {
    if (result.seeded) app.log.info({ merged: result.merged }, "Auto-seeded an empty catalog on first boot");
  })
  .catch((err) => app.log.warn({ err }, "Catalog auto-seed failed. Settings > Update can still be run manually."))
  // After the seed, since gallery vectors attach to catalog photos.
  .finally(async () => {
    // The collection-state restore matches species by name, so it needs the catalog in place.
    syncCollectionStateOnStartup().catch((err) => app.log.warn({ err }, "collection state sync failed"));
    await relinkCachedReferenceFiles(pool)
      .then((n) => {
        if (n) app.log.info({ relinked: n }, "Linked cached reference photos to a fresh database");
      })
      .catch((err) => app.log.warn({ err }, "Couldn't link cached reference photos"));
    ensureGalleryEmbeddingsOnStartup(pool);
    ensureIdModelOnStartup(pool, app.log);
    // Picks up photos packs couldn't include that are still left to fetch.
    startWithheldPhotoFetch("startup");
  });
