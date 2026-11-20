// Pairing state for companion apps (docs/plans/plugin-host-and-integration-api.md, section 5):
// launch tickets the desktop shell hands over, requests waiting for the user's answer, and a
// server's pairing codes. All of it lives in memory with expiry; only the key it ends in is stored,
// as an ordinary api_keys row named after the app and carrying its plugin_id.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { pool } from "@lifer/core/db.js";
import { generateApiKey, hashApiKey } from "../auth/apiKeys.js";

export const PAIR_REQUEST_TTL_MS = 5 * 60_000;
export const PAIR_CODE_TTL_MS = 10 * 60_000;
// A plugin may call pair right after its READY line, a moment before the shell has passed its
// ticket over.
const TICKET_WAIT_MS = 5_000;
// An approved request's key waits this long for the app to collect it.
const COLLECT_MS = 60_000;
// Wrong codes from every address together; past this, live codes are dropped so many addresses
// can't share a guessing budget. The user makes a new code.
const MAX_CODE_FAILURES = 10;

const sha256 = (s: string) => createHash("sha256").update(s).digest();

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- Launch tickets (desktop) ----

export interface HostTicket {
  /** The manifest's name and scopes, so consent shows what the user installed, not what the caller claims. */
  name: string;
  scopes: string[];
}

const tickets = new Map<string, HostTicket & { hash: Buffer }>();

/** The shell sends the SHA-256 of each launch's ticket, so the ticket itself never leaves it. The
 *  newest launch (or the instance it handed off to) replaces any earlier one. */
export function setHostTicket(pluginId: string, ticketHashHex: string, ticket: HostTicket): void {
  tickets.set(pluginId, { ...ticket, hash: Buffer.from(ticketHashHex, "hex") });
}

/** Drops the ticket only if it's still this one, so a late clear can't remove a newer launch's. */
export function clearHostTicket(pluginId: string, ticketHashHex: string): void {
  const t = tickets.get(pluginId);
  if (t && sameBytes(t.hash, Buffer.from(ticketHashHex, "hex"))) tickets.delete(pluginId);
}

/** Takes the plugin's ticket if `ticket` is it, so it can't be used twice at once. `restore` puts it
 *  back when a pairing ends without an answer. */
