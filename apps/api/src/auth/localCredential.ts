// The desktop app's local credential. Desktop mode (SINGLE_USER_MODE) has no sign-in, so a request
// counts as the local user only when it proves it came from the app itself:
//   - the per-launch secret LIFER_LAUNCH_TOKEN, which only the desktop shell and this process
//     know, in the x-lifer-launch-token header; or
//   - the lifer_desktop cookie. The app's window gets it from POST /api/auth/desktop-session by
//     presenting the secret once, which the shell hands only to its own window (lib.rs,
//     local_api_credential). It's HttpOnly, so page scripts can't read it, and SameSite=Strict on
//     the 127.0.0.1:4310 origin, so no other site's page makes the browser send it.
// A cookie rather than a header on every request because <img>, <video> and download links can't
// add headers, and most of the app's photos load that way.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyReply } from "fastify";

export const LOCAL_CREDENTIAL_HEADER = "x-lifer-launch-token";
export const LOCAL_SESSION_COOKIE = "lifer_desktop";

export interface LocalCredentialConfig {
  /** LIFER_LAUNCH_TOKEN, or null when it isn't set. */
  token: string | null;
  /** LIFER_ALLOW_UNTOKENED_DESKTOP=1: development without the desktop shell, no credential. */
  allowUntokened: boolean;
}

export function localCredentialConfig(env: NodeJS.ProcessEnv = process.env): LocalCredentialConfig {
  return { token: env.LIFER_LAUNCH_TOKEN || null, allowUntokened: env.LIFER_ALLOW_UNTOKENED_DESKTOP === "1" };
}

// The cookie holds a value derived from the secret rather than the secret itself, so the cookie
// can't be replayed as the header. Same lifetime: both change on every launch.
export function localSessionCookieValue(token: string): string {
  return createHmac("sha256", token).update("lifer-desktop-session-v1").digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Whether the request carries the launch secret itself (the header). */
export function hasLaunchTokenHeader(
  request: { headers: Record<string, string | string[] | undefined> },
  config: LocalCredentialConfig = localCredentialConfig(),
): boolean {
  const header = request.headers[LOCAL_CREDENTIAL_HEADER];
  return !!config.token && typeof header === "string" && safeEqual(header, config.token);
}

/** Whether a desktop-mode request comes from the desktop app (header or cookie). Without a launch
 *  token, only an explicit LIFER_ALLOW_UNTOKENED_DESKTOP=1 lets requests through. */
export function hasLocalCredential(
  request: { headers: Record<string, string | string[] | undefined>; cookies?: Record<string, string | undefined> },
  config: LocalCredentialConfig = localCredentialConfig(),
): boolean {
  if (!config.token) return config.allowUntokened;
  if (hasLaunchTokenHeader(request, config)) return true;
  const cookie = request.cookies?.[LOCAL_SESSION_COOKIE];
  return typeof cookie === "string" && safeEqual(cookie, localSessionCookieValue(config.token));
}

/** Sets the window's session cookie. No Expires: it lives as long as the app's web view does, and
 *  WebKit and WebView2 keep such cookies in memory rather than writing them to disk. */
export function setLocalSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(LOCAL_SESSION_COOKIE, localSessionCookieValue(token), {
    httpOnly: true,
    sameSite: "strict",
    // The desktop API is plain http on loopback, where a Secure cookie would be dropped.
    secure: false,
    path: "/",
  });
}
