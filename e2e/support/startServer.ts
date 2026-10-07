// Playwright's webServer command. Playwright starts web servers before globalSetup, so getting
// the database ready happens here, before the server it belongs to starts:
//   1. a scratch Postgres (E2E_DATABASE_URL, or a throwaway Docker container),
//   2. a wiped schema, the real migrations and the fixture catalog,
//   3. the local mirror for packs and the catalog manifest,
//   4. the production build (apps/api/dist serving apps/web/dist), with its data in a temp dir.
// SIGTERM from Playwright at the end of the run undoes all of it.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { API_PORT, LOCAL_DATABASE_URL, LOCAL_PG_CONTAINER, LOCAL_PG_PORT, MIRROR_PORT, MIRROR_URL } from "./constants.js";
import { insertFixtureCatalog } from "./fixtureCatalog.js";
import { startMirror, type Mirror } from "./mirror.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const API_DIR = path.join(REPO_ROOT, "apps", "api");
const MIGRATE_JS = path.join(REPO_ROOT, "packages", "data-pipeline", "dist", "migrate.js");
const LOG_PATH = path.join(REPO_ROOT, "test-results", "e2e-server.log");

mkdirSync(path.dirname(LOG_PATH), { recursive: true });
const logFile = createWriteStream(LOG_PATH, { flags: "a" });
function log(line: string): void {
  logFile.write(`${line}\n`);
  // stderr is what Playwright shows from a web server, so setup progress and failures appear there.
  process.stderr.write(`[e2e] ${line}\n`);
}

let startedContainer = false;
let tempDir: string | null = null;
let mirror: Mirror | null = null;
let api: ChildProcess | null = null;
let cleaningUp = false;

async function cleanup(code: number): Promise<void> {
  // Playwright signals the whole process group, so this process hears SIGTERM twice (directly and
  // relayed by tsx). The second must not cut the first cleanup short.
  if (cleaningUp) return;
  cleaningUp = true;
  log("shutting down");
  if (api && api.exitCode === null) {
    const exited = new Promise((resolve) => api!.once("exit", resolve));
    api.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 8000))]);
  }
  await mirror?.close().catch(() => {});
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  if (startedContainer) {
    log(`removing container ${LOCAL_PG_CONTAINER}`);
    try {
      execFileSync("docker", ["rm", "-f", LOCAL_PG_CONTAINER], { stdio: "ignore" });
    } catch {
      // Already gone.
    }
  }
  logFile.end();
  process.exit(code);
}
process.on("SIGTERM", () => void cleanup(0));
process.on("SIGINT", () => void cleanup(0));

async function connectWithRetry(url: string, timeoutMs: number): Promise<pg.Client> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      return client;
    } catch (err) {
      await client.end().catch(() => {});
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

function startLocalPostgres(): void {
  try {
    execFileSync("docker", ["rm", "-f", LOCAL_PG_CONTAINER], { stdio: "ignore" });
  } catch {
    // Nothing left over from an earlier run.
  }
  log(`starting Postgres container ${LOCAL_PG_CONTAINER} on 127.0.0.1:${LOCAL_PG_PORT}`);
  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--rm",
      "--name",
      LOCAL_PG_CONTAINER,
      "-e",
      "POSTGRES_USER=lifer",
      "-e",
      "POSTGRES_PASSWORD=lifer",
      "-e",
      "POSTGRES_DB=lifer_e2e",
      "-p",
      `127.0.0.1:${LOCAL_PG_PORT}:5432`,
      "postgres:18-alpine",
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  startedContainer = true;
}

async function prepareDatabase(url: string): Promise<void> {
  // The schema is dropped below, so refuse anything that isn't plainly a throwaway database.
  const dbName = new URL(url).pathname.slice(1);
  if (!dbName.includes("e2e")) {
    throw new Error(`Refusing to wipe database "${dbName}": the e2e database's name must contain "e2e".`);
  }
  const db = await connectWithRetry(url, 60_000);
  try {
    log(`resetting database ${dbName}`);
    await db.query("DROP SCHEMA public CASCADE");
    await db.query("CREATE SCHEMA public");
  } finally {
    await db.end();
  }

  if (!existsSync(MIGRATE_JS)) {
    throw new Error(`${MIGRATE_JS} is missing. Build first: npm run build -w web && npm run build -w api`);
  }
  log("applying migrations");
  const migrateOutput = execFileSync(process.execPath, [MIGRATE_JS], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
  });
  logFile.write(migrateOutput);

  const fixtureDb = await connectWithRetry(url, 10_000);
  try {
    log("inserting the fixture catalog");
    await insertFixtureCatalog(fixtureDb);
  } finally {
    await fixtureDb.end();
  }
}

