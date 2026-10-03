import type { FastifyInstance } from "fastify";
import { pool, withTransaction } from "../db.js";
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from "./password.js";
import { createSession, destroySession, getSessionUser, requireAuth, rotateSessions } from "./session.js";
import { clearAttempts, ipRateLimitKey, isRateLimited, recordAttempt } from "./rateLimiter.js";
import { tryRestoreCollectionStateOnce } from "../lib/collectionState.js";

interface RegisterBody {
  email?: string;
  password?: string;
}

interface LoginBody {
  email?: string;
  password?: string;
}

interface ChangePasswordBody {
  currentPassword?: string;
  newPassword?: string;
}

interface ChangeEmailBody {
  currentPassword?: string;
  newEmail?: string;
}

// Across every IP, so rotating addresses can't keep guessing at one account.
const LOGIN_PER_EMAIL_MAX = 50;
// Arbitrary constant key that serializes first-run registrations.
const REGISTER_LOCK_KEY = 4_310_109;

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // This is a single-user instance: no invite codes, and no path to a second account.
  // Register only ever works once, at first run before any user exists. A forgotten password is
  // recovered with `lifer-admin reset-password` in a shell inside the container.
  app.get("/auth/setup-status", async () => {
    const res = await pool.query<{ count: string }>(`SELECT count(*) FROM users`);
    return { needsSetup: Number(res.rows[0].count) === 0 };
  });

  app.post<{ Body: RegisterBody }>("/auth/register", async (request, reply) => {
    const { email, password } = request.body ?? {};
    if (!email || !password) {
      return reply.code(400).send({ error: "email and password are required" });
    }
    if (password.length < 8) {
      return reply.code(400).send({ error: "Password must be at least 8 characters" });
    }
    const normalizedEmail = email.trim().toLowerCase();

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Two first-run registrations at once must not both see "no users yet".
      await client.query(`SELECT pg_advisory_xact_lock($1)`, [REGISTER_LOCK_KEY]);

      const existing = await client.query(`SELECT 1 FROM users LIMIT 1`);
      if (existing.rows.length > 0) {
        await client.query("ROLLBACK").catch(() => {});
        return reply.code(403).send({ error: "This Lifer instance already has an account set up" });
      }

      const passwordHash = await hashPassword(password);
      const userRes = await client.query<{ id: string; email: string }>(
        `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email`,
        [normalizedEmail, passwordHash],
      );

      await createSession(userRes.rows[0].id, reply, client);
      await client.query("COMMIT");
      return { id: userRes.rows[0].id, email: userRes.rows[0].email };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if ((err as { code?: string }).code === "23505") {
        return reply.code(409).send({ error: "An account with that email already exists" });
      }
      throw err;
    } finally {
      client.release();
    }
  });

  app.post<{ Body: LoginBody }>("/auth/login", async (request, reply) => {
    const { email, password } = request.body ?? {};
    if (!email || !password) {
      return reply.code(400).send({ error: "email and password are required" });
    }
    const normalizedEmail = email.trim().toLowerCase();

    // Keyed on email + IP and counting failures only, so someone else guessing at an email
    // can't lock its owner out from their own machine. The looser per-email cap stops a
    // guesser that spreads attempts over many addresses.
    const rateLimitKey = `${normalizedEmail}|${ipRateLimitKey(request.ip)}`;
    const emailKey = `login-email|${normalizedEmail}`;
    if (isRateLimited(rateLimitKey) || isRateLimited(emailKey, LOGIN_PER_EMAIL_MAX)) {
      return reply.code(429).send({ error: "Too many login attempts. Try again later." });
    }

    const res = await pool.query<{ id: string; email: string; password_hash: string }>(
      `SELECT id, email, password_hash FROM users WHERE email = $1`,
      [normalizedEmail],
    );
    const user = res.rows[0];
    // Always run a verify call even on a missing user, so response timing doesn't leak
    // whether the email exists.
    const validPassword = await verifyPassword(user ? user.password_hash : DUMMY_PASSWORD_HASH, password);
    if (!user || !validPassword) {
      recordAttempt(rateLimitKey);
      recordAttempt(emailKey);
      return reply.code(401).send({ error: "Invalid email or password" });
    }

    clearAttempts(rateLimitKey);
    await createSession(user.id, reply);
    return { id: user.id, email: user.email };
  });

  app.post("/auth/logout", async (request, reply) => {
    await destroySession(request, reply);
    return { ok: true };
  });

  app.get("/auth/me", async (request) => {
    const user = await getSessionUser(request);
    // A fresh install's user first appears here: bring back its archived/hidden/seen/target
    // species from the library's record, if there is one (lib/collectionState.ts).
    if (user) tryRestoreCollectionStateOnce(user.id);
    return { user };
  });

  // Separate from /auth/me, the light "am I logged in" check, so the settings page reads the
  // stored account rather than the session's copy.
  app.get("/auth/settings", { preHandler: requireAuth }, async (request) => {
    const res = await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [request.user!.id]);
    return { email: res.rows[0].email };
  });

  app.put<{ Body: ChangePasswordBody }>("/auth/password", { preHandler: requireAuth }, async (request, reply) => {
    const { currentPassword, newPassword } = request.body ?? {};
    if (!currentPassword || !newPassword) {
      return reply.code(400).send({ error: "currentPassword and newPassword are required" });
    }
    if (newPassword.length < 8) {
      return reply.code(400).send({ error: "Password must be at least 8 characters" });
    }

    const res = await pool.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [
      request.user!.id,
    ]);
    if (!(await verifyPassword(res.rows[0].password_hash, currentPassword))) {
      return reply.code(401).send({ error: "Current password is incorrect" });
    }

    const newHash = await hashPassword(newPassword);
    await withTransaction(async (client) => {
      await client.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [newHash, request.user!.id]);
      // Anyone signed in with the old password is signed out; this device gets a new session.
      await rotateSessions(request.user!.id, reply, client);
    });
    return { ok: true };
  });

  app.put<{ Body: ChangeEmailBody }>("/auth/email", { preHandler: requireAuth }, async (request, reply) => {
    const { currentPassword, newEmail } = request.body ?? {};
    if (!currentPassword || !newEmail) {
      return reply.code(400).send({ error: "currentPassword and newEmail are required" });
    }
    const normalizedEmail = newEmail.trim().toLowerCase();

    const res = await pool.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [
      request.user!.id,
    ]);
    if (!(await verifyPassword(res.rows[0].password_hash, currentPassword))) {
      return reply.code(401).send({ error: "Current password is incorrect" });
    }

    try {
      await withTransaction(async (client) => {
        await client.query(`UPDATE users SET email = $1 WHERE id = $2`, [normalizedEmail, request.user!.id]);
        await rotateSessions(request.user!.id, reply, client);
      });
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        return reply.code(409).send({ error: "An account with that email already exists" });
      }
      throw err;
    }
    return { email: normalizedEmail };
  });
}
