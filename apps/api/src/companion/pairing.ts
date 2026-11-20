// Pairing codes for phones: 6 digits, one live code per user, single use, five minutes, held in
// memory only (a restart simply makes the user show a new code).
//
// Guessing: every wrong code and every key-exchange run (each is one guess, see companionPake.ts)
// spends from one budget of MAX_GUESSES shared by all clients; spending it all burns every live code.
// So an attacker gets at most MAX_GUESSES tries per code shown, a 5 in a million chance on a desktop
// (one live code), however many addresses it uses. The per-address limits in routes.ts and the
// desktop listener only slow it further. The budget refills once no code is live.
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { PAIRING_CODE_LENGTH, pakeAnswer, type PakeHello, type PakeReply } from "@lifer/shared";

export const COMPANION_CODE_TTL_MS = 5 * 60_000;
export const MAX_GUESSES = 5;
const SESSION_TTL_MS = 60_000;
// Far above any real number of users; a flood of mints can't grow the map without bound.
const MAX_LIVE_CODES = 100;

interface Entry {
  userId: string;
  expiresAt: number;
  /** The desktop listener's certificate the code was shown with; typed pairing binds to it. */
  certSha256?: string;
}
interface Session {
  code: string;
  userId: string;
  expectTagA: Uint8Array;
  expiresAt: number;
}

// Plain codes: a hash of a 6-digit code would reverse in a moment anyway.
const codes = new Map<string, Entry>();
const sessions = new Map<string, Session>();
let guesses = 0;

function burnAll(): void {
  codes.clear();
  sessions.clear();
  guesses = 0;
}

function sweep(now: number): void {
  for (const [code, v] of codes) if (v.expiresAt <= now) codes.delete(code);
  for (const [id, s] of sessions) if (s.expiresAt <= now || !codes.has(s.code)) sessions.delete(id);
  if (codes.size === 0) burnAll();
}

/** False, with every code burned, once MAX_GUESSES guesses have been tried. */
function budgetLeft(): boolean {
  if (guesses < MAX_GUESSES) return true;
  burnAll();
  return false;
}

function consume(code: string): void {
  codes.delete(code);
  for (const [id, s] of sessions) if (s.code === code) sessions.delete(id);
  if (codes.size === 0) burnAll();
}

/** A fresh code for the user; any earlier one of theirs stops working. */
export function mintPairingCode(
  userId: string,
  certSha256?: string,
  now = Date.now(),
): { code: string; expiresAt: Date } {
  sweep(now);
  for (const [code, v] of codes) if (v.userId === userId) consume(code);
  while (codes.size >= MAX_LIVE_CODES) consume(codes.keys().next().value!);
  let code: string;
  // Unique among live codes, so a code names one user.
  do code = String(randomInt(10 ** PAIRING_CODE_LENGTH)).padStart(PAIRING_CODE_LENGTH, "0");
  while (codes.has(code));
  const expiresAt = now + COMPANION_CODE_TTL_MS;
  codes.set(code, { userId, expiresAt, ...(certSha256 ? { certSha256 } : {}) });
  return { code, expiresAt: new Date(expiresAt) };
}

/** The user a code belongs to, consuming it. Null for an unknown, used or expired code. */
export function takePairingCode(code: string, now = Date.now()): string | null {
  sweep(now);
  if (!budgetLeft()) return null;
  const entry = codes.get(code);
  if (entry) {
    consume(code);
    return entry.userId;
  }
  if (codes.size > 0) guesses++;
  budgetLeft();
  return null;
}

/**
 * Typed pairing, hub side of the key exchange. Only a code shown with a certificate (a desktop)
 * takes part, and on a desktop there is at most one. Null when there is no such code or the hello
 * is malformed; otherwise the reply and a session id for the finish step.
 */
export function startPakeSession(
  hello: PakeHello,
  now = Date.now(),
): { session: string; reply: PakeReply } | "no_code" | "bad_hello" {
  sweep(now);
  const live = [...codes].filter(([, e]) => e.certSha256);
  if (live.length !== 1) return "no_code";
  const [code, entry] = live[0];
  if (!budgetLeft()) return "no_code";
  guesses++;
  const answer = pakeAnswer(code, entry.certSha256!, hello);
  if (!answer) return "bad_hello";
  const session = randomBytes(16).toString("hex");
  sessions.set(session, { code, userId: entry.userId, expectTagA: answer.expectTagA, expiresAt: now + SESSION_TTL_MS });
  return { session, reply: answer.reply };
}

/** The user, consuming the code, when the phone's tag proves it held the code. One try per session. */
export function finishPakeSession(session: string, tagA: string, now = Date.now()): string | null {
  sweep(now);
  const s = sessions.get(session);
  if (!s) return null;
  sessions.delete(session);
  const given = Buffer.from(tagA, "hex");
  if (given.length !== s.expectTagA.length || !timingSafeEqual(given, s.expectTagA)) return null;
  if (!codes.has(s.code)) return null;
  consume(s.code);
  return s.userId;
}

/** For tests. */
export function clearPairingCodes(): void {
  burnAll();
}
