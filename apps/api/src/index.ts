import path from "node:path";
import { constants as zlibConstants } from "node:zlib";
import { existsSync, mkdirSync } from "node:fs";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import compress from "@fastify/compress";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_REQUEST_BYTES, PORT, SINGLE_USER_MODE, WEB_DIST_DIR, MAPS_DIR, TRUST_PROXY } from "./config.js";
import { isAllowedLocalHost } from "./auth/hostCheck.js";
import { authRoutes } from "./auth/routes.js";
import { apiKeyRoutes } from "./auth/apiKeyRoutes.js";
import { speciesRoutes } from "./species/routes.js";
import { uploadRoutes } from "./uploads/routes.js";
import { photoRoutes } from "./photos/routes.js";
import { collectionRoutes } from "./collection/routes.js";
import { galleryRoutes } from "./gallery/routes.js";
import { originalsRoutes } from "./originals/routes.js";
import { captureRoutes } from "./captures/routes.js";
import { regionRoutes } from "./regions/routes.js";
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
import { ensureGalleryEmbeddingsOnStartup } from "./species/galleryEmbeddingsAsset.js";
import { ensureIdModelOnStartup } from "./species/modelDownloadJob.js";
import { integrationRoutes } from "./integrations/routes.js";
import { pool } from "./db.js";
import { friendlyFsErrorMessage } from "./lib/friendlyFsError.js";
import { startEventLoopWatchdog } from "./lib/eventLoopWatchdog.js";
import { watchLibraryFolder } from "./lib/libraryFolder.js";
import { registerCollectionStateSaving, syncCollectionStateOnStartup } from "./lib/collectionState.js";

// Checked before anything else starts, so an interrupted storage-location move (see
// settings/routes.ts) gets resolved one way or the other before the app serves a single
// request against a possibly-inconsistent DATA_DIR.
await recoverInterruptedStorageMigration();
await migrateDerivativesLocation();
await adoptFlatLibraryLayout();
await syncLibraryRootsFromEnv();

// Force-quitting the desktop app (or a crash) sends SIGKILL straight to the Tauri process
// only — Unix doesn't cascade a kill to child processes automatically, so this sidecar would
// otherwise become an orphan that keeps running (and keeps squatting on LOCAL_PORT) with zero
// chance for any of api.rs's own cleanup code to run, since none of it executes at all. Only
// active when the desktop app actually sets LIFER_WATCH_PARENT_PID (see apps/desktop/src-
// tauri/src/api.rs) — a plain `npm run dev`/background script invocation has no such parent
// to watch for and should keep running independently of whatever shell started it.
const watchParentPid = Number(process.env.LIFER_WATCH_PARENT_PID);
if (Number.isInteger(watchParentPid) && watchParentPid > 0) {
  setInterval(() => {
    try {
      // Signal 0 sends nothing — it's the standard Unix idiom for "does this pid still
      // exist," throwing ESRCH the moment it doesn't.
      process.kill(watchParentPid, 0);
    } catch {
      console.error(`[watchdog] parent pid ${watchParentPid} is gone — exiting`);
      process.exit(0);
    }
  }, 3000);
}

// trustProxy: a hop count (see config.ts TRUST_PROXY), not `true`, since the login and
// share-password rate limiters key on request.ip and `true` let clients pick their own IP.
// bodyLimit governs the WHOLE request body (see config.ts — MAX_UPLOAD_REQUEST_BYTES's own
// comment: a batch upload of many RAW files needed a much larger ceiling than any one file).
// Fastify accepts a hop count at runtime (lib/request.js) but its typings omit number.
const app = Fastify({ logger: true, bodyLimit: MAX_UPLOAD_REQUEST_BYTES, trustProxy: TRUST_PROXY as boolean | string[] });

// Restarts the server if it ever freezes, instead of leaving the page down until a manual restart.
startEventLoopWatchdog(app);
// Keeps archived/hidden/seen/target species in the library too, so a fresh install gets them back.
registerCollectionStateSaving(app);

