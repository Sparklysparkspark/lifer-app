import path from "node:path";
import { constants as zlibConstants } from "node:zlib";
import { existsSync, mkdirSync } from "node:fs";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import compress from "@fastify/compress";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import helmet from "@fastify/helmet";
import { desktopModeStartupError, MAX_JSON_BODY_BYTES, MAX_UPLOAD_BYTES, PORT, SINGLE_USER_MODE, WEB_DIST_DIR, MAPS_DIR, TRUST_PROXY } from "./config.js";
import { isAllowedLocalHost } from "./auth/hostCheck.js";
import { authRoutes } from "./auth/routes.js";
import { apiKeyRoutes } from "./auth/apiKeyRoutes.js";
import { speciesRoutes } from "./species/routes.js";
import { matchingRoutes } from "./species/matchingRoutes.js";
import { uploadRoutes } from "./uploads/routes.js";
import { photoRoutes } from "./photos/routes.js";
import { collectionRoutes } from "./collection/routes.js";
import { galleryRoutes } from "./gallery/routes.js";
import { originalsRoutes } from "./originals/routes.js";
import { captureRoutes } from "./captures/routes.js";
import { regionRoutes } from "./regions/routes.js";
import { tierRoutes } from "./species/tierRoutes.js";
import { splitRoutes } from "./species/splitRoutes.js";
import { importRoutes } from "./imports/routes.js";
import { settingsRoutes, recoverInterruptedStorageMigration } from "./settings/routes.js";
import { migrateDerivativesLocation } from "./uploads/migrateDerivativesLocation.js";
import { adoptFlatLibraryLayout } from "./uploads/adoptFlatLibraryLayout.js";
import { syncLibraryRootsFromEnv } from "./storageVolumes/syncLibraryRoots.js";
import { offlinePacksRoutes } from "./offlinePacks/routes.js";
import { archiveRoutes } from "./archive/routes.js";
import { tripsRoutes } from "./trips/routes.js";
import { libraryRoutes } from "./library/routes.js";
import { storageVolumesRoutes } from "./storageVolumes/routes.js";
import { statsRoutes } from "./stats/routes.js";
import { albumRoutes } from "./albums/routes.js";
import { albumShareRoutes } from "./shares/routes.js";
import { inaturalistRoutes } from "./inaturalist/routes.js";
import { runEmbeddingBackfill } from "./species/embeddingBackfill.js";
import { seedCatalogIfEmpty } from "./species/catalogSeedUpdate.js";
import { relinkCachedReferenceFiles } from "./species/relinkReferenceFiles.js";
import { ensureGalleryEmbeddingsOnStartup } from "./species/galleryEmbeddingsAsset.js";
import { ensureIdModelOnStartup } from "./species/modelDownloadJob.js";
import { startAccelerationSelection } from "./species/accelerationSetup.js";
import { integrationRoutes } from "./integrations/routes.js";
import { pool } from "./db.js";
import { stopInference } from "./species/inference.js";
import { closeExiftool } from "./uploads/exif.js";
import { friendlyFsErrorMessage } from "./lib/friendlyFsError.js";
import { startEventLoopWatchdog } from "./lib/eventLoopWatchdog.js";
import { startParentWatchdog } from "./lib/parentWatchdog.js";
import { watchLibraryFolder } from "./lib/libraryFolder.js";
import { registerCollectionStateSaving, syncCollectionStateOnStartup } from "./lib/collectionState.js";
import { hasForwardedHeaders, isBlockedCrossSiteWrite } from "./lib/requestGuard.js";
import { startMaintenance } from "./lib/maintenance.js";
import { log } from "./lib/log.js";

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

startParentWatchdog();

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

// Desktop mode signs every request in, so only loopback Host headers (DNS-rebinding guard) and
// unrelayed requests (no forwarded headers) are accepted there.
if (SINGLE_USER_MODE) {
  app.addHook("onRequest", async (request, reply) => {
    if (!isAllowedLocalHost(request.headers.host, PORT)) {
      return reply.code(403).send({ error: "Forbidden host" });
    }
    if (hasForwardedHeaders(request.headers)) {
      return reply.code(403).send({ error: "Forwarded requests aren't accepted in desktop mode" });
    }
  });
}

// Cross-site write guard, both modes: a page on another site can still make the browser send
// our cookie on a POST, and desktop mode signs every request in. See lib/requestGuard.ts.
app.addHook("onRequest", async (request, reply) => {
  if (isBlockedCrossSiteWrite(request.method, request.headers, [request.headers.host, request.host])) {
    return reply.code(403).send({ error: "Cross-site request blocked" });
  }
});

// Every error response is { error: string, code?: string } (see integrations/openapi.ts).
// File permission errors (macOS folder access) get one actionable message for every route.
app.setErrorHandler((err, request, reply) => {
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

// No CORS plugin: Vite proxies /api to this server in dev, and both sit behind the same
// origin in production (Nginx), so cross-origin requests are never expected.
await app.register(async (api) => {
  await api.register(authRoutes);
  await api.register(speciesRoutes);
  await api.register(matchingRoutes);
  await api.register(uploadRoutes);
  await api.register(photoRoutes);
  await api.register(collectionRoutes);
  await api.register(galleryRoutes);
  await api.register(originalsRoutes);
  await api.register(captureRoutes);
  await api.register(regionRoutes);
  await api.register(tierRoutes);
  await api.register(splitRoutes);
  await api.register(importRoutes);
  await api.register(settingsRoutes);
  await api.register(offlinePacksRoutes);
  await api.register(archiveRoutes);
  await api.register(tripsRoutes);
  await api.register(libraryRoutes);
  await api.register(storageVolumesRoutes);
  await api.register(statsRoutes);
  await api.register(albumRoutes);
  await api.register(albumShareRoutes);
  await api.register(apiKeyRoutes);
  await api.register(integrationRoutes);
  await api.register(inaturalistRoutes);
}, { prefix: "/api" });

// launchToken lets the desktop shell tell this process apart from an older instance on the port.
// Warn level, so the container healthcheck doesn't fill the log.
app.get("/health", { logLevel: "warn" }, async () => ({ ok: true, launchToken: process.env.LIFER_LAUNCH_TOKEN ?? null }));

// Set at Docker build time, for the web app's update banner. "dev" never shows an update.
app.get("/version", async () => ({ version: process.env.APP_VERSION ?? "dev" }));

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
      if (filePath.includes(`${path.sep}assets${path.sep}`)) res.header("Cache-Control", "public, max-age=31536000, immutable");
      else res.header("Cache-Control", "no-cache");
    },
  });
  // SPA fallback: any non-/api path that isn't a static file gets index.html for client routing.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api")) return reply.code(404).send({ error: "Not found" });
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
syncCollectionStateOnStartup().catch((err) => app.log.warn({ err }, "collection state sync failed"));

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
    await relinkCachedReferenceFiles(pool)
      .then((n) => {
        if (n) app.log.info({ relinked: n }, "Linked cached reference photos to a fresh database");
      })
      .catch((err) => app.log.warn({ err }, "Couldn't link cached reference photos"));
    ensureGalleryEmbeddingsOnStartup(pool);
    ensureIdModelOnStartup(pool, app.log);
  });
