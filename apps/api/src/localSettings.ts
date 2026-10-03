// Desktop mode's storage-folder choice, kept outside DATA_DIR so the setting never lives inside
// the folder it names. Docker sets DATA_DIR through the environment instead.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "./lib/log.js";

const CONFIG_DIR = path.join(os.homedir(), ".lifer");
const CONFIG_PATH = path.join(CONFIG_DIR, "settings.json");

export interface StorageMigration {
  from: string;
  to: string;
  /** The new folder is a complete copy; only deleting the old one may be unfinished. */
  copied?: boolean;
}

interface LocalSettings {
  dataDir?: string;
  // Set before a storage move touches a file and cleared once the move and relink succeed, so
  // startup recovery can finish or roll back an interrupted move.
  migration?: StorageMigration;
}

// Windows can briefly lock the file (AV, indexer): EPERM/EBUSY/EACCES are retried a few times.
function withRetry<T>(fn: () => T, attempts = 5): T {
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= attempts - 1 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (i + 1));
    }
  }
}

// Only ENOENT means "no settings yet": returning {} on other errors would be persisted and wipe the
// storage location. Unparseable JSON is set aside and defaults are used, so startup never fails.
export function readLocalSettingsAt(configPath: string): LocalSettings {
  let text: string;
  try {
    text = withRetry(() => readFileSync(configPath, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as LocalSettings;
    throw new Error("settings.json is not a JSON object");
  } catch (err) {
    const corruptPath = `${configPath}.corrupt-${Date.now()}`;
    try {
      withRetry(() => renameSync(configPath, corruptPath));
    } catch (renameErr) {
      log.error(`[settings] Couldn't set aside the unreadable ${configPath}: ${(renameErr as Error).message}`);
    }
    log.error(
      `[settings] ${configPath} was unreadable (${(err as Error).message}). It was saved as ${corruptPath} and Lifer is using default settings. If your library was in a custom folder, pick it again in Settings.`,
    );
    return {};
  }
}

export function readLocalSettings(): LocalSettings {
  return readLocalSettingsAt(CONFIG_PATH);
}

// Temp file then rename (atomic on POSIX), so a crash leaves either the old file or the new one.
export function writeLocalSettings(patch: LocalSettings): void {
  const current = readLocalSettings();
  mkdirSync(CONFIG_DIR, { recursive: true });
  const tmpPath = `${CONFIG_PATH}.tmp`;
  writeFileSync(tmpPath, JSON.stringify({ ...current, ...patch }, null, 2));
  withRetry(() => renameSync(tmpPath, CONFIG_PATH));
}
