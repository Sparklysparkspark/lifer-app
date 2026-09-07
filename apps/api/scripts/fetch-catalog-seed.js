// Downloads the species/region catalog seed at DOCKER IMAGE BUILD time and bundles it into the
// image — the same "fetch once at build time, ship it, work offline on first launch" pattern
// apps/desktop/scripts/fetch-catalog-seed.js already uses for the Tauri build. Without this, a
// fresh container's very first launch had to download this ~50MB file live over the network
// before Offline Packs/checklists showed anything — see catalogSeedUpdate.ts's seedCatalogIfEmpty,
// which prefers this bundled copy and only falls back to a live network download if it's missing
// (e.g. a local `docker build` run offline, or this script failing for some reason).
import { mkdirSync, createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const CATALOG_MANIFEST_URL =
  "https://github.com/Sparklysparkspark/lifer-app/releases/download/catalog-latest/catalog-manifest.json";
const CATALOG_SEED_URL =
  "https://github.com/Sparklysparkspark/lifer-app/releases/download/catalog-latest/lifer-catalog-seed.sql.gz";

async function download(url, dest) {
  console.log(`[fetch-catalog-seed] downloading ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  await pipeline(res.body, createWriteStream(dest));
  console.log(`[fetch-catalog-seed] wrote ${dest}`);
}

async function main() {
  const destDir = path.join(REPO_ROOT, "catalog-seed");
  mkdirSync(destDir, { recursive: true });
  await download(CATALOG_MANIFEST_URL, path.join(destDir, "catalog-manifest.json"));
  await download(CATALOG_SEED_URL, path.join(destDir, "lifer-catalog-seed.sql.gz"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
