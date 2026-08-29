import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLocalSettings } from "./localSettings.js";

// Resolved relative to this module's own location, not process.cwd() — cwd varies depending
// on how/where the process is launched (npm workspace script vs a plain `tsx path/to/index.ts`
// from the repo root) and got this wrong once already.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..", "..");

// Same reasoning as REPO_ROOT above, and a real bug this exact one caused: a bare
// `import "dotenv/config"` resolves `.env` from process.cwd(), which for the normal `npm run
// dev -w api` workflow is apps/api, NOT the repo root where .env actually lives — so the root
// .env was silently never loaded at all (masked only because DATABASE_URL's hardcoded fallback
// below happens to match its value). Pointed at REPO_ROOT explicitly so every env var in that
// file — this session's SINGLE_USER_MODE included — actually takes effect regardless of
// which directory the process was launched from.
loadDotenv({ path: path.join(REPO_ROOT, ".env") });

// A reference photo's URL is keyed by species/gallery-photo id, not by content — so a restore
// pass that overwrites species.reference_display_path's file IN PLACE (fixing a crop, e.g.)
// doesn't change the URL a browser/webview would use to fetch it, and a client that already
// cached a response for that URL has no reason to ever ask again. Appending this to every
// reference-photo URL (see species/routes.ts) guarantees a fresh fetch on the very first
// request each time the server process restarts — which for a desktop app means "the moment
// you relaunch after an update" without needing to know or track which specific files
// actually changed. Combined with those routes' own Cache-Control: no-cache (which prevents
// staleness going forward, within a single run), this fixes staleness both looking backward
// (already-cached responses from before a restore) and forward.
export const MEDIA_CACHE_BUST = Date.now();

