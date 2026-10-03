// Builds pack-index.json, the file apps/api/src/config.ts's PACK_INDEX_URL points to: which packs
// exist, their sizes and content versions. Reads each built pack's manifest.json rather than
// re-deriving anything, so the index can't drift from the packs.
//
// Usage: npm run build-pack-index -w data-pipeline -- [packsDir]
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import { packIdFromFileName } from "./pack-id.js";
import { GITHUB_REPO, INDEX_RELEASE_TAG } from "./release-groups.js";
import { photoStoreIndexUrl } from "../pipeline/photoStore.js";

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

  // One manifest at a time, never the whole batch in memory.
  const packs: Array<ReturnType<typeof buildPackEntry>> = [];
  for (const file of files) {
    packs.push(buildPackEntry(packsDir, file));
  }

  function buildPackEntry(packsDir: string, file: string) {
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
      range: undefined as [number, number] | undefined,
      sha256: undefined as string | undefined,
      // Pack IDs, not zone names: a sea zone can have several packs (one per taxon), so a dependency
      // names the specific one (e.g. "seazone-red_sea-actinopterygii").
      seaZoneDependencies: manifest.seaZoneDependencies?.map((d) => packIdFromFileName(d.packFile)),
      photoBytes: manifest.photoBytes,
      checklistBytes: manifest.checklistBytes,
    };
  }

  // This run only builds the local batch, so the currently published index is fetched and every
  // entry this batch didn't rebuild is kept; otherwise earlier packs would drop out of the index.
  // Falls back to local-only with a warning if the fetch fails (first run, offline).
  const localIds = new Set(packs.map((p) => p.id));
  let carriedForward: typeof packs = [];
  try {
    const res = await fetch(`https://github.com/${GITHUB_REPO}/releases/download/${INDEX_RELEASE_TAG}/pack-index.json`);
    if (res.ok) {
      const existing = (await res.json()) as { packs: typeof packs };
      carriedForward = existing.packs.filter((p) => !localIds.has(p.id) && (p as { format?: number }).format === 3);
      console.log(`[build-pack-index] merging in ${carriedForward.length} previously-published pack(s) not in this batch`);
    } else {
      console.warn(`[build-pack-index] no existing published index found (${res.status}): writing local-only index`);
    }
  } catch (err) {
    console.warn(`[build-pack-index] couldn't fetch existing published index (${(err as Error).message}): writing local-only index`);
  }

  // Where installs fetch pack photos from (pipeline/photoStore.ts).
  const index = { generatedAt: new Date().toISOString(), photoStore: { indexUrl: photoStoreIndexUrl() }, packs: [...carriedForward, ...packs] };
  const indexPath = path.join(packsDir, "pack-index.json");
  writeFileSync(indexPath, JSON.stringify(index, null, 2));
  console.log(`[build-pack-index] wrote ${indexPath} (${index.packs.length} packs, ${packs.length} from this batch)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
