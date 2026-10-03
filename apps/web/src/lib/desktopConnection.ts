import { errorMessage } from "./errorMessage";
import { tauriInvoke } from "./tauri";
import type { DesktopBridgeChoice } from "../types/liferSetup";

/** Saves the desktop connection config. Resolves to an error message, or null when it went through. */
export async function chooseConnection(config: DesktopBridgeChoice): Promise<string | null> {
  try {
    const result = await window.liferSetup!.choose(config);
    return result.error ?? null;
  } catch (err) {
    return errorMessage(err, "Couldn't save the connection");
  }
}

/** Opens the library on this computer (the folder it last used, no folder prompt) in the desktop
 *  app. Resolves to an error message, or null when it went through. */
export async function openLocalLibrary(): Promise<string | null> {
  const invoke = tauriInvoke();
  if (!invoke) return "Only the desktop app has a library on this computer";
  let result: { error?: string | null } | null;
  try {
    result = (await invoke("use_local_library")) as { error?: string | null } | null;
  } catch {
    // A desktop app from before the command: the connection picker, which asks for a folder.
    return chooseConnection({ mode: "local" });
  }
  return result?.error ?? null;
}
