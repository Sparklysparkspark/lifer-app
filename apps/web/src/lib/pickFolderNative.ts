import { loadServerInfo } from "../hooks/useDeploymentMode";

// The native folder dialog, only when the desktop shell talks to its own local API. Resolves
// `undefined` when no usable dialog exists (fall back to <FolderBrowser>); null means cancelled.
export async function pickFolderNative(): Promise<string | null | undefined> {
  if (!window.liferSetup) return undefined;
  const mode = await loadServerInfo()
    .then((info) => info.deploymentMode)
    .catch(() => null);
  if (mode !== "desktop") return undefined;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ directory: true });
    return typeof path === "string" ? path : null;
  } catch (err) {
    console.error("Native folder dialog failed", err);
    return undefined;
  }
}
