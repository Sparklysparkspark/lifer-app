// Downloads the species/region catalog seed (see embedded_db.rs's restore_catalog_seed_if_needed)
// and bundles it as a Tauri resource, the same "fetch once at build time, ship it in the
// installer" pattern fetch-node-sidecar.js already uses for the Node runtime, so first launch
// works fully offline. embedded_db.rs still falls back to downloading it live if this bundled
// copy is missing (e.g. `tauri dev` without having run this script).
//
// The manifest is bundled next to the seed so the API knows which catalog version it has.
// Gallery embeddings are a separate asset the API fetches with the CLIP model; never bundled.
import { mkdirSync, createWriteStream, createReadStream, statSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RELEASE_BASE = "https://github.com/Sparklysparkspark/lifer-app/releases/download/catalog-latest";
const CATALOG_MANIFEST_URL = `${RELEASE_BASE}/catalog-manifest.json`;
const FALLBACK_SEED_URL = `${RELEASE_BASE}/lifer-catalog-seed.sql.gz`;
// The base seed is ~60MB. Anything this big means something large (like gallery embeddings)
// slipped back into it, which breaks the Windows installer and every app update.
const MAX_SEED_BYTES = 200 * 1024 * 1024;

async function fetchManifest() {
  const res = await fetch(CATALOG_MANIFEST_URL, { redirect: "follow" });
  if (!res.ok) {
    console.warn(`[fetch-catalog-seed] no manifest (HTTP ${res.status}), downloading the seed without a checksum`);
    return null;
  }
  return res.json();
}

// New shape: { version, publishedAt, seed: { url, sha256, bytes }, galleryEmbeddings }.
// Old shape: { version, ... } with the seed at its fixed release URL and no checksum.
function seedInfo(manifest) {
  const seed = manifest && typeof manifest.seed === "object" ? manifest.seed : null;
  return {
    url: seed?.url ? new URL(seed.url, CATALOG_MANIFEST_URL).href : FALLBACK_SEED_URL,
    sha256: seed?.sha256 ?? null,
    bytes: typeof seed?.bytes === "number" ? seed.bytes : null,
  };
}

async function sha256File(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function main() {
  const destDir = path.join(__dirname, "..", "src-tauri", "resources-staging", "catalog-seed");
  mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, "lifer-catalog-seed.sql.gz");
  const manifestDest = path.join(destDir, "catalog-manifest.json");

  const manifest = await fetchManifest();
  const seed = seedInfo(manifest);
  if (seed.bytes !== null && seed.bytes > MAX_SEED_BYTES) {
    throw new Error(`Catalog seed is ${seed.bytes} bytes per the manifest, over the ${MAX_SEED_BYTES} byte limit.`);
  }

  console.log(`[fetch-catalog-seed] downloading ${seed.url}`);
  const res = await fetch(seed.url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download catalog seed: HTTP ${res.status}`);
  }
  await pipeline(res.body, createWriteStream(dest));

  const size = statSync(dest).size;
  if (size > MAX_SEED_BYTES) {
    rmSync(dest, { force: true });
    throw new Error(
      `Catalog seed is ${(size / 1e6).toFixed(0)}MB, over the ${MAX_SEED_BYTES / 1024 / 1024}MB limit. ` +
        "Check that build-catalog-seed.ts isn't dumping gallery embeddings into the seed, then republish it.",
    );
  }
  if (seed.sha256) {
    const actual = await sha256File(dest);
    if (actual !== seed.sha256.toLowerCase()) {
      rmSync(dest, { force: true });
      throw new Error(`Catalog seed checksum mismatch: expected ${seed.sha256}, got ${actual}`);
    }
    console.log("[fetch-catalog-seed] sha256 verified");
  }
  if (manifest) {
    writeFileSync(manifestDest, JSON.stringify(manifest, null, 2));
  } else {
    rmSync(manifestDest, { force: true });
  }
  console.log(`[fetch-catalog-seed] wrote ${dest} (${(size / 1e6).toFixed(1)}MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