export const PORT = Number(process.env.PORT ?? 4000);
export const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://lifer:lifer@localhost:5432/lifer";
// Filesystem layout per lifer-spec.md §8: display/{uuid}.webp, thumb/{uuid}.webp.
// Storage location is configurable independent of where the app itself is installed, via
// three sources in priority order: the DATA_DIR env var (Docker's LIFER_STORAGE_DIR bind
// mount ultimately sets this inside the container — see docker-compose.yml/.env.example),
// then the desktop-mode folder picker's persisted choice (see localSettings.ts/
// settings/routes.ts — set via Settings, no env var needed), then this repo-relative default.
export const DATA_DIR = process.env.DATA_DIR ?? readLocalSettings().dataDir ?? path.join(REPO_ROOT, "data", "lifer");
// Full-resolution originals for "store" mode uploads (self-hosted single-user deployment,
// per spec §6/§8.4's originals model). Never used for "link" mode, which references a file
// wherever it already lives instead.
export const ORIGINALS_DIR = path.join(DATA_DIR, "originals");
// App-managed shared assets (the offline basemap, the species reference-photo cache) that
// have nothing to do with any particular photo library — they're the same regardless of
// which folder DATA_DIR currently points at. Kept separate so switching your photo library
// folder (Settings → Storage location) never loses, hides, or re-requires re-downloading
// these; the desktop app points this at Electron's own stable per-install userData directory
// (see apps/desktop/src/main.js), independent of DATA_DIR. Server/Docker deployments have no
// "switch libraries" concept — one volume covers everything — so this defaults to DATA_DIR
// there, preserving the single-directory-tree layout that setup already expects.
export const APP_DATA_DIR = process.env.APP_DATA_DIR ?? DATA_DIR;
// Offline basemap tiles (PMTiles — a single-file, range-requested vector tile archive from
// Protomaps/OpenStreetMap) — not user data, so served unauthenticated like any other static
// basemap tile source.
export const MAPS_DIR = path.join(APP_DATA_DIR, "maps");
// Direct download URL for the offline basemap file itself (a ~500MB PMTiles archive) — kept
// out of the installer/Docker image entirely (see settings/routes.ts's /settings/map/download)
// since it's a purely cosmetic feature nobody should be forced to pay ~500MB of app size for.
// No default: unset until a real hosted copy exists (a GitHub Release asset is the natural
// fit — same "just a URL to a static file" shape as PACK_INDEX_URL below, and GitHub Releases,
// unlike GitHub Packages, is built for hosting large binary downloads rather than package
// registries). Bump this alongside the maplibre-gl/pmtiles npm versions when publishing a new
// map build, so the map format and the client reading it stay in lockstep.
export const MAP_DOWNLOAD_URL = process.env.MAP_DOWNLOAD_URL ?? null;
// Generous ceiling for a single FILE, set to 2GB: TIFF and DNG files can already run large,
// and Canon's RAW-burst CR3 mode bundles many frames into ONE container file that can reach
// several hundred MB to well over 1GB for an extended burst — a completely different scale
// than a single-frame RAW. Since RawUpload.tsx sends one file per request rather than
// batching many into one multipart request, raising this doesn't multiply out across a whole
// batch, so a generous per-file number stays safe and bounded. This is @fastify/multipart's
// per-part `fileSize` limit (not per-route), so it applies everywhere.
export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 2 * 1024 * 1024 * 1024);
// Separate ceiling for the WHOLE request body — Fastify's bodyLimit applies to the entire
// multipart request, not per file, so it must be at least MAX_UPLOAD_BYTES plus a little
// headroom for multipart framing/field overhead (boundaries, field names, a few small text
// fields like speciesId/mode) rather than exactly MAX_UPLOAD_BYTES.
//
// Batch-uploading a folder of RAW files (see RawUpload.tsx's "point it at a folder" feature)
// previously sent every selected file in ONE combined multipart request, which could add up
// to far more than any single-file limit even though each file alone was fine — several
// files could already succeed (written to disk, linked/inserted) before the stream got cut
// off mid-batch with a 413, since @fastify/multipart processes parts as bytes arrive. The
// fix is one request per file (see RawUpload.tsx) rather than a bigger cap, so this only
// needs to cover one file plus a small margin.
export const MAX_UPLOAD_REQUEST_BYTES = Number(process.env.MAX_UPLOAD_REQUEST_BYTES ?? MAX_UPLOAD_BYTES + 5 * 1024 * 1024);
// The built web app (vite build's output — see apps/web/package.json's "build" script).
// Defaults to the monorepo-relative path so it "just works" in a Docker image that copies
// both apps into place (see Dockerfile); override via env for any other layout.
export const WEB_DIST_DIR = process.env.WEB_DIST_DIR ?? path.join(REPO_ROOT, "apps", "web", "dist");
export const SESSION_COOKIE_NAME = "lifer_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const COOKIE_SECURE = process.env.NODE_ENV === "production";
// Desktop mode: a single person on their own laptop, server bound to localhost only, no
// other party who could ever reach it — a login screen there is pure friction with no real
// security benefit. Sessions/first-run setup stay fully intact for the
// self-hosted server/NAS deployment (one real account, protected by a real password, since
// that one can be reached over a network); this flag just makes every request authenticate
// as one auto-provisioned local user instead, skipping login entirely.
export const SINGLE_USER_MODE = process.env.SINGLE_USER_MODE === "1";

// Password-reset emails (see auth/routes.ts's forgot-password/reset-password handlers). No
// SMTP env vars set is a valid, common state for a fresh self-hosted install — mailer.ts logs
// the reset link to the server console instead of throwing, so "forgot password" still works
// (an admin with shell/log access can hand the link to whoever needs it) rather than being a
// hard requirement before the feature works at all.
export const SMTP_HOST = process.env.SMTP_HOST ?? null;
export const SMTP_PORT = Number(process.env.SMTP_PORT ?? 587);
export const SMTP_USER = process.env.SMTP_USER ?? null;
export const SMTP_PASS = process.env.SMTP_PASS ?? null;
export const SMTP_FROM = process.env.SMTP_FROM ?? "Lifer <no-reply@lifer.app>";
// Base URL used to build the link inside password-reset emails (e.g. https://lifer.example.com).
export const APP_URL = process.env.APP_URL ?? `http://localhost:${PORT}`;

// Where to fetch the canonical pack-index.json from (see offlinePacks/routes.ts). Defaults to
// the real hosted index (same packs-latest release tag build-pack-index.ts publishes to) so
// every install works out of the box; the env var exists only to override it for local
// development/testing against a differently-served index.
export const PACK_INDEX_URL =
  process.env.PACK_INDEX_URL ?? "https://github.com/Sparklysparkspark/lifer-app/releases/download/packs-latest/pack-index.json";
