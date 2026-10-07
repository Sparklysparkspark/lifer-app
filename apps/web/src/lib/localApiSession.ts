// The desktop app's local library signs in with a per-launch secret instead of a password. The
// desktop shell hands the secret only to its own window on the local API's origin
// (local_api_credential in lib.rs answers null anywhere else), and the API trades it for an
// HttpOnly cookie that then signs in every request, images included (see the API's
// auth/localCredential.ts). The secret itself is dropped right after.
import type { TauriInvoke } from "./tauri";

export const LOCAL_CREDENTIAL_HEADER = "x-lifer-launch-token";

/** Signs this window in to the desktop app's local API. A no-op in a browser, on a server, or in an
 *  older shell without the command; the page then shows whatever /auth/me says. */
export async function startLocalApiSession(invoke: TauriInvoke | null, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!invoke) return;
  let token: unknown;
  try {
    token = await invoke("local_api_credential");
  } catch {
    return;
  }
  if (typeof token !== "string" || !token) return;
  await fetchImpl("/api/auth/desktop-session", {
    method: "POST",
    credentials: "same-origin",
    headers: { "x-lifer-client": "1", [LOCAL_CREDENTIAL_HEADER]: token },
  }).catch(() => {});
}
