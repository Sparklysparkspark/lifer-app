// A signed, long-lived cookie naming the accounts and password-protected shares this browser has
// opened with the right password. A known device skips the looser cross-IP caps (per email at
// login, per link at share unlock), so a stranger's failed guesses from many addresses can't lock
// the owner or a returning visitor out. The per-IP limits still apply to it.
import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { addUnlock, cookieKey, hasUnlock } from "../shares/unlockCookie.js";
import { cookieSecureFor } from "./session.js";

export const KNOWN_DEVICE_COOKIE = "lifer_known_device";
const KNOWN_DEVICE_TTL_MS = 365 * 24 * 60 * 60 * 1000;

const key = (): Buffer => cookieKey("known-device");

/** Hashed so the cookie doesn't carry the address in readable form. */
export function loginDeviceId(normalizedEmail: string): string {
  return `login:${createHash("sha256").update(normalizedEmail).digest("base64url").slice(0, 22)}`;
}

export function shareDeviceId(shareId: string): string {
  return `share:${shareId}`;
}

export function isKnownDevice(request: FastifyRequest, id: string): boolean {
  const cookie = request.cookies[KNOWN_DEVICE_COOKIE];
  return !!cookie && hasUnlock(cookie, id, Date.now(), key());
}

export function rememberDevice(request: FastifyRequest, reply: FastifyReply, id: string): void {
  const { value, expiresAt } = addUnlock(
    request.cookies[KNOWN_DEVICE_COOKIE],
    id,
    Date.now(),
    key(),
    KNOWN_DEVICE_TTL_MS,
  );
  reply.setCookie(KNOWN_DEVICE_COOKIE, value, {
    httpOnly: true,
    secure: cookieSecureFor(request),
    sameSite: "lax",
    path: "/",
    expires: new Date(expiresAt),
  });
}
