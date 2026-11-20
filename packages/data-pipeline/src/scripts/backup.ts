// Phase 6 (spec §9): backs up the database and display copies. Scheduling is host config, so run
// this by hand or from your own crontab: `npm run backup -w data-pipeline`.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATABASE_URL } from "@lifer/core/config.js";
import { BACKUP_DIR, dumpDatabase, snapshotStamp } from "../pipeline/dbSnapshot.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

// Mirrors packages/core/src/config.ts's DATA_DIR default without importing from apps/api (which would
// pull in sharp/exiftool-vendored).
const DATA_DIR = process.env.DATA_DIR ?? path.join(REPO_ROOT, "data", "lifer");

function tar(archivePath: string): Promise<void> {
  // -C + a relative path (not the absolute DATA_DIR) so the archive extracts as a plain
  // "lifer/..." tree instead of embedding this machine's absolute path.
  const child = spawn("tar", ["-czf", archivePath, "-C", path.dirname(DATA_DIR), path.basename(DATA_DIR)], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with code ${code}`))));
  });
}

async function main() {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = snapshotStamp();

  const dumpPath = path.join(BACKUP_DIR, `lifer-db-${stamp}.dump`);
  await dumpDatabase(DATABASE_URL, dumpPath, (m) => console.log(`[backup] ${m}`));

  const dataArchivePath = path.join(BACKUP_DIR, `lifer-data-${stamp}.tar.gz`);
  console.log(`[backup] archiving ${DATA_DIR} to ${dataArchivePath}`);
  await tar(dataArchivePath);

  console.log(`[backup] done: ${dumpPath}, ${dataArchivePath}`);
}

main().catch((err) => {
  console.error("[backup] failed:", err);
  process.exit(1);
});
