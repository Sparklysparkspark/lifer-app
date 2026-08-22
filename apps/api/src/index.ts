import path from "node:path";
import { existsSync } from "node:fs";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_REQUEST_BYTES, PORT, SINGLE_USER_MODE, WEB_DIST_DIR, MAPS_DIR } from "./config.js";
import { authRoutes } from "./auth/routes.js";
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
import { offlinePacksRoutes } from "./offlinePacks/routes.js";

// Checked before anything else starts, so an interrupted storage-location move (see
// settings/routes.ts) gets resolved one way or the other before the app serves a single
// request against a possibly-inconsistent DATA_DIR.
await recoverInterruptedStorageMigration();

// trustProxy: this app is meant to sit behind a reverse proxy (nginx, etc., configured
// separately) once self-hosted. Nothing here currently branches on request.protocol/
// request.ip (session.ts's COOKIE_SECURE reads NODE_ENV directly, and rateLimiter.ts keys by
// email, not IP — see their own comments), so this isn't fixing a live bug, just correct
// hygiene for whatever relies on X-Forwarded-* later.
// bodyLimit governs the WHOLE request body (see config.ts — MAX_UPLOAD_REQUEST_BYTES's own
// comment: a batch upload of many RAW files needed a much larger ceiling than any one file).
const app = Fastify({ logger: true, bodyLimit: MAX_UPLOAD_REQUEST_BYTES, trustProxy: true });

await app.register(cookie);
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
}, { prefix: "/api" });

app.get("/health", async () => ({ ok: true }));

// Offline basemap tiles (PMTiles) — @fastify/static (via @fastify/send)
// serves Range requests out of the box, which the pmtiles JS library needs to fetch only the
// byte ranges for tiles actually in view rather than the whole file. decorateReply: false
// since the reply.sendFile() decorator can only be added once per app, and the WEB_DIST_DIR
// registration below (when it exists) is the one that actually uses it, for its SPA fallback.
if (existsSync(MAPS_DIR)) {
  await app.register(staticFiles, { root: MAPS_DIR, prefix: "/maps/", decorateReply: false });
}

// Serves the built web app (apps/web/dist) so the whole app is one container on one port —
// a reverse proxy (nginx, DuckDNS, etc., configured separately) just needs a single upstream
// to point at, not path-based routing between two separate origins. Only present when a
// build actually exists: `npm run dev`
// keeps using Vite's own dev server (see vite.config.ts's /api proxy) instead, so this
// silently does nothing in local development.
if (existsSync(WEB_DIST_DIR)) {
  await app.register(staticFiles, { root: WEB_DIST_DIR });
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
