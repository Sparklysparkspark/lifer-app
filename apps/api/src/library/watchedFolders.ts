// Watched folders: new photos in folders the user chose are imported in place by the same scan a
// folder import runs. Polling only, so network drives and Linux inotify limits behave the same.
import { stat } from "node:fs/promises";
import { isDirectory } from "@lifer/core/lib/allowedPaths.js";
import { log } from "@lifer/core/lib/log.js";
import { pool } from "@lifer/core/db.js";
import { getInstallSetting, setInstallSetting } from "../lib/installSettings.js";
import { runningJobNames } from "../lib/job.js";
import { walkFiles } from "./walkFiles.js";
import { startWatchedFolderScan } from "./routes.js";

export interface WatchedFolder {
  path: string;
  enabled: boolean;
  userId: string;
  /** What the folder looked like when its last scan started; null before the first. */
  signature: string | null;
}

const SETTING_KEY = "watched_folders";
const POLL_MS = 30_000;
// A library move or reorganize rewrites paths under a scan's feet, so scans wait for these.
const PAUSE_JOBS = ["storage-move", "reorganize-originals", "refile-originals", "pack-removal"];

export async function listWatchedFolders(): Promise<WatchedFolder[]> {
  return (await getInstallSetting<WatchedFolder[]>(pool, SETTING_KEY)) ?? [];
}

export function saveWatchedFolders(folders: WatchedFolder[]): Promise<void> {
  return setInstallSetting(pool, SETTING_KEY, folders);
}

/** File count, total size and newest change: differs whenever something is added, grown or edited.
 *  Null when the folder isn't reachable (an unplugged drive). */
export async function folderSignature(dir: string): Promise<string | null> {
  if (!(await isDirectory(dir))) return null;
  let count = 0;
  let bytes = 0;
  let newest = 0;
  for await (const { absolutePath } of walkFiles(dir)) {
    const st = await stat(absolutePath).catch(() => null);
    if (!st) continue;
    count++;
    bytes += st.size;
    newest = Math.max(newest, st.mtimeMs);
  }
  return `${count}:${bytes}:${Math.floor(newest)}`;
}

export type PollOutcome = "offline" | "unchanged" | "waiting" | "started";

/** One look at one folder. A change must show twice in a row (it has stopped growing) before a
 *  scan starts, so a half-copied file is never imported early. `seen` holds the previous look. */
export async function pollWatchedFolder(
  folder: WatchedFolder,
  seen: Map<string, string>,
  start: (folder: WatchedFolder) => boolean,
  persist: (folder: WatchedFolder, signature: string) => Promise<void>,
): Promise<PollOutcome> {
  const signature = await folderSignature(folder.path);
  if (signature === null) return "offline";
  if (signature === folder.signature) {
    seen.delete(folder.path);
    return "unchanged";
  }
  if (seen.get(folder.path) !== signature) {
    seen.set(folder.path, signature);
    return "waiting";
  }
  if (!start(folder)) return "waiting";
  seen.delete(folder.path);
  await persist(folder, signature);
  return "started";
}

export function startWatchedFolders(): void {
  const seen = new Map<string, string>();
  let polling = false;
  const tick = async () => {
    if (polling || PAUSE_JOBS.some((name) => runningJobNames.has(name))) return;
    polling = true;
    try {
      for (const folder of (await listWatchedFolders()).filter((f) => f.enabled)) {
        const outcome = await pollWatchedFolder(
          folder,
          seen,
          (f) => startWatchedFolderScan(f.userId, f.path),
          async (f, signature) => {
            const all = await listWatchedFolders();
            await saveWatchedFolders(all.map((x) => (x.path === f.path ? { ...x, signature } : x)));
          },
        );
        if (outcome === "started") break; // one scan at a time; the rest wait for the next look
      }
    } catch (err) {
      log.warn(`[watched-folders] ${(err as Error).message}`);
    } finally {
      polling = false;
    }
  };
  setInterval(() => void tick(), POLL_MS).unref();
}
