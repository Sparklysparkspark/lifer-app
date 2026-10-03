// One signed cookie holding every share this browser has unlocked, so unlocking a second share
// doesn't lock the first. Holds share ids (never tokens) with a per-entry expiry. The key is
// per process, so a restart just asks visitors for the password again.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const UNLOCK_TTL_MS = 24 * 60 * 60 * 1000;
// Keeps the cookie well under browser size limits; the oldest unlocks drop off first.
const MAX_ENTRIES = 25;

type Entry = [shareId: string, expiresAt: number];

const processKey = randomBytes(32);

function sign(payload: string, key: Buffer): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function decodeUnlocks(cookie: string | undefined, now = Date.now(), key = processKey): Entry[] {
  if (!cookie) return [];
  const dot = cookie.lastIndexOf(".");
  if (dot <= 0) return [];
  const payload = cookie.slice(0, dot);
  const given = Buffer.from(cookie.slice(dot + 1));
  const expected = Buffer.from(sign(payload, key));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return [];
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is Entry => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "number" && e[1] > now,
    );
  } catch {
    return [];
  }
}

export function encodeUnlocks(entries: Entry[], key = processKey): string {
  const payload = Buffer.from(JSON.stringify(entries)).toString("base64url");
  return `${payload}.${sign(payload, key)}`;
}

export function hasUnlock(cookie: string | undefined, shareId: string, now = Date.now(), key = processKey): boolean {
  return decodeUnlocks(cookie, now, key).some(([id]) => id === shareId);
}

/** Returns the new cookie value and when the whole cookie should expire. */
export function addUnlock(
  cookie: string | undefined,
  shareId: string,
  now = Date.now(),
  key = processKey,
): { value: string; expiresAt: number } {
  const kept = decodeUnlocks(cookie, now, key).filter(([id]) => id !== shareId);
  const entries: Entry[] = [...kept, [shareId, now + UNLOCK_TTL_MS] as Entry].slice(-MAX_ENTRIES);
  const expiresAt = Math.max(...entries.map(([, exp]) => exp));
  return { value: encodeUnlocks(entries, key), expiresAt };
}
