import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { pool } from "../db.js";
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