// DNS-rebinding guard: in desktop mode every request is the local user, so a web page that
// rebinds its own hostname to 127.0.0.1 must not be able to talk to us. Only loopback Host
// headers are accepted. Docker/multi-user mode is unaffected (it has real sessions).
if (SINGLE_USER_MODE) {
  app.addHook("onRequest", async (request, reply) => {
    if (!isAllowedLocalHost(request.headers.host, PORT)) {
      return reply.code(403).send({ error: "Forbidden host" });
    }
  });
}

// A raw fs EPERM/EACCES (macOS denying folder access — see friendlyFsError.ts's own comment)
// previously reached the client as a crash-looking dump of the Node error object from whichever
// route happened to hit it, rather than the one, same, actionable instruction every such error
// actually needs. One handler here covers every route uniformly instead of retrofitting each
// try/catch individually.
app.setErrorHandler((err, _request, reply) => {
  const code = (err as NodeJS.ErrnoException).code;
  const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
  if (code === "EPERM" || code === "EACCES" || code === "ENOENT") {
    return reply.code(statusCode).send({ error: friendlyFsErrorMessage(err) });
  }
  // Every hand-written route responds { error: string } on failure — an uncaught exception
  // falling through to Fastify's own default formatting would instead send
  // { statusCode, error, message }, a different shape any frontend code checking body.error
  // wouldn't recognize. Normalized to the same contract here so that assumption always holds.
  reply.code(statusCode).send({ error: (err as Error).message || "Internal server error" });
});

await app.register(cookie);
// Compress JSON, JS and CSS for a server reached over a network (the gallery's photo list and the
// app's own code are over a megabyte each, and shrink by about 85%). Photos are already
// compressed and are skipped. Off in desktop mode: there the browser and server are on the same
// machine, so it would only cost CPU. Brotli at level 5 is nearly as small as its maximum and far
// faster to produce on a NAS.
if (!SINGLE_USER_MODE) {
  await app.register(compress, {
    threshold: 1024,
    brotliOptions: { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } },
  });
}
// @fastify/multipart's fileSize limit is separate — the PER-FILE cap (MAX_UPLOAD_BYTES),
// distinct from the bodyLimit above which bounds the request as a whole.
await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES } });

// No CORS plugin: Vite proxies /api to this server in dev, and both sit behind the same
// origin in production (Nginx), so cross-origin requests are never expected.
await app.register(async (api) => {
  await api.register(authRoutes);
  await api.register(speciesRoutes);
  await api.register(uploadRoutes);
  await api.register(photoRoutes);
  await api.register(collectionRoutes);
  await api.register(galleryRoutes);
  await api.register(originalsRoutes);
  await api.register(captureRoutes);
  await api.register(regionRoutes);
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

// launchToken lets the desktop shell tell this process apart from a previous instance still
// holding the port.
app.get("/health", async () => ({ ok: true, launchToken: process.env.LIFER_LAUNCH_TOKEN ?? null }));

// Baked in at Docker build time from the release tag (see Dockerfile/release.yml's
// docker-image job) — read by the self-hosted web app's own DockerUpdateBanner.tsx to compare
// against the latest GitHub release tag. "dev" for a local build with no APP_VERSION passed
// (docker-compose's own default `build: .` with no --build-arg), which the banner treats as
// "never show an update" rather than a false positive against a real version string.
app.get("/version", async () => ({ version: process.env.APP_VERSION ?? "dev" }));

// Offline basemap tiles (PMTiles) — @fastify/static (via @fastify/send)
// serves Range requests out of the box, which the pmtiles JS library needs to fetch only the
// byte ranges for tiles actually in view rather than the whole file. decorateReply: false
// since the reply.sendFile() decorator can only be added once per app, and the WEB_DIST_DIR
// registration below (when it exists) is the one that actually uses it, for its SPA fallback.
//
// The map itself is a large (~500MB) OPT-IN download (see settings/routes.ts's /settings/map
// endpoints) rather than something every install ships with, so this directory usually starts
// empty — created here unconditionally (not gated on existsSync like WEB_DIST_DIR below) so the
// route is already live the moment a user downloads the map, instead of needing a server
// restart to notice a directory that didn't exist at boot.
mkdirSync(MAPS_DIR, { recursive: true });
await app.register(staticFiles, { root: MAPS_DIR, prefix: "/maps/", decorateReply: false });

// Serves the built web app (apps/web/dist) so the whole app is one container on one port —
// a reverse proxy (nginx, DuckDNS, etc., configured separately) just needs a single upstream
// to point at, not path-based routing between two separate origins. Only present when a
// build actually exists: `npm run dev`
// keeps using Vite's own dev server (see vite.config.ts's /api proxy) instead, so this
// silently does nothing in local development.
if (existsSync(WEB_DIST_DIR)) {
  await app.register(staticFiles, {
    root: WEB_DIST_DIR,
    // Built files under assets/ have a content hash in their name, so a new release always has
    // new names: the browser can keep them forever instead of re-checking all of them on every
    // page load. index.html (which lists them) is always re-checked, so an update shows up.
    setHeaders: (res, filePath) => {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) res.header("Cache-Control", "public, max-age=31536000, immutable");
      else res.header("Cache-Control", "no-cache");
    },
  });
  // SPA fallback — react-router handles routing client-side, so any path that isn't a real
  // static asset (a deep link, a page refresh on /species/:id, etc.) still needs to receive
  // index.html rather than a 404. Fastify's own notFoundHandler is scoped by prefix, so
  // registering it in an /api-less inner instance keeps API 404s (a real "not found" JSON
  // response) unaffected — this only ever fires for a request that already missed every
  // /api route and every real static file.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api")) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile("index.html");
  });
}

