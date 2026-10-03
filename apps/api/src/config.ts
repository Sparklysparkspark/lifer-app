import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLocalSettings } from "./localSettings.js";
import { log } from "./lib/log.js";

// Relative to this module, since process.cwd() depends on how the process was launched.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..", "..");

// .env lives at the repo root, not in apps/api where `npm run dev -w api` runs.
loadDotenv({ path: path.join(REPO_ROOT, ".env") });

// Appended to reference-photo URLs so a file replaced in place is refetched after a restart.
export const MEDIA_CACHE_BUST = Date.now();

export const PORT = Number(process.env.PORT ?? 4000);
export const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://lifer:lifer@localhost:5432/lifer";
// The photo library folder: the DATA_DIR env var (Docker's LIFER_STORAGE_DIR mount), then the
// folder chosen in desktop Settings (localSettings.ts), then a repo-relative default.
export const DATA_DIR = process.env.DATA_DIR ?? readLocalSettings().dataDir ?? path.join(REPO_ROOT, "data", "lifer");
// App-managed files (offline map, models, caches, thumbnails), kept apart from the photo library.
// Falls back to DATA_DIR when only that is set, since a default inside the container is wiped on update.
export const APP_DATA_DIR =
  process.env.APP_DATA_DIR ?? (process.env.DATA_DIR ? DATA_DIR : path.join(REPO_ROOT, "data", "lifer-app-data"));
// Where "store" mode originals go. A "Lifer Photos" subfolder is used when it exists or when app
// data shares the folder, so the library and Lifer's own folders never mix.
export const LEGACY_ORIGINALS_DIR = path.join(DATA_DIR, "Lifer Photos");
export const ORIGINALS_DIR =
  existsSync(LEGACY_ORIGINALS_DIR) || path.resolve(APP_DATA_DIR) === path.resolve(DATA_DIR) ? LEGACY_ORIGINALS_DIR : DATA_DIR;
// Offline basemap tiles (a PMTiles archive). Not user data, so served without auth.
export const MAPS_DIR = path.join(APP_DATA_DIR, "maps");
// The opt-in offline map download: the rolling "map-latest" release, so a map update needs no
// app release.
export const MAP_DOWNLOAD_URL =
  process.env.MAP_DOWNLOAD_URL ?? "https://github.com/Sparklysparkspark/lifer-app/releases/download/map-latest/world-z8.pmtiles";
// Per-file upload cap, as a disk-safety net only: 0 (the default) means no cap. Enforced on
// multipart parts and on a resumable upload's declared Upload-Length.
export const MAX_UPLOAD_BYTES = Math.max(0, Number(process.env.MAX_UPLOAD_BYTES ?? 0) || 0);
// Cap on ordinary request bodies (JSON). Uploads never go through it: multipart and resumable
// uploads stream to disk under their own limits.
export const MAX_JSON_BODY_BYTES = Math.max(1024 * 1024, Number(process.env.LIFER_MAX_JSON_BODY_BYTES ?? 64 * 1024 * 1024) || 64 * 1024 * 1024);
// Where uploads are received and kept until imported. Unset picks a folder on the library's own
// drive, so filing an upload is a rename rather than a copy (lib/uploadWorkDir.ts).
export const UPLOAD_WORK_DIR = process.env.LIFER_UPLOAD_WORK_DIR?.trim() || null;
// sharp's pixel limit for opening photos (lib/imageLimits.ts reads LIFER_MAX_IMAGE_PIXELS).
export { maxImagePixels } from "./lib/imageLimits.js";
// The built web app (vite build output), at its monorepo path by default.
export const WEB_DIST_DIR = process.env.WEB_DIST_DIR ?? path.join(REPO_ROOT, "apps", "web", "dist");
export const SESSION_COOKIE_NAME = "lifer_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Desktop mode: one person on their own machine with the server on localhost, so every request
// is signed in as the local user. Server installs keep real accounts and sessions.
export const SINGLE_USER_MODE = process.env.SINGLE_USER_MODE === "1";

// Desktop mode skips sign-in, so it refuses to start without the desktop sidecar's
// LIFER_LAUNCH_TOKEN. This stops SINGLE_USER_MODE=1 being set on a server by mistake.
export function desktopModeStartupError(env: NodeJS.ProcessEnv): string | null {
  if (env.SINGLE_USER_MODE !== "1") return null;
  if (env.LIFER_LAUNCH_TOKEN) return null;
  if (env.LIFER_ALLOW_UNTOKENED_DESKTOP === "1") return null;
  return (
    "SINGLE_USER_MODE=1 skips sign-in entirely, so it only runs when started by the Lifer desktop app " +
    "(which sets LIFER_LAUNCH_TOKEN). On a server, remove SINGLE_USER_MODE. For local development, " +
    "set LIFER_ALLOW_UNTOKENED_DESKTOP=1."
  );
}

// Proxies on loopback and private networks are trusted by default. A number means "trust that
// many hops"; Fastify ignores forwarded headers for a bare number, so it becomes a function.
export type TrustProxySetting = boolean | string[] | ((address: string, hop: number) => boolean);
const DEFAULT_TRUST_PROXY = ["loopback", "linklocal", "uniquelocal"];
export function parseTrustProxy(raw: string | undefined): TrustProxySetting {
  if (raw == null || raw.trim() === "") return DEFAULT_TRUST_PROXY;
  const v = raw.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^\d+$/.test(v)) {
    const hops = Number(v);
    return (_address, hop) => hop < hops;
  }
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}
export const TRUST_PROXY = SINGLE_USER_MODE ? false : parseTrustProxy(process.env.TRUST_PROXY);

