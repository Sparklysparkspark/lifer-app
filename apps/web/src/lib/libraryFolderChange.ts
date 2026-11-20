// One way to switch the library folder, shared by Settings > Storage and the missing-folder banner:
// save it, tell the desktop shell, then restart Lifer on it. Pack downloads resume after the restart.
import { api } from "../api/client";
import { getUploadQueueState } from "./uploadQueue";
import { isTauri } from "./tauri";
import { ignore } from "./ignore";
import { userMessage } from "./userMessage";

const RESUME_KEY = "lifer-resume-downloads";

export type LibraryFolderChange =
  // The app is relaunching; nothing more to show.
  | { kind: "restarting" }
  // Not the desktop app (or its relaunch failed): the person restarts Lifer themselves.
  | { kind: "restartManually"; filesMoved: boolean }
  // Saved, but the desktop shell couldn't record it, so a restart would open the old folder.
  | { kind: "launchConfigFailed"; error: string; dataDir: string }
  // Imports still sending files would be cut off by the restart.
  | { kind: "importsRunning" };

/** True while files from this window are still being imported. */
// shortcut: only the shared upload queue is checked, not the import page's own sends; add them if that page grows long runs.
export function importsRunning(): boolean {
  return getUploadQueueState().jobs.some((j) => !j.done);
}

/** Saves `dataDir` as the library folder (moving files when the old folder has them) and restarts
 *  Lifer on it. API failures throw, for the caller to show. */
export async function changeLibraryFolder(dataDir: string): Promise<LibraryFolderChange> {
  if (importsRunning()) return { kind: "importsRunning" };
  const res = await api.put("/settings/storage", { dataDir });
  const saved = res.dataDir ?? dataDir;
  // The desktop shell starts the API from its own config, so it has to hear about the move or the
  // next launch opens the old folder.
  try {
    await window.liferSetup?.setLocalDataDir?.(saved);
  } catch (err) {
    return { kind: "launchConfigFailed", error: userMessage(err), dataDir: saved };
  }
  return (await restartLifer()) ? { kind: "restarting" } : { kind: "restartManually", filesMoved: res.filesMoved === true };
}

/** Relaunches the desktop app, noting running pack downloads so they pick up again afterwards.
 *  False outside the desktop app or when the relaunch fails. */
export async function restartLifer(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const status = await api.get("/offline-packs/download/status");
    if (status.running && status.packIds.length > 0) writeResume(status.packIds);
  } catch (err) {
    ignore("Couldn't note running downloads before restarting")(err);
  }
  try {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
    return true;
  } catch (err) {
    console.error("Relaunch failed", err);
    return false;
  }
}

/** Starts again the pack downloads a restart interrupted. Their files resume where they stopped. */
export async function resumeDownloadsAfterRestart(): Promise<void> {
  let packIds: string[];
  try {
    packIds = JSON.parse(localStorage.getItem(RESUME_KEY) ?? "[]") as string[];
    localStorage.removeItem(RESUME_KEY);
  } catch {
    return;
  }
  if (!Array.isArray(packIds) || packIds.length === 0) return;
  await api.post("/offline-packs/download", { packIds }).catch(ignore("Couldn't resume downloads after restart"));
}

function writeResume(packIds: string[]) {
  try {
    localStorage.setItem(RESUME_KEY, JSON.stringify(packIds));
  } catch {
    // Storage blocked: the downloads stay where they stopped until started again.
  }
}
