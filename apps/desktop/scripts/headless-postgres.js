// Runs the SAME embedded Postgres binary/data directory embedded_db.rs uses, but as an
// independent long-lived process instead of one owned by the app's own lifecycle. Postgres
// locks its data directory to a single process, so this is deliberately "one or the other,
// never both" against those exact files — the point isn't to run alongside the app's own
// embedded instance, it's to replace it for a dev session: start this once, then launch (or
// rebuild+relaunch) the app with DATABASE_URL pointing here. api.rs's own start_api() already
// special-cases an explicit DATABASE_URL env var ("development against a real Postgres) as
// always respected as-is" — skipping embedded_db.rs's start_embedded_postgres() entirely — so
// no Rust changes were needed to make this work; this script only had to speak the same
// data-dir/port/credentials contract embedded_db.rs already established.
//
// Background jobs that would otherwise die the moment the app quits (province computation,
// species enrichment, etc.) can connect to the same DATABASE_URL this script prints, and now
// keep running across as many app rebuild/relaunch cycles as needed.
//
// Usage: node headless-postgres.js start|stop|status|url
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const DB_NAME = "lifer";
const DB_USER = "postgres";
// Must match embedded_db.rs's own DB_PASSWORD exactly — the data directory's cluster was
// initialized with this password by the app itself; a different one here would just fail auth
// against files that already exist, not "set" a new password.
const DB_PASSWORD = "lifer-embedded";
const PORT = 55432;
const HOST = "127.0.0.1";

// Same path Tauri's app_data_dir() resolves to for this app's bundle identifier on macOS. Only
// macOS is supported here since that's the only platform this dev machine runs — a Linux/Windows
// equivalent would need their own XDG/AppData path, not attempted since nothing here ships to
// end users (see this file's own module comment: this is a dev-only tool, never bundled).
const APP_DATA_DIR = path.join(os.homedir(), "Library", "Application Support", "app.lifer.desktop");
const DATA_DIR = path.join(APP_DATA_DIR, "app-data", "postgres-data");
const LOG_FILE = path.join(APP_DATA_DIR, "app-data", "headless-postgres.log");
const PG_BIN_ROOT = path.join(os.homedir(), ".theseus", "postgresql");

function connectionUrl() {
  return `postgres://${DB_USER}:${DB_PASSWORD}@${HOST}:${PORT}/${DB_NAME}`;
}

// theseus caches postgres under a version-numbered folder (e.g. ~/.theseus/postgresql/18.6.0/)
// — resolved dynamically rather than hardcoded so a future app rebuild that bumps the pinned
// postgresql_embedded version doesn't silently point this script at a stale/missing binary.
function findPgCtl() {
  if (!existsSync(PG_BIN_ROOT)) {
    throw new Error(`No theseus-managed Postgres found under ${PG_BIN_ROOT} — launch the app at least once first.`);
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
    throw new Error(`No data directory at ${DATA_DIR} — the app needs to have run at least once to initialize it.`);
  }
  if (isRunning()) {
    console.log(`[headless-postgres] already running`);
    console.log(connectionUrl());
    return;
  }
  // A stale postmaster.pid from an ungraceful shutdown (same failure mode embedded_db.rs's own
  // clear_stale_lock_if_dead guards against) makes pg_ctl refuse to start even though nothing
  // actually holds the directory — only clear it once `status` above has already confirmed
  // nothing real is running.
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
    throw new Error(`pg_ctl start failed (exit ${res.status}) — see ${LOG_FILE}`);
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
