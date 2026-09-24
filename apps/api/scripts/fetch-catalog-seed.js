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
import { createGunzip, createGzip } from "node:zlib";
import readline from "node:readline";

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
  await extractRegions(dest, path.join(destDir, "lifer-catalog-regions.sql.gz"));
}

// A light copy of the seed's regions table (names and hierarchy, no map outlines), so a fresh
// server can list countries in onboarding within a second while the full catalog is still
// loading (see catalogSeedUpdate.ts's seedEmptyCatalog). The outlines are most of the table's
// ~100 MB and the full load fills them in right after. COPY text format escapes tabs inside
// values, so splitting a row on tabs is exact.
const HEAVY_REGION_COLUMNS = new Set(["boundary_geojson", "gbif_area_wkt"]);

async function extractRegions(seedPath, outPath) {
  const lines = readline.createInterface({ input: createReadStream(seedPath).pipe(createGunzip()), crlfDelay: Infinity });
  const out = [];
  let keep = null; // column indexes to keep, once the regions header is found
  for await (const line of lines) {
    if (!keep) {
      const header = /^(COPY (?:public\.)?regions) \((.*)\) FROM stdin;$/.exec(line);
      if (header) {
        const columns = header[2].split(",").map((c) => c.trim());
        keep = columns.map((c, i) => (HEAVY_REGION_COLUMNS.has(c.replace(/"/g, "")) ? -1 : i)).filter((i) => i >= 0);
        out.push(`${header[1]} (${keep.map((i) => columns[i]).join(", ")}) FROM stdin;`);
      }
      continue;
    }
    if (line === "\\.") {
      out.push(line);
      break;
    }
    const fields = line.split("\t");
    out.push(keep.map((i) => fields[i]).join("\t"));
  }
  lines.close();
  if (!keep || out[out.length - 1] !== "\\.") {
    console.warn("[fetch-catalog-seed] no complete regions table in the seed; skipping the regions-only file");
    return;
  }
  const gzip = createGzip();
  const done = pipeline(gzip, createWriteStream(outPath));
  gzip.end(out.join("\n") + "\n");
  await done;
  console.log(`[fetch-catalog-seed] wrote ${outPath} (${out.length - 2} regions)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