async function main(): Promise<void> {
  if (!existsSync(path.join(API_DIR, "dist", "index.js")) || !existsSync(path.join(REPO_ROOT, "apps", "web", "dist"))) {
    throw new Error("The production build is missing. Build first: npm run build -w web && npm run build -w api");
  }

  let databaseUrl = process.env.E2E_DATABASE_URL;
  if (!databaseUrl) {
    startLocalPostgres();
    databaseUrl = LOCAL_DATABASE_URL;
  }
  await prepareDatabase(databaseUrl);

  tempDir = mkdtempSync(path.join(os.tmpdir(), "lifer-e2e-"));
  mirror = await startMirror({ port: MIRROR_PORT, workDir: path.join(tempDir, "mirror"), log });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // As in the Docker image.
    NODE_ENV: "production",
    PORT: String(API_PORT),
    DATABASE_URL: databaseUrl,
    // The repo's .env is loaded too (config.ts), but never overrides a variable set here, so
    // everything it might set is pinned: server mode with real sign-in, no third-party keys.
    SINGLE_USER_MODE: "0",
    LIFER_ALLOW_UNTOKENED_DESKTOP: "",
    GBIF_USER: "",
    GBIF_PWD: "",
    EBIRD_API_KEY: "",
    INAT_CLIENT_ID: "",
    DATA_DIR: path.join(tempDir, "library"),
    APP_DATA_DIR: path.join(tempDir, "app-data"),
    // CPU only: no GPU self-test or GPU runtime download (species/accelerationSetup.ts).
    LIFER_GPU: "off",
    PACK_INDEX_URL: `${MIRROR_URL}/pack-index.json`,
    CATALOG_MANIFEST_URL: `${MIRROR_URL}/catalog-manifest.json`,
    CATALOG_SEED_URL: `${MIRROR_URL}/catalog-seed.sql.gz`,
    MAP_DOWNLOAD_URL: `${MIRROR_URL}/world.pmtiles`,
    // Every other fetch goes through the mirror as a proxy and is refused there, so a code path
    // that reaches for the internet shows up in the log instead of slowing or flaking the run.
    NODE_USE_ENV_PROXY: "1",
    HTTP_PROXY: MIRROR_URL,
    HTTPS_PROXY: MIRROR_URL,
    NO_PROXY: "127.0.0.1,localhost",
  };
  for (const dir of [env.DATA_DIR!, env.APP_DATA_DIR!]) mkdirSync(dir, { recursive: true });

  log(`starting the API on port ${API_PORT}`);
  api = spawn(process.execPath, ["dist/index.js"], { cwd: API_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  api.stdout!.pipe(logFile, { end: false });
  api.stderr!.pipe(logFile, { end: false });
  api.on("exit", (code, signal) => {
    if (cleaningUp) return;
    log(`the API exited unexpectedly (code ${code}, signal ${signal}); see ${LOG_PATH}`);
    void cleanup(1);
  });
}

main().catch((err) => {
  log(`setup failed: ${(err as Error).stack ?? err}`);
  void cleanup(1);
});