try {
  // SINGLE_USER_MODE authenticates every request as one local account with no real password
  // check (see session.ts) — that's only safe on the assumption nobody else can reach this
  // port at all, so it binds to loopback only rather than every interface.
  await app.listen({ port: PORT, host: SINGLE_USER_MODE ? "127.0.0.1" : "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Logs when the library folder goes missing under a running server (moved on the NAS, a drive
// unplugged), which is otherwise only visible as uploads failing.
watchLibraryFolder();
syncCollectionStateOnStartup().catch((err) => app.log.warn({ err }, "collection state sync failed"));

// Species auto-suggest backfill (Phase 2 — on by default, no toggle): fires after the server is
// already listening so a slow first-ever run (model download + embedding every existing photo)
// never delays startup. Best-effort — a failure here (no network for the one-time model
// download, e.g.) just means suggestions stay unavailable until the next server restart retries,
// never a startup failure.
runEmbeddingBackfill().catch((err) => app.log.warn({ err }, "Species-suggestion embedding backfill failed to start"));

// The desktop app has always self-seeded its catalog (species/regions/etc) the moment it finds
// an empty database — see embedded_db.rs's restore_catalog_seed_if_needed — but the Docker/self-
// hosted image had no equivalent, leaving a brand-new deployment's catalog genuinely empty
// (blank Offline Packs map, empty checklists everywhere) until someone happened to know to click
// Settings > Update. This closes that gap the same way the embedding backfill above does: fires
// after the server is already listening (never delays startup) and is a no-op instantly if the
// catalog isn't actually empty (an existing install restarting, or the desktop build where
// embedded_db.rs already seeded it first). Best-effort — a failed download here just means the
// catalog stays empty until Settings > Update is retried manually, same as before this existed.
seedCatalogIfEmpty(pool)
  .then((result) => {
    if (result.seeded) app.log.info({ merged: result.merged }, "Auto-seeded an empty catalog on first boot");
  })
  .catch((err) => app.log.warn({ err }, "Catalog auto-seed failed. Settings > Update can still be run manually."))
  // After the seed (gallery vectors attach to catalog photos): fetch newer published vectors if
  // the model is installed. Runs in the background and only logs on failure.
  .finally(() => {
    ensureGalleryEmbeddingsOnStartup(pool);
    ensureIdModelOnStartup(pool, app.log);
  });
