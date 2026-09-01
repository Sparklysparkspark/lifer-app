// Builds pack-index.json — the file apps/api/src/config.ts's PACK_INDEX_URL points to. This
// didn't exist anywhere in the repo before: packs were built one at a time by build-region-
// pack.ts, but nothing ever assembled the combined index a client fetches to know what packs
// exist, their sizes, and (new) their content version. Reads each already-built pack's own
// manifest.json rather than re-deriving anything, so the index can never drift from what a pack
// actually contains.
//
// Usage: npm run build-pack-index -w data-pipeline -- [packsDir]
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import { packIdFromFileName } from "./pack-id.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");

// Same "one dedicated, rolling GitHub Release, assets replaced on each rebuild" shape already
// used for MAP_DOWNLOAD_URL (see apps/api/src/config.ts) — packs aren't tied to a specific app
// version/tag the way the desktop build's release assets are, so they get their own tag rather
// than living on a numbered app release.
const PACKS_RELEASE_TAG = "packs-latest";
const GITHUB_REPO = "Sparklysparkspark/lifer-app";

interface PackManifestCore {
  type: "region" | "seaZone";
  region?: string;
  seaZone?: string;
  taxon?: string | null;
  speciesCount: number;
  contentVersion: string;
  species: Array<{ scientificName: string }>;
  // A country pack's top-level species and its bundled provinces'/states' own species lists
  // are NOT deduplicated against each other in build-region-pack.ts's manifest (each child
  // region gets its own full checklist) — deduping across both is this file's job below, not
  // something already done by the time the manifest is read here.
  children?: Array<{ species: Array<{ scientificName: string }> }>;
  seaZoneDependencies?: Array<{ name: string; packFile: string }>;
}

function readManifest(archivePath: string): PackManifestCore {
  const extractDir = mkdtempSync(path.join(os.tmpdir(), "lifer-pack-index-"));
  try {
    tar.extract({ file: archivePath, cwd: extractDir, sync: true });
    const manifestPath = path.join(extractDir, "manifest.json");
    return JSON.parse(readFileSync(manifestPath, "utf8")) as PackManifestCore;
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

async function main() {
  const packsDir = process.argv[2] ?? path.join(REPO_ROOT, "packs");
  if (!existsSync(packsDir)) {
    console.error(`No such directory: ${packsDir}`);
    process.exit(1);
  }

  const files = readdirSync(packsDir).filter((f) => f.endsWith(".pack.tar.gz"));
  if (files.length === 0) {
    console.error(`No .pack.tar.gz files found in ${packsDir}`);
    process.exit(1);
  }

  const packs = files.map((file) => {
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
      `[build-pack-index] ${file}: ${manifest.speciesCount} species, ${scientificNames.length} distinct, ${(sizeBytes / 1024 / 1024).toFixed(1)} MB`,
    );
    return {
      id: packIdFromFileName(file),
      type: manifest.type,
      region: manifest.region,
      seaZone: manifest.seaZone,
      taxon: manifest.taxon ?? null,
      sizeBytes,
      speciesCount: manifest.speciesCount,
      contentVersion: manifest.contentVersion,
      scientificNames,
      url: `https://github.com/${GITHUB_REPO}/releases/download/${PACKS_RELEASE_TAG}/${file}`,
      seaZoneDependencies: manifest.seaZoneDependencies?.map((d) => d.name),
    };
  });

  const index = { generatedAt: new Date().toISOString(), packs };
  const indexPath = path.join(packsDir, "pack-index.json");
  writeFileSync(indexPath, JSON.stringify(index, null, 2));
  console.log(`[build-pack-index] wrote ${indexPath} (${packs.length} packs)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
