// The desktop app's own key on a server. After the window signs in to a server, the app's local
// API still needs a credential of its own to talk to that server while the window isn't signed
// in there (packs, pushes, the mirror). The server's page mints one through
// POST /auth/desktop-link and hands it to the desktop shell, which keeps it keyed by the server's
// instance id (apps/desktop/src-tauri/src/server_link.rs). Once per server: the shell says
// whether it still needs one. Signing out revokes the key and drops it.
import { api, apiPath } from "../api/client";
import { platform } from "./platform";
import type { TauriInvoke } from "./tauri";

// Names the key on the server's Linked devices list; not shown to anyone else.
const DEVICE_NAMES = { mac: "Desktop app (Mac)", windows: "Desktop app (Windows)", other: "Desktop app" } as const;

export async function ensureDesktopLink(invoke: TauriInvoke | null): Promise<void> {
  if (!invoke) return;
  // An older shell without the command, or a page the shell doesn't trust: nothing to do.
  const needed = await invoke("server_link_needed").catch(() => false);
  if (needed !== true) return;
  const key = await api.post("/auth/desktop-link", { name: DEVICE_NAMES[platform] });
  await invoke("store_server_link", { keyId: key.id, token: key.token, linkSecret: key.linkSecret });
}

/** Drops the shell's key for this server and revokes it on the server. Best effort. */
export async function forgetDesktopLink(invoke: TauriInvoke | null): Promise<void> {
  if (!invoke) return;
  const keyId = await invoke("forget_server_link").catch(() => null);
  if (typeof keyId !== "string" || !keyId) return;
  await api.delete(apiPath("/api-keys/{id}", { id: keyId })).catch(() => undefined);
}
