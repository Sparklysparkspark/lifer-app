// Builds pack-index.json, the file packages/core/src/config.ts's PACK_INDEX_URL points to: which packs
// exist, their sizes and content versions. Reads each built pack's manifest.json rather than
// re-deriving anything, so the index can't drift from the packs.
//
// Usage: npm run build-pack-index -w data-pipeline -- [packsDir]
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import { packIdFromFileName } from "@lifer/core/packs/packId.js";
import { photoStoreIndexUrl } from "../pipeline/photoStore.js";
import { fetchPublishedIndex, writePackIndexFiles, type IndexPack, type PackIndex } from "../pipeline/packIndex.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");

interface PackManifestCore {
  type: "region" | "seaZone";
  region?: string;
  seaZone?: string;
  taxon?: string | null;
  // Missing means "full" (see offlinePacks/routes.ts's PackStatus mapping).
  variant?: "full" | "small";
  speciesCount: number;
  contentVersion: string;
  species: Array<{ scientificName: string }>;
  // A country pack's species and its bundled provinces' lists overlap in the manifest; this file
  // dedupes across them.
  children?: Array<{ species: Array<{ scientificName: string }> }>;
  seaZoneDependencies?: Array<{ name: string; packFile: string }>;
  // Uncompressed byte counts from build time (see build-region-pack.ts's photoBytesInStaging),
  // an estimate of relative weight rather than an exact post-gzip split.
  photoBytes?: number;
  checklistBytes?: number;
}

// `filter` extracts only manifest.json, since a pack's photos/ can run to hundreds of MB.
function readManifest(archivePath: string): PackManifestCore {
  const extractDir = mkdtempSync(path.join(os.tmpdir(), "lifer-pack-index-"));
  try {
    tar.extract({ file: archivePath, cwd: extractDir, sync: true, filter: (p) => p === "manifest.json" });
    const manifestPath = path.join(extractDir, "manifest.json");
    return JSON.parse(readFileSync(manifestPath, "utf8")) as PackManifestCore;
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

/** The index for every archive in packsDir, plus each format-3 pack in `published` this batch
 *  didn't rebuild (otherwise earlier packs would drop out of the index). */
export function buildPackIndex(
  packsDir: string,
  published: PackIndex,
): PackIndex & { photoStore: { indexUrl: string } } {
  const files = readdirSync(packsDir).filter((f) => f.endsWith(".pack.tar.gz"));
  if (files.length === 0) throw new Error(`No .pack.tar.gz files found in ${packsDir}`);

  // One manifest at a time, never the whole batch in memory.
  const packs = files.map((file) => buildPackEntry(packsDir, file));
  const localIds = new Set(packs.map((p) => p.id));
  const carriedForward = published.packs.filter((p) => !localIds.has(p.id) && p.format === 3);
  console.log(`[build-pack-index] merging in ${carriedForward.length} previously-published pack(s) not in this batch`);
  // Where installs fetch pack photos from (pipeline/photoStore.ts).
  return {
    generatedAt: new Date().toISOString(),
    photoStore: { indexUrl: photoStoreIndexUrl() },
    packs: [...carriedForward, ...packs],
  };
}

function buildPackEntry(packsDir: string, file: string): IndexPack & { photoBytes?: number; checklistBytes?: number } {
  const archivePath = path.join(packsDir, file);
  const manifest = readManifest(archivePath);
  const sizeBytes = statSync(archivePath).size;
  const scientificNames = [
    ...new Set([
      ...manifest.species.map((s) => s.scientificName),
      ...(manifest.children ?? []).flatMap((c) => c.species.map((s) => s.scientificName)),
    ]),
  ];
  console.log(
    `[build-pack-index] ${file}: ${manifest.speciesCount} species, ${scientificNames.length} distinct, ` +
      `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`,
  );
  return {
    id: packIdFromFileName(file),
    // Checklist-only packs in the pack store, photos in the photo store. packs.ts's writePackStore
    // sets url, range and sha256 once the archive is in a shard.
    format: 3,
    type: manifest.type,
    region: manifest.region,
    seaZone: manifest.seaZone,
    taxon: manifest.taxon ?? null,
    variant: manifest.variant ?? "full",
    sizeBytes,
    speciesCount: manifest.speciesCount,
    contentVersion: manifest.contentVersion,
    scientificNames,
    url: "",
    range: undefined,
    sha256: undefined,
    // Pack IDs, not zone names: a sea zone can have several packs (one per taxon), so a dependency
    // names the specific one (e.g. "seazone-red_sea-actinopterygii").
    seaZoneDependencies: manifest.seaZoneDependencies?.map((d) => packIdFromFileName(d.packFile)),
    photoBytes: manifest.photoBytes,
    checklistBytes: manifest.checklistBytes,
  };
}

async function main() {
  const packsDir = process.argv[2] ?? path.join(REPO_ROOT, "packs");
  if (!existsSync(packsDir)) throw new Error(`No such directory: ${packsDir}`);
  // Retried; only a 404 (nothing published yet) gives an index of just this batch. Any other
  // failure throws, since a local-only index would drop every published pack.
  const index = buildPackIndex(packsDir, await fetchPublishedIndex());
  writePackIndexFiles(packsDir, index);
  console.log(
    `[build-pack-index] wrote pack-index.json and pack-index-lite.json in ${packsDir} (${index.packs.length} packs)`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
