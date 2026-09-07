import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { pool } from "../db.js";
import { hashApiKey } from "./apiKeys.js";
import { COOKIE_SECURE, SESSION_COOKIE_NAME, SESSION_TTL_MS, SINGLE_USER_MODE } from "../config.js";

export interface SessionUser {
  id: string;
  email: string;
}

const LOCAL_USER_EMAIL = "local@lifer.app";

// Desktop mode's single auto-provisioned user (see config.ts's SINGLE_USER_MODE comment) —
// created once on first run, reused on every request after. No password: nothing ever
// authenticates against it, since getSessionUser below short-circuits to it unconditionally.
let cachedLocalUserId: string | null = null;
async function getOrCreateLocalUser(): Promise<SessionUser> {
  if (cachedLocalUserId) return { id: cachedLocalUserId, email: LOCAL_USER_EMAIL };
  // A brand new local library gets several requests firing on first page load, all racing
  // into this function before any of them has committed a row — a plain check-then-insert
  // (SELECT, then INSERT if missing) lets more than one of them see "no user yet" and all try
  // to INSERT, so every request after the first one to actually commit throws a real
  // users_email_key violation instead of just finding the row. ON CONFLICT DO NOTHING sidesteps
  // that: the losing inserts return no row instead of throwing, and fall back to the SELECT
  // below to pick up whichever one actually won.
  const randomPasswordHash = randomBytes(32).toString("hex");
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING id`,
    [LOCAL_USER_EMAIL, randomPasswordHash],
  );
  if (inserted.rows[0]) {
    cachedLocalUserId = inserted.rows[0].id;
    return { id: cachedLocalUserId, email: LOCAL_USER_EMAIL };
  }
  const existing = await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [LOCAL_USER_EMAIL]);
  cachedLocalUserId = existing.rows[0].id;
  return { id: cachedLocalUserId, email: LOCAL_USER_EMAIL };
}

export async function createSession(userId: string, reply: FastifyReply): Promise<void> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)`, [token, userId, expiresAt]);

  reply.setCookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies[SESSION_COOKIE_NAME];
  if (token) {
    await pool.query(`DELETE FROM sessions WHERE id = $1`, [token]);
  }
  reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
}

export async function getSessionUser(request: FastifyRequest): Promise<SessionUser | null> {
  if (SINGLE_USER_MODE) return getOrCreateLocalUser();

  const token = request.cookies[SESSION_COOKIE_NAME];
  if (!token) return null;

  const res = await pool.query<{ id: string; email: string }>(
    `SELECT u.id, u.email FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at > now()`,
    [token],
  );
  return res.rows[0] ?? null;
}

/** Fastify preHandler: 401s unless a valid session cookie is present. Attaches request.user. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await getSessionUser(request);
  if (!user) {
    reply.code(401).send({ error: "Not authenticated" });
    return;
  }
  request.user = user;
}

// Verifies an `x-api-key` header (same header name Immich uses) against api_keys.key_hash and
// confirms `scope` is in that row's permissions. Returns the key's owning user on success, null
// on any failure — deliberately one generic outcome (missing header, unknown key, wrong scope
// all look the same to the caller), same non-distinguishing-response spirit as /auth/login.
async function verifyApiKeyScope(
  request: FastifyRequest,
  scope: string,
): Promise<{ id: string; email: string } | null> {
  const token = request.headers["x-api-key"];
  if (typeof token !== "string" || !token) return null;

  const keyHash = hashApiKey(token);
  const res = await pool.query<{ id: string; user_id: string; permissions: string[]; email: string }>(
    `SELECT k.id, k.user_id, k.permissions, u.email FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = $1`,
    [keyHash],
  );
  const row = res.rows[0];
  if (!row || !row.permissions.includes(scope)) return null;

  // Fire-and-forget — a slow/failed write here should never hold up or fail the actual request.
  pool.query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [row.id]).catch(() => {});
  return { id: row.user_id, email: row.email };
}

/**
 * Fastify preHandler factory: passes for a valid session cookie unconditionally (a logged-in
 * user's own browser is never scope-limited), or for an `x-api-key` header whose stored
 * permissions include `scope`. Attaches request.user either way, so downstream route code
 * (`request.user!.id`) is unchanged regardless of which credential authenticated the request.
 *
 * Only meaningful for server mode — SINGLE_USER_MODE's getSessionUser always returns the local
 * user regardless of any header, so this passes unconditionally there too (matching requireAuth's
 * own desktop behavior), which is fine: desktop never surfaces the API-key management UI, so no
 * key ever legitimately exists to check against in that mode anyway.
 */
export function requireScope(scope: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const sessionUser = await getSessionUser(request);
    if (sessionUser) {
      request.user = sessionUser;
      return;
    }
    const apiKeyUser = await verifyApiKeyScope(request, scope);
    if (!apiKeyUser) {
      reply.code(401).send({ error: "Not authenticated" });
      return;
    }
    request.user = apiKeyUser;
  };
}
