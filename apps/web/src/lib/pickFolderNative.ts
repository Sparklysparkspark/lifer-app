import { loadServerInfo } from "../hooks/useDeploymentMode";
import { tauriInvoke } from "./tauri";

export interface PickedFile {
  path: string;
  mtimeMs: number;
}

/** The desktop shell's own Choose files dialog for imports (pick_import_files). The shell tells the
 *  local API what was picked, so these files may be read and, with Move on, sent to the Trash.
 *  `undefined` when there's no such dialog (fall back to the browser's picker); null if cancelled. */
export async function pickImportFilesNative(): Promise<PickedFile[] | null | undefined> {
  const invoke = tauriInvoke();
  if (!invoke) return undefined;
  try {
    return (await invoke("pick_import_files")) as PickedFile[] | null;
  } catch {
    return undefined;
  }
}

// The native folder dialog, only when the desktop shell talks to its own local API. Resolves
// `undefined` when no usable dialog exists (fall back to <FolderBrowser>); null means cancelled.
export async function pickFolderNative(defaultPath?: string): Promise<string | null | undefined> {
  if (!window.liferSetup) return undefined;
  const mode = await loadServerInfo()
    .then((info) => info.deploymentMode)
    .catch(() => null);
  if (mode !== "desktop") return undefined;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ directory: true, defaultPath });
    return typeof path === "string" ? path : null;
  } catch (err) {
    console.error("Native folder dialog failed", err);
    return undefined;
  }
}