export async function takeHostTicket(
  pluginId: string,
  ticket: string,
): Promise<{ entry: HostTicket; restore: () => void } | null> {
  const presented = sha256(ticket);
  const deadline = Date.now() + TICKET_WAIT_MS;
  for (;;) {
    const t = tickets.get(pluginId);
    if (t && sameBytes(t.hash, presented)) {
      tickets.delete(pluginId);
      return {
        entry: { name: t.name, scopes: t.scopes },
        restore: () => {
          if (!tickets.has(pluginId)) tickets.set(pluginId, t);
        },
      };
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ---- Requests waiting for the user (desktop) ----

export type PairResult = { status: "approved"; key: string; scopes: string[] } | { status: "denied" | "expired" };

export interface PairRequest {
  id: string;
  userId: string;
  pluginId: string;
  name: string;
  scopes: string[];
  /** The 6-digit code an app started on its own shows, for the user to compare. */
  code: string | null;
  /** Set for a paired app asking to open inside Lifer (hostPreference.ts) rather than to pair. */
  kind?: "hostPreference";
  /** For kind hostPreference: the value the app asks for. */
  openInHost?: boolean;
  expiresAt: Date;
  result: PairResult | null;
  done: Promise<PairResult>;
}

const requests = new Map<string, PairRequest & { settle: (r: PairResult) => void }>();

export function sixDigitCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function createPairRequest(
  fields: Pick<PairRequest, "userId" | "pluginId" | "name" | "scopes" | "code" | "kind" | "openInHost">,
): PairRequest {
  const id = randomBytes(32).toString("hex");
  let settle!: (r: PairResult) => void;
  const done = new Promise<PairResult>((resolve) => (settle = resolve));
  const request = { ...fields, id, expiresAt: new Date(Date.now() + PAIR_REQUEST_TTL_MS), result: null, done, settle };
  requests.set(id, request);
  setTimeout(() => settlePairRequest(id, { status: "expired" }), PAIR_REQUEST_TTL_MS).unref();
  return request;
}

/** Records the answer once; the entry stays a minute for an app that polls for it. */
export function settlePairRequest(id: string, result: PairResult): boolean {
  const r = requests.get(id);
  if (!r || r.result) return false;
  r.result = result;
  r.settle(result);
  setTimeout(() => requests.delete(id), COLLECT_MS).unref();
  return true;
}

/** Requests still waiting for this user's answer, oldest first. */
export function pendingPairRequests(userId: string): PairRequest[] {
  return [...requests.values()].filter((r) => r.userId === userId && !r.result);
}

export function getPairRequest(id: string): PairRequest | undefined {
  return requests.get(id);
}

/** The app asked and gave up (its connection closed) before the user answered. */
export function cancelPairRequest(id: string): void {
  const r = requests.get(id);
  if (!r || r.result) return;
  requests.delete(id);
  r.result = { status: "expired" };
  r.settle(r.result);
}

/** Hands an approved key over once, then forgets it. */
export function collectPairResult(id: string): PairResult | null {
  const r = requests.get(id);
  if (!r?.result) return null;
  if (r.result.status === "approved") requests.delete(id);
  return r.result;
}

// ---- Pairing codes (server) ----

const codes = new Map<string, { userId: string; expiresAt: number }>();
let codeFailures = 0;

export function createPairCode(userId: string): { code: string; expiresAt: Date } {
  const now = Date.now();
  for (const [c, v] of codes) if (v.expiresAt <= now) codes.delete(c);
  let code = sixDigitCode();
  while (codes.has(code)) code = sixDigitCode();
  const expiresAt = now + PAIR_CODE_TTL_MS;
  codes.set(code, { userId, expiresAt });
  return { code, expiresAt: new Date(expiresAt) };
}

/** Single use: a matching code is consumed. Compared in constant time against every live code. */
export function takePairCode(code: string): string | null {
  const now = Date.now();
  const presented = Buffer.from(code);
  let match: string | null = null;
  for (const [c, v] of codes) {
    if (sameBytes(Buffer.from(c), presented) && v.expiresAt > now) match = c;
  }
  if (match === null) {
    if (++codeFailures >= MAX_CODE_FAILURES) {
      codes.clear();
      codeFailures = 0;
    }
    return null;
  }
  const userId = codes.get(match)!.userId;
  codes.delete(match);
  return userId;
}

// ---- Grants: the user's own click in Lifer, standing in for the consent dialog (desktop) ----

// Long enough to download, install and open the app; short enough that a forgotten one lapses.
export const PAIR_GRANT_TTL_MS = 30 * 60_000;

export interface PairGrant {
  userId: string;
  pluginId: string;
  name: string;
  /** Exactly the scopes Lifer showed next to the button. */
  scopes: string[];
  expiresAt: Date;
}

// One per user and app; a new click replaces it. Memory only, like every other pending pairing.
const grants = new Map<string, PairGrant>();
const grantKey = (userId: string, pluginId: string) => `${userId}\n${pluginId}`;

export function createPairGrant(fields: Omit<PairGrant, "expiresAt">): PairGrant {
  const grant = { ...fields, scopes: [...new Set(fields.scopes)], expiresAt: new Date(Date.now() + PAIR_GRANT_TTL_MS) };
  grants.set(grantKey(fields.userId, fields.pluginId), grant);
  return grant;
}

/** Live grants of this user. */
export function pairGrants(userId: string): PairGrant[] {
  const now = Date.now();
  for (const [k, g] of grants) if (g.expiresAt.getTime() <= now) grants.delete(k);
  return [...grants.values()].filter((g) => g.userId === userId);
}

export function cancelPairGrant(userId: string, pluginId: string): boolean {
  return grants.delete(grantKey(userId, pluginId));
}

/** Uses up the app's grant when it covers every scope asked for. Anything beyond it leaves the grant
 *  alone, so the consent dialog decides instead. */
export function takePairGrant(userId: string, pluginId: string, scopes: string[]): boolean {
  const g = grants.get(grantKey(userId, pluginId));
  if (!g || g.expiresAt.getTime() <= Date.now() || !scopes.every((s) => g.scopes.includes(s))) return false;
  grants.delete(grantKey(userId, pluginId));
  return true;
}

// ---- Keys ----

/** The app's key: replaces any earlier one it had, so an app holds one key per user. */
export async function issuePluginKey(
  userId: string,
  pluginId: string,
  name: string,
  scopes: string[],
): Promise<string> {
  const key = generateApiKey();
  await pool.query(
    `INSERT INTO api_keys (user_id, name, key_hash, permissions, plugin_id) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, plugin_id) WHERE plugin_id IS NOT NULL
     DO UPDATE SET name = EXCLUDED.name, key_hash = EXCLUDED.key_hash, permissions = EXCLUDED.permissions,
                   created_at = now(), last_used_at = NULL`,
    [userId, name, hashApiKey(key), scopes, pluginId],
  );
  return key;
}

/** Whether the user already allowed this app every one of these scopes (it still has a key for them). */
export async function alreadyAllowed(userId: string, pluginId: string, scopes: string[]): Promise<boolean> {
  const res = await pool.query<{ permissions: string[] }>(
    `SELECT permissions FROM api_keys WHERE user_id = $1 AND plugin_id = $2`,
    [userId, pluginId],
  );
  const granted = res.rows[0]?.permissions;
  return !!granted && scopes.every((s) => granted.includes(s));
}

// For tests.
export function resetPairingState(): void {
  tickets.clear();
  requests.clear();
  codes.clear();
  grants.clear();
  codeFailures = 0;
}
