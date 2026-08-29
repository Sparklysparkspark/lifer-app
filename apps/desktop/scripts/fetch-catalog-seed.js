// Downloads the species/region catalog seed (see embedded_db.rs's restore_catalog_seed_if_needed)
// and bundles it as a Tauri resource, the same "fetch once at build time, ship it in the
// installer" pattern fetch-node-sidecar.js already uses for the Node runtime. Without this, a
// fresh install would need to download this ~50MB file over the network on its very first
// launch before showing anything — bundling it means first launch works fully offline and
// doesn't need to wait on that download at all. embedded_db.rs still falls back to downloading
// it live if this bundled copy is missing (e.g. `tauri dev` without having run this script).
import { mkdirSync, createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_SEED_URL =
  "https://github.com/Sparklysparkspark/lifer-app/releases/download/catalog-latest/lifer-catalog-seed.sql.gz";

async function main() {
  const destDir = path.join(__dirname, "..", "src-tauri", "resources-staging", "catalog-seed");
  mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, "lifer-catalog-seed.sql.gz");

  console.log(`[fetch-catalog-seed] downloading ${CATALOG_SEED_URL}`);
  const res = await fetch(CATALOG_SEED_URL, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download catalog seed: HTTP ${res.status}`);
  }
  await pipeline(res.body, createWriteStream(dest));
  console.log(`[fetch-catalog-seed] wrote ${dest}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
