// Uploads already-built packs to their target GitHub Releases (one per continent, see
// release-groups.ts — packs-latest is now used only for pack-index.json), replacing whatever
// assets are already there for a rebuilt pack. This is deliberately a LOCAL script, not a CI
// workflow. Packs are built from this machine's own Postgres + locally-cached reference photos
// (see build-region-pack.ts's own top comment: "meant to be run by hand, occasionally"); there's
// no shared/hosted database a CI runner could reach, so publishing has to happen from wherever
// the data actually lives, same as build-region-pack.ts and build-pack-index.ts themselves.
//
// Requires pack-index.json to already exist in packsDir (run build-pack-index first) — that's
// where each pack's target release tag comes from (parsed out of its own `url` field), so this
// script never needs to re-derive continent/overflow assignments itself.
//
// Usage: npm run publish-packs -w data-pipeline -- [packsDir]
// Requires the GitHub CLI (`gh`), already authenticated (`gh auth status`).
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INDEX_RELEASE_TAG } from "../build/release-groups.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");

function run(cmd: string): string {
  return execSync(cmd, { encoding: "utf8" });
}

function releaseExists(tag: string): boolean {
  try {
    execSync(`gh release view ${tag}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// --latest=false on every one of these: they're rolling data bundles, not numbered app
// versions — none of them should ever show up as the repo's "Latest release" (that's
// release.yml's job, for app builds).
function ensureRelease(tag: string): void {
  if (releaseExists(tag)) return;
  console.log(`[publish-packs] creating release ${tag}`);
  const notes =
    tag === INDEX_RELEASE_TAG
      ? "The pack catalog (pack-index.json) — see apps/api/src/config.ts's PACK_INDEX_URL. " +
        "Individual packs now live on their own per-continent releases (packs-<continent>); " +
        "this release only ever carries the index file itself plus whatever legacy pack assets " +
        "were already here before that split. Never versioned — assets replaced on rebuild."
      : `Offline packs for this release group (rolling) — see apps/api/src/config.ts's PACK_INDEX_URL ` +
        `and packages/data-pipeline/src/build/release-groups.ts for how packs are assigned here. ` +
        `Assets here are replaced whenever packs are rebuilt; the release itself is never versioned.`;
  run(`gh release create ${tag} --title "Offline packs — ${tag}" --notes ${JSON.stringify(notes)} --latest=false`);
}

interface PackIndexEntry {
  id: string;
  url: string;
}

async function main() {
  const packsDir = process.argv[2] ?? path.join(REPO_ROOT, "packs");
  const indexPath = path.join(packsDir, "pack-index.json");
  if (!existsSync(indexPath)) {
    console.error(`${indexPath} doesn't exist — run build-pack-index first.`);
    process.exit(1);
  }
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as { packs: PackIndexEntry[] };

  const localPackFiles = readdirSync(packsDir).filter((f) => f.endsWith(".pack.tar.gz"));
  console.log(`[publish-packs] ${localPackFiles.length} pack file(s) + pack-index.json to upload from ${packsDir}`);

  // Each local pack's target release tag comes straight out of the URL build-pack-index.ts just
  // computed for it — parsing "releases/download/<tag>/<file>" rather than re-deriving
  // continent/overflow assignments here keeps this script from ever disagreeing with the index
  // about where a pack actually lives.
  const tagByFile = new Map<string, string>();
  for (const entry of index.packs) {
    const match = entry.url.match(/\/releases\/download\/([^/]+)\//);
    if (match) tagByFile.set(`${entry.id}.pack.tar.gz`, match[1]);
  }

  const filesByTag = new Map<string, string[]>();
  for (const file of localPackFiles) {
    // Falls back to the index release if a local file's own index entry is somehow missing —
    // shouldn't happen (build-pack-index.ts just built this same file list), but a safe default
    // beats silently skipping the upload.
    const tag = tagByFile.get(file) ?? INDEX_RELEASE_TAG;
    if (!filesByTag.has(tag)) filesByTag.set(tag, []);
    filesByTag.get(tag)!.push(file);
  }
  // pack-index.json always publishes alongside on its own fixed release — the one URL
  // PACK_INDEX_URL is hardcoded to.
  if (!filesByTag.has(INDEX_RELEASE_TAG)) filesByTag.set(INDEX_RELEASE_TAG, []);
  filesByTag.get(INDEX_RELEASE_TAG)!.push("pack-index.json");

  for (const [tag, files] of filesByTag) {
    ensureRelease(tag);
    // --clobber overwrites an existing asset of the same name — every one of these releases is
    // rolling by design, not append-only, so a rebuilt pack should replace its predecessor
    // outright.
    const fileArgs = files.map((f) => JSON.stringify(path.join(packsDir, f))).join(" ");
    run(`gh release upload ${tag} ${fileArgs} --clobber`);
    console.log(`[publish-packs] uploaded ${files.length} file(s) to ${tag}`);
  }
  console.log(`[publish-packs] done — https://github.com/Sparklysparkspark/lifer-app/releases/tag/${INDEX_RELEASE_TAG}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