// Extra bind-mounted folders a server admin allows, as comma-separated `Label=/path` or `/path`.
// These plus DATA_DIR are the whole server path allowlist (see lib/allowedPaths.ts).
export interface LibraryRoot {
  label: string;
  path: string;
}

export function parseLibraryRoots(raw: string | undefined, dataDir: string): LibraryRoot[] {
  if (raw == null || raw.trim() === "") return [];
  const resolvedDataDir = path.resolve(dataDir);
  const roots: LibraryRoot[] = [];
  const seen = new Set<string>();
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    const rawLabel = eq === -1 ? "" : trimmed.slice(0, eq).trim();
    const rawPath = eq === -1 ? trimmed : trimmed.slice(eq + 1).trim();
    if (!path.isAbsolute(rawPath)) {
      log.warn(`[config] LIFER_LIBRARY_ROOTS: skipping "${trimmed}", the path must be absolute`);
      continue;
    }
    const resolved = path.resolve(rawPath);
    if (resolved === path.parse(resolved).root) {
      log.warn(`[config] LIFER_LIBRARY_ROOTS: skipping "${trimmed}", the filesystem root can't be a library root`);
      continue;
    }
    const rel = path.relative(resolvedDataDir, resolved);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      log.warn(`[config] LIFER_LIBRARY_ROOTS: skipping "${trimmed}", it's inside the main library folder already`);
      continue;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    roots.push({ label: rawLabel || path.basename(resolved), path: resolved });
  }
  return roots;
}

export const LIBRARY_ROOTS = parseLibraryRoots(process.env.LIFER_LIBRARY_ROOTS, DATA_DIR);

// The published pack index. Override only to test against another index.
export const PACK_INDEX_URL =
  process.env.PACK_INDEX_URL ?? "https://github.com/Sparklysparkspark/lifer-app/releases/download/packs-latest/pack-index.json";

// A small manifest checked before downloading the much larger catalog seed.
export const CATALOG_MANIFEST_URL =
  process.env.CATALOG_MANIFEST_URL ??
  "https://github.com/Sparklysparkspark/lifer-app/releases/download/catalog-latest/catalog-manifest.json";
export const CATALOG_SEED_URL =
  process.env.CATALOG_SEED_URL ??
  "https://github.com/Sparklysparkspark/lifer-app/releases/download/catalog-latest/lifer-catalog-seed.sql.gz";

// The catalog seed bundled into the Docker image at build time, so a fresh container needs no
// network. Empty elsewhere, where seedCatalogIfEmpty downloads it instead.
export const BUNDLED_CATALOG_SEED_DIR = path.join(REPO_ROOT, "catalog-seed");

// The CLIP ViT-L/14 vision encoder for suggestions and gallery search: a per-channel int8 copy
// (packages/data-pipeline/python/export_clip_model.py) on this repo's "models" release. A new
// checkpoint needs a new EMBEDDING_MODEL_VERSION too.
export const EMBEDDING_MODEL_URL =
  process.env.EMBEDDING_MODEL_URL ?? "https://github.com/Sparklysparkspark/lifer-app/releases/download/models/clip-vit-l14-v2.onnx";
// Stored with every vector so vectors from different models are never compared.
export const EMBEDDING_MODEL_VERSION = "clip-vit-l14-v2";
// The full-precision weights, which GPUs run. The catalog's stored vectors come from this file.
export const EMBEDDING_MODEL_GPU_URL: string | null =
  process.env.EMBEDDING_MODEL_GPU_URL ??
  "https://huggingface.co/Xenova/clip-vit-large-patch14/resolve/c307790166907339eed5a9a53a249af534102536/onnx/vision_model.onnx";
export const EMBEDDING_MODEL_GPU_BYTES = 1_216_438_437;

// The species identification model (BioCLIP 2 image encoder, int8 ONNX; see
// packages/data-pipeline/python/export_id_model.py), hosted on this repo's "models" release.
export { ID_MODEL_VERSION } from "@lifer/shared";
export const ID_MODEL_URL =
  process.env.ID_MODEL_URL ?? "https://github.com/Sparklysparkspark/lifer-app/releases/download/models/bioclip-2-v1.onnx";
// Its full-precision copy, which GPUs run (acceleration.ts): int8 gains nothing on a GPU.
export const ID_MODEL_GPU_URL =
  process.env.ID_MODEL_GPU_URL ?? "https://github.com/Sparklysparkspark/lifer-app/releases/download/models/bioclip-2-v1-fp32.onnx";
export const ID_MODEL_GPU_BYTES = 1_216_631_032;

// iNaturalist OAuth with PKCE (a secret in an open-source app isn't secret). These are the
// desktop defaults; a server registers its own iNaturalist app and sets both in Settings.
export const INAT_CLIENT_ID = process.env.INAT_CLIENT_ID || null;
export const INAT_REDIRECT_URI = process.env.INAT_REDIRECT_URI || `http://127.0.0.1:${PORT}/api/inaturalist/callback`;
