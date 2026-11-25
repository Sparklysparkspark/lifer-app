import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import type { FastifyReply, FastifyRequest } from "fastify";
import { pool } from "@lifer/core/db.js";
import { hashApiKey } from "./apiKeys.js";
import { SESSION_COOKIE_NAME, SESSION_TTL_MS, SINGLE_USER_MODE } from "@lifer/core/config.js";
import { hasLocalCredential } from "./localCredential.js";

export interface SessionUser {
  id: string;
  email: string;
}

const LOCAL_USER_EMAIL = "local@lifer.app";

// Desktop mode's single auto-provisioned user, created on first run. No password: getSessionUser
// returns it for every request that carries the desktop app's credential (localCredential.ts).
let cachedLocalUserId: string | null = null;
export async function getOrCreateLocalUser(): Promise<SessionUser> {
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

export async function createSession(
  userId: string,
  reply: FastifyReply,
  db: Pick<PoolClient, "query"> = pool,
): Promise<void> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)`, [
    hashToken(token),
    userId,
    expiresAt,
  ]);

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
  // Desktop mode: the local user, but only for the desktop app itself. Session cookies don't count
  // there, and API keys are checked separately by requireScope.
  if (SINGLE_USER_MODE) return hasLocalCredential(request) ? getOrCreateLocalUser() : null;

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
export async function rotateSessions(
  userId: string,
  reply: FastifyReply,
  db: Pick<PoolClient, "query"> = pool,
): Promise<void> {
  await db.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
  await createSession(userId, reply, db);
}

/** Fastify preValidation hook: 401s unless a valid session cookie is present. Attaches request.user.
 *  It runs before schema validation, so a signed-out caller learns nothing about a route's input.
 *  authKind marks it as a sign-in hook for the route catalog (lib/schema.ts). */
export const requireAuth = Object.assign(
  async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const user = await getSessionUser(request);
    if (!user) {
      reply.code(401).send({ error: "Not authenticated" });
      return;
    }
    request.user = user;
  },
  { authKind: "session" as const },
);

type VerifiedKey = { id: string; email: string; device: boolean; keyName: string; keyId: string; scopes: string[] };

// Checks an `x-api-key` header and that its permissions include `scope`. Returns the owning user,
// "missing_scope" for a valid key without the scope, or null for a missing or unknown key.
async function verifyApiKeyScope(
  request: FastifyRequest,
  scopes: readonly string[],
): Promise<VerifiedKey | "missing_scope" | null> {
  const token = request.headers["x-api-key"];
  if (typeof token !== "string" || !token) return null;

  const keyHash = hashApiKey(token);
  const res = await pool.query<{ id: string; user_id: string; permissions: string[]; email: string; name: string }>(
    `SELECT k.id, k.user_id, k.permissions, k.name, u.email FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = $1`,
    [keyHash],
  );
  const row = res.rows[0];
  if (!row) return null;
  if (!scopes.some((s) => row.permissions.includes(s))) return "missing_scope";

  // Fire-and-forget: a slow or failed write must not hold up the request.
  pool.query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [row.id]).catch(() => {});
  return {
    id: row.user_id,
    email: row.email,
    device: row.permissions.includes("companion"),
    keyName: row.name,
    keyId: row.id,
    scopes: row.permissions,
  };
}

/**
 * Fastify preValidation hook factory: passes for any valid session cookie, or for an `x-api-key`
 * whose permissions include `scope`. Attaches request.user either way. In desktop mode it passes for
 * the desktop app's own requests. The hook carries its scope, which the OpenAPI document reads
 * (lib/schema.ts routeCatalog). Every key failure is a 401, unless `missingScope403` lets a valid
 * key without the scope tell that apart from a revoked one.
 */
export function requireScope(
  scope: string,
  alsoAccept: readonly string[] = [],
  { missingScope403 = false }: { missingScope403?: boolean } = {},
) {
  const hook = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const sessionUser = await getSessionUser(request);
    if (sessionUser) {
      request.user = sessionUser;
      return;
    }
    const apiKeyUser = await verifyApiKeyScope(request, [scope, ...alsoAccept]);
    if (apiKeyUser === "missing_scope" && missingScope403) {
      const scopes = [scope, ...alsoAccept];
      reply.code(403).send({ error: `This key lacks the ${scopes.join(" or ")} scope`, code: "missing_scope", scopes });
      return;
    }
    if (!apiKeyUser || apiKeyUser === "missing_scope") {
      reply.code(401).send({ error: "Not authenticated" });
      return;
    }
    request.user = { id: apiKeyUser.id, email: apiKeyUser.email };
    request.deviceKey = apiKeyUser.device;
    request.apiKeyName = apiKeyUser.keyName;
    request.apiKeyId = apiKeyUser.keyId;
    request.apiKeyScopes = apiKeyUser.scopes;
  };
  return Object.assign(hook, { scope, alsoAccept, authKind: "scope" as const });
}
