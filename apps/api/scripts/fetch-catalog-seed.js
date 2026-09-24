// Downloads the species/region catalog seed at DOCKER IMAGE BUILD time and bundles it into the
// image, so a fresh container's first launch works offline (see catalogSeedUpdate.ts's
// seedCatalogIfEmpty, which prefers this bundled copy and falls back to a live download). Only
// the seed is bundled: the gallery embeddings asset is useless without the opt-in CLIP model, so
// the app fetches it when the model is downloaded.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const CATALOG_MANIFEST_URL =
  "https://github.com/Sparklysparkspark/lifer-app/releases/download/catalog-latest/catalog-manifest.json";
const LEGACY_SEED_URL =
  "https://github.com/Sparklysparkspark/lifer-app/releases/download/catalog-latest/lifer-catalog-seed.sql.gz";
// Matches build-catalog-seed.ts. A bigger seed means something large got added to it.
const MAX_SEED_BYTES = 200 * 1024 * 1024;

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function main() {
  const destDir = path.join(REPO_ROOT, "catalog-seed");
  mkdirSync(destDir, { recursive: true });

  const manifestRes = await fetch(CATALOG_MANIFEST_URL, { redirect: "follow" });
  if (!manifestRes.ok) throw new Error(`Failed to download ${CATALOG_MANIFEST_URL}: HTTP ${manifestRes.status}`);
  const manifest = await manifestRes.json();
  writeFileSync(path.join(destDir, "catalog-manifest.json"), JSON.stringify(manifest, null, 2));

  const seedUrl = manifest.seed ? new URL(manifest.seed.url, CATALOG_MANIFEST_URL).toString() : LEGACY_SEED_URL;
  if (manifest.seed?.bytes > MAX_SEED_BYTES) {
    throw new Error(`Published seed is ${Math.round(manifest.seed.bytes / 1048576)} MB, over the 200 MB limit`);
  }
  const dest = path.join(destDir, "lifer-catalog-seed.sql.gz");
  console.log(`[fetch-catalog-seed] downloading ${seedUrl}`);
  const res = await fetch(seedUrl, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Failed to download ${seedUrl}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));

  const bytes = statSync(dest).size;
  if (bytes > MAX_SEED_BYTES) {
    rmSync(dest);
    throw new Error(`Seed is ${Math.round(bytes / 1048576)} MB, over the 200 MB limit. Republish it with build-catalog-seed.ts.`);
  }
  if (manifest.seed?.sha256 && (await sha256(dest)) !== manifest.seed.sha256) {
    rmSync(dest);
    throw new Error("Seed checksum doesn't match the manifest");
  }
  console.log(`[fetch-catalog-seed] wrote ${dest} (${(bytes / 1048576).toFixed(1)} MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
