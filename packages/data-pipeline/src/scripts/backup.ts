// Phase 6 (spec §9): "Backup strategy for the database and display copies." A single script
// rather than any cron wiring here — cron is host config, not something to script
// unilaterally (same reasoning as leaving the reverse-proxy/TLS step to the user). Run this
// by hand or from your own crontab: `npm run backup -w data-pipeline`.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");

// Mirrors apps/api/src/config.ts's DATA_DIR default — this script has no reason to import
// from apps/api (that would pull sharp/exiftool-vendored in for no benefit), so it just
// matches the same env var and default path instead.
const DATA_DIR = process.env.DATA_DIR ?? path.join(REPO_ROOT, "data", "lifer");
const BACKUP_DIR = process.env.LIFER_BACKUP_DIR ?? path.join(REPO_ROOT, "data", "backups");
// Postgres runs in Docker (docker-compose.yml) with no client tools installed on the host,
// so pg_dump runs INSIDE the container rather than assuming a host install.
const POSTGRES_CONTAINER = process.env.LIFER_POSTGRES_CONTAINER ?? "lifer-app-postgres-1";
const POSTGRES_USER = process.env.POSTGRES_USER ?? "lifer";
const POSTGRES_DB = process.env.POSTGRES_DB ?? "lifer";

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function dumpDatabase(dumpPath: string): Promise<void> {
  const dest = createWriteStream(dumpPath);
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      "docker",
      ["exec", POSTGRES_CONTAINER, "pg_dump", "-U", POSTGRES_USER, POSTGRES_DB],
      { maxBuffer: 1024 * 1024 * 1024 },
    );
    child.stdout!.pipe(dest);
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump exited with code ${code}`))));
  });
}

async function main() {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = timestamp();

  const dumpPath = path.join(BACKUP_DIR, `lifer-db-${stamp}.sql`);
  console.log(`[backup] dumping database (via docker exec ${POSTGRES_CONTAINER}) to ${dumpPath}`);
  await dumpDatabase(dumpPath);

  const dataArchivePath = path.join(BACKUP_DIR, `lifer-data-${stamp}.tar.gz`);
  console.log(`[backup] archiving ${DATA_DIR} to ${dataArchivePath}`);
  // -C + a relative path (not the absolute DATA_DIR) so the archive extracts as a plain
  // "lifer/..." tree instead of embedding this machine's absolute path.
  await execFileAsync("tar", ["-czf", dataArchivePath, "-C", path.dirname(DATA_DIR), path.basename(DATA_DIR)]);

  console.log(`[backup] done: ${dumpPath}, ${dataArchivePath}`);
}

main().catch((err) => {
  console.error("[backup] failed:", err);
  process.exit(1);
});
