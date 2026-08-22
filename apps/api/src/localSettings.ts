// A small persisted config file for desktop mode's storage-folder picker, deliberately
// stored OUTSIDE DATA_DIR so choosing a new DATA_DIR is never chicken-and-egg with where the
// setting that says so lives. Desktop-only in practice: the Docker deployment already has a
// documented, standard way to do this (LIFER_STORAGE_DIR in docker-compose.yml — see
// .env.example), so this file only matters when nothing set DATA_DIR via the environment
// already.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_DIR = path.join(os.homedir(), ".lifer");
const CONFIG_PATH = path.join(CONFIG_DIR, "settings.json");

export interface StorageMigration {
  from: string;
  to: string;
}

interface LocalSettings {
  dataDir?: string;
  // Recorded BEFORE a storage-location move touches a single file, and only cleared once the
  // move + database relink have both fully succeeded. If the process dies anywhere in
  // between (power loss, laptop lid closed), this marker survives on disk and
  // recoverInterruptedStorageMigration() (see settings/routes.ts) uses it on next startup to
  // finish or safely roll back the interrupted move — instead of leaving `dataDir` pointing
  // somewhere that may not match reality anymore.
  migration?: StorageMigration;
}

export function readLocalSettings(): LocalSettings {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

// Writes via a temp file + rename rather than a direct writeFileSync — a plain write can be
// left truncated/half-written by a crash partway through, corrupting the one file everything
// above (including migration recovery itself) depends on being readable. rename(2) is atomic
// on POSIX filesystems: a crash here either leaves the OLD settings.json fully intact, or the
// new one fully written, never something in between.
export function writeLocalSettings(patch: LocalSettings): void {
  const current = readLocalSettings();
  mkdirSync(CONFIG_DIR, { recursive: true });
  const tmpPath = `${CONFIG_PATH}.tmp`;
  writeFileSync(tmpPath, JSON.stringify({ ...current, ...patch }, null, 2));
  renameSync(tmpPath, CONFIG_PATH);
}
