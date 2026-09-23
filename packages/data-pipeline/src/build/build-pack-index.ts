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
import { GITHUB_REPO, INDEX_RELEASE_TAG, baseReleaseTagFor, planReleaseAssignments } from "./release-groups.js";
import { pool } from "../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");

interface PackManifestCore {
  type: "region" | "seaZone";
  region?: string;
  seaZone?: string;
  taxon?: string | null;
  // Absent on any pack built before the small-pack variant existed, treated as "full" wherever
  // read (see offlinePacks/routes.ts's own PackStatus mapping).
  variant?: "full" | "small";
  speciesCount: number;
  contentVersion: string;
  species: Array<{ scientificName: string }>;
  // A country pack's top-level species and its bundled provinces'/states' own species lists
  // are NOT deduplicated against each other in build-region-pack.ts's manifest (each child
  // region gets its own full checklist) — deduping across both is this file's job below, not
  // something already done by the time the manifest is read here.
  children?: Array<{ species: Array<{ scientificName: string }> }>;
  seaZoneDependencies?: Array<{ name: string; packFile: string }>;
  // Uncompressed byte counts computed at build time (see build-region-pack.ts's
  // photoBytesInStaging) — an ESTIMATE of relative weight, not an exact post-gzip split (the
  // archive compresses both together in one stream, so there's no way to recover an exact
  // split from the finished file). Absent on any pack built before this field existed.
  photoBytes?: number;
  checklistBytes?: number;
}

// `filter` limits extraction to manifest.json alone — a pack's photos/ directory can run to
// hundreds of MB, and extracting the whole archive to disk just to read one small JSON file out
// of it (the original shape of this function) was always wasteful; it also means readManifest
// no longer needs its own temp-dir cleanup dance for files it never touches.
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

  // Each pack's real target release (continent for a country, packs-seazones for a sea zone,
  // rolling over to base-2/base-3/... once a release nears GitHub's 1000-asset cap) — computed
  // ONCE across this whole local batch so files destined for the same release share the same
  // capacity accounting instead of each independently guessing it has room. A first pass just for
  // {type, region, seaZone} rather than holding every full manifest (species lists + embeddings)
  // in memory at once for the whole batch — a batch of ~1000 packs' worth of gallery-photo
  // embeddings blew the default heap doing exactly that (see this file's own git history).
  const assignmentItems: Array<{ baseTag: string; fileName: string }> = [];
  for (const file of files) {
    const { type, region, seaZone } = readManifest(path.join(packsDir, file));
    assignmentItems.push({ baseTag: await baseReleaseTagFor({ type, region, seaZone }), fileName: file });
  }
  const releaseTagByFile = planReleaseAssignments(assignmentItems);

  // Second pass re-reads each manifest one at a time (sequentially, not files.map — same reason
  // as above: never more than one full manifest live in memory at once) to build the real index
  // entries.
  const packs: Array<ReturnType<typeof buildPackEntry>> = [];
  for (const file of files) {
    packs.push(buildPackEntry(packsDir, file, releaseTagByFile.get(file)!));
  }

  function buildPackEntry(packsDir: string, file: string, releaseTag: string) {
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
        `${(sizeBytes / 1024 / 1024).toFixed(1)} MB -> ${releaseTag}`,
    );
    return {
      id: packIdFromFileName(file),
      type: manifest.type,
      region: manifest.region,
      seaZone: manifest.seaZone,
      taxon: manifest.taxon ?? null,
      variant: manifest.variant ?? "full",
      sizeBytes,
      speciesCount: manifest.speciesCount,
      contentVersion: manifest.contentVersion,
      scientificNames,
      url: `https://github.com/${GITHUB_REPO}/releases/download/${releaseTag}/${file}`,
      // Pack IDs, not zone names — a sea zone can now have several packs (one per taxon), so a
      // dependency has to name the SPECIFIC one this pack needs (e.g. "seazone-red_sea-
      // actinopterygii"), not just "Red Sea", which would be ambiguous once more than one
      // taxon-scoped pack exists for the same zone.
      seaZoneDependencies: manifest.seaZoneDependencies?.map((d) => packIdFromFileName(d.packFile)),
      photoBytes: manifest.photoBytes,
      checklistBytes: manifest.checklistBytes,
    };
  }

  // pack-index.json is regenerated from ONLY the current local batch (packsDir is cleared after
  // every publish flush — see build-and-publish-all-packs.ts) — without merging in whatever was
  // already published, every flush would silently drop every earlier batch's packs from the
  // index a client actually reads, even though their real files stay live on GitHub. Fetches the
  // currently-published index and keeps any entry this batch didn't just rebuild; falls back to
  // local-only (a warning, not a hard failure) if the fetch fails, e.g. first run / offline dev.
  const localIds = new Set(packs.map((p) => p.id));
  let carriedForward: typeof packs = [];
  try {
    const res = await fetch(`https://github.com/${GITHUB_REPO}/releases/download/${INDEX_RELEASE_TAG}/pack-index.json`);
    if (res.ok) {
      const existing = (await res.json()) as { packs: typeof packs };
      carriedForward = existing.packs.filter((p) => !localIds.has(p.id));
      console.log(`[build-pack-index] merging in ${carriedForward.length} previously-published pack(s) not in this batch`);
    } else {
      console.warn(`[build-pack-index] no existing published index found (${res.status}) — writing local-only index`);
    }
  } catch (err) {
    console.warn(`[build-pack-index] couldn't fetch existing published index (${(err as Error).message}) — writing local-only index`);
  }

  const index = { generatedAt: new Date().toISOString(), packs: [...carriedForward, ...packs] };
  const indexPath = path.join(packsDir, "pack-index.json");
  writeFileSync(indexPath, JSON.stringify(index, null, 2));
  console.log(`[build-pack-index] wrote ${indexPath} (${index.packs.length} packs, ${packs.length} from this batch)`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
