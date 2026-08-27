// Uploads already-built packs + pack-index.json to a rolling GitHub Release, replacing
// whatever assets are already there — this is deliberately a LOCAL script, not a CI workflow.
// Packs are built from this machine's own Postgres + locally-cached reference photos (see
// build-region-pack.ts's own top comment: "meant to be run by hand, occasionally"); there's no
// shared/hosted database a CI runner could reach, so publishing has to happen from wherever the
// data actually lives, same as build-region-pack.ts and build-pack-index.ts themselves.
//
// Usage: npm run publish-packs -w data-pipeline -- [packsDir]
// Requires the GitHub CLI (`gh`), already authenticated (`gh auth status`).
import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");
const RELEASE_TAG = "packs-latest";

function run(cmd: string): string {
  return execSync(cmd, { encoding: "utf8" });
}

function releaseExists(): boolean {
  try {
    execSync(`gh release view ${RELEASE_TAG}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const packsDir = process.argv[2] ?? path.join(REPO_ROOT, "packs");
  const indexPath = path.join(packsDir, "pack-index.json");
  if (!existsSync(indexPath)) {
    console.error(`${indexPath} doesn't exist — run build-pack-index first.`);
    process.exit(1);
  }

  const files = readdirSync(packsDir).filter((f) => f.endsWith(".pack.tar.gz") || f === "pack-index.json");
  console.log(`[publish-packs] ${files.length} file(s) to upload from ${packsDir}`);

  if (!releaseExists()) {
    console.log(`[publish-packs] creating release ${RELEASE_TAG}`);
    // --latest=false: this is a rolling data bundle, not a numbered app version — it should
    // never show up as the repo's "Latest release" (that's release.yml's job, for app builds).
    run(
      `gh release create ${RELEASE_TAG} --title "Offline packs (rolling)" ` +
        `--notes "Data packs for the Offline Packs feature — see apps/api/src/config.ts's PACK_INDEX_URL. ` +
        `Assets here are replaced whenever packs are rebuilt; the release itself is never versioned." --latest=false`,
    );
  }

  // --clobber overwrites an existing asset of the same name — this release is rolling by
  // design, not append-only, so a rebuilt pack should replace its predecessor outright.
  const fileArgs = files.map((f) => JSON.stringify(path.join(packsDir, f))).join(" ");
  run(`gh release upload ${RELEASE_TAG} ${fileArgs} --clobber`);
  console.log(`[publish-packs] done — https://github.com/Sparklysparkspark/lifer-app/releases/tag/${RELEASE_TAG}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
