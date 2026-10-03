import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import type { FastifyReply, FastifyRequest } from "fastify";
import { pool } from "../db.js";
import { hashApiKey } from "./apiKeys.js";
import { SESSION_COOKIE_NAME, SESSION_TTL_MS, SINGLE_USER_MODE } from "../config.js";

export interface SessionUser {
  id: string;
  email: string;
}

const LOCAL_USER_EMAIL = "local@lifer.app";

// Desktop mode's single auto-provisioned user, created on first run. No password: getSessionUser
// always returns it.
let cachedLocalUserId: string | null = null;
async function getOrCreateLocalUser(): Promise<SessionUser> {
  if (cachedLocalUserId) return { id: cachedLocalUserId, email: LOCAL_USER_EMAIL };
  // Several first-load requests race here on a new library, so the insert uses ON CONFLICT DO
  // NOTHING and the losers read back the winner's row.
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

// Sessions are stored as sha256(token), so the database alone can't be replayed
// as a login. Matches migration 109's encode(digest(..., 'sha256'), 'hex').
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Secure only when the browser reached us over https, directly or through a TLS proxy. Plain http
// home servers need it off, since browsers drop a Secure cookie there.
export function cookieSecureFor(request: Pick<FastifyRequest, "protocol" | "headers">): boolean {
  if (request.protocol === "https") return true;
  // Also read the header directly, for proxies outside the trusted ranges. A spoofed value can only
  // make the sender's own cookie Secure. The first entry is the hop the browser connected to.
  const forwarded = request.headers["x-forwarded-proto"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim().toLowerCase();
  return first === "https";
}

export async function createSession(userId: string, reply: FastifyReply, db: Pick<PoolClient, "query"> = pool): Promise<void> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)`, [hashToken(token), userId, expiresAt]);

  reply.setCookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: cookieSecureFor(reply.request),
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies[SESSION_COOKIE_NAME];
  if (token) {
    await pool.query(`DELETE FROM sessions WHERE id = $1`, [hashToken(token)]);
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
    [hashToken(token)],
  );
  return res.rows[0] ?? null;
}

/** Signs out every session of this user (other devices included) and issues a fresh one here. */
export async function rotateSessions(userId: string, reply: FastifyReply, db: Pick<PoolClient, "query"> = pool): Promise<void> {
  await db.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
  await createSession(userId, reply, db);
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

// Checks an `x-api-key` header and that its permissions include `scope`. Returns the owning user,
// or null for every failure alike (missing header, unknown key, wrong scope).
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

  // Fire-and-forget: a slow or failed write must not hold up the request.
  pool.query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [row.id]).catch(() => {});
  return { id: row.user_id, email: row.email };
}

/**
 * Fastify preHandler factory: passes for any valid session cookie, or for an `x-api-key` whose
 * permissions include `scope`. Attaches request.user either way. Always passes in desktop mode.
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
