// Dev tool: runs the app's embedded Postgres binary and data directory as an independent
// process, instead of the app. Postgres locks its data dir, so use one or the other. Launch the
// app with DATABASE_URL pointing here (api.rs honors it) and long background jobs survive
// app rebuilds.
//
// Usage: node headless-postgres.js start|stop|status|url
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const DB_NAME = "lifer";
const DB_USER = "postgres";
const PORT = 55432;
const HOST = "127.0.0.1";

// Tauri's app_data_dir() for this bundle identifier. macOS only; this is a dev-only tool.
const APP_DATA_DIR = path.join(os.homedir(), "Library", "Application Support", "app.lifer.desktop");
const DATA_DIR = path.join(APP_DATA_DIR, "app-data", "postgres-data");
const LOG_FILE = path.join(APP_DATA_DIR, "app-data", "headless-postgres.log");
const PG_BIN_ROOT = path.join(os.homedir(), ".theseus", "postgresql");
// Per-install password the app writes on first launch (embedded_db.rs PASSWORD_FILE).
const PASSWORD_FILE = path.join(APP_DATA_DIR, "app-data", "postgres-password");
// What every install used before per-install passwords; the app migrates off it on launch.
const LEGACY_DB_PASSWORD = "lifer-embedded";

function dbPassword() {
  if (existsSync(PASSWORD_FILE)) {
    const value = readFileSync(PASSWORD_FILE, "utf8").trim();
    if (value) return value;
  }
  console.error(`[headless-postgres] ${PASSWORD_FILE} not found, using the legacy password. Launch the app once to migrate.`);
  return LEGACY_DB_PASSWORD;
}

function connectionUrl() {
  return `postgres://${DB_USER}:${encodeURIComponent(dbPassword())}@${HOST}:${PORT}/${DB_NAME}`;
}

// theseus caches postgres under a version folder (e.g. ~/.theseus/postgresql/18.6.0/), so
// resolve it rather than hardcoding a version.
function findPgCtl() {
  if (!existsSync(PG_BIN_ROOT)) {
    throw new Error(`No theseus-managed Postgres found under ${PG_BIN_ROOT}. Launch the app at least once first.`);
  }
  const versions = spawnSync("ls", [PG_BIN_ROOT]).stdout.toString().trim().split("\n").filter(Boolean).sort();
  const latest = versions[versions.length - 1];
  const pgCtl = path.join(PG_BIN_ROOT, latest, "bin", "pg_ctl");
  if (!existsSync(pgCtl)) {
    throw new Error(`pg_ctl not found at ${pgCtl}`);
  }
  return pgCtl;
}

function isRunning() {
  const pgCtl = findPgCtl();
  const res = spawnSync(pgCtl, ["status", "-D", DATA_DIR]);
  return res.status === 0;
}

function start() {
  if (!existsSync(DATA_DIR)) {
    throw new Error(`No data directory at ${DATA_DIR}. The app needs to have run at least once to initialize it.`);
  }
  if (isRunning()) {
    console.log(`[headless-postgres] already running`);
    console.log(connectionUrl());
    return;
  }
  // Clear a stale postmaster.pid, but only after `status` confirmed nothing is running.
  const pidFile = path.join(DATA_DIR, "postmaster.pid");
  if (existsSync(pidFile)) rmSync(pidFile);

  const pgCtl = findPgCtl();
  mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  console.log(`[headless-postgres] starting on port ${PORT}...`);
  const res = spawnSync(pgCtl, [
    "start",
    "-D", DATA_DIR,
    "-l", LOG_FILE,
    "-w",
    "-o", `-p ${PORT} -h ${HOST}`,
  ]);
  if (res.status !== 0) {
    console.error(res.stdout?.toString());
    console.error(res.stderr?.toString());
    throw new Error(`pg_ctl start failed (exit ${res.status}), see ${LOG_FILE}`);
  }
  console.log(`[headless-postgres] started`);
  console.log(connectionUrl());
}

function stop() {
  if (!isRunning()) {
    console.log(`[headless-postgres] not running`);
    return;
  }
  const pgCtl = findPgCtl();
  console.log(`[headless-postgres] stopping...`);
  const res = spawnSync(pgCtl, ["stop", "-D", DATA_DIR, "-m", "fast", "-w"]);
  if (res.status !== 0) {
    console.error(res.stdout?.toString());
    console.error(res.stderr?.toString());
    throw new Error(`pg_ctl stop failed (exit ${res.status})`);
  }
  console.log(`[headless-postgres] stopped`);
}

function status() {
  console.log(isRunning() ? "running" : "stopped");
}

const cmd = process.argv[2];
if (cmd === "start") start();
else if (cmd === "stop") stop();
else if (cmd === "status") status();
else if (cmd === "url") console.log(connectionUrl());
else {
  console.error("Usage: node headless-postgres.js start|stop|status|url");
  process.exit(1);
}
