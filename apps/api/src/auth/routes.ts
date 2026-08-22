import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { hashPassword, verifyPassword } from "./password.js";
import { createSession, destroySession, getSessionUser, requireAuth } from "./session.js";
import { isRateLimited, recordAttempt } from "./rateLimiter.js";
import { sendMail } from "../email/mailer.js";
import { APP_URL } from "../config.js";

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

interface RecoveryEmailBody {
  currentPassword?: string;
  recoveryEmail?: string | null;
}

interface ForgotPasswordBody {
  email?: string;
}

interface ResetPasswordBody {
  token?: string;
  newPassword?: string;
}

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // This is a single-user instance: no invite codes, and no path to a second account.
  // Register only ever works once, at first run before any user exists; after that this
  // instance has its one account for good, so this stays a public endpoint with no other
  // guard needed.
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

      const existing = await client.query(`SELECT 1 FROM users LIMIT 1`);
      if (existing.rows.length > 0) {
        await client.query("ROLLBACK");
        return reply.code(403).send({ error: "This Lifer instance already has an account set up" });
      }

      const passwordHash = await hashPassword(password);
      const userRes = await client.query<{ id: string; email: string }>(
        `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email`,
        [normalizedEmail, passwordHash],
      );

      await client.query("COMMIT");
      await createSession(userRes.rows[0].id, reply);
      return { id: userRes.rows[0].id, email: userRes.rows[0].email };
    } catch (err) {
      await client.query("ROLLBACK");
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

    if (isRateLimited(normalizedEmail)) {
      return reply.code(429).send({ error: "Too many login attempts. Try again later." });
    }
    recordAttempt(normalizedEmail);

    const res = await pool.query<{ id: string; email: string; password_hash: string }>(
      `SELECT id, email, password_hash FROM users WHERE email = $1`,
      [normalizedEmail],
    );
    const user = res.rows[0];
    // Always run a verify call even on a missing user, so response timing doesn't leak
    // whether the email exists.
    const validPassword = user ? await verifyPassword(user.password_hash, password) : await verifyPassword(
      "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      password,
    );
    if (!user || !validPassword) {
      return reply.code(401).send({ error: "Invalid email or password" });
    }

    await createSession(user.id, reply);
    return { id: user.id, email: user.email };
  });

  app.post("/auth/logout", async (request, reply) => {
    await destroySession(request, reply);
    return { ok: true };
  });

  app.get("/auth/me", async (request) => {
    const user = await getSessionUser(request);
    return { user };
  });

  // Separate from /auth/me — that's the light "am I logged in" check used everywhere;
  // this carries the extra field (recoveryEmail) only the settings page needs.
  app.get("/auth/settings", { preHandler: requireAuth }, async (request) => {
    const res = await pool.query<{ email: string; recovery_email: string | null }>(
      `SELECT email, recovery_email FROM users WHERE id = $1`,
      [request.user!.id],
    );
    return { email: res.rows[0].email, recoveryEmail: res.rows[0].recovery_email };
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
    await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [newHash, request.user!.id]);
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
      await pool.query(`UPDATE users SET email = $1 WHERE id = $2`, [normalizedEmail, request.user!.id]);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        return reply.code(409).send({ error: "An account with that email already exists" });
      }
      throw err;
    }
    return { email: normalizedEmail };
  });

  app.put<{ Body: RecoveryEmailBody }>("/auth/recovery-email", { preHandler: requireAuth }, async (request, reply) => {
    const { currentPassword, recoveryEmail } = request.body ?? {};
    if (!currentPassword) {
      return reply.code(400).send({ error: "currentPassword is required" });
    }

    const res = await pool.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [
      request.user!.id,
    ]);
    if (!(await verifyPassword(res.rows[0].password_hash, currentPassword))) {
      return reply.code(401).send({ error: "Current password is incorrect" });
    }

    const normalized = recoveryEmail?.trim().toLowerCase() || null;
    await pool.query(`UPDATE users SET recovery_email = $1 WHERE id = $2`, [normalized, request.user!.id]);
    return { recoveryEmail: normalized };
  });

  app.post<{ Body: ForgotPasswordBody }>("/auth/forgot-password", async (request, reply) => {
    const { email } = request.body ?? {};
    if (!email) {
      return reply.code(400).send({ error: "email is required" });
    }
    const normalizedEmail = email.trim().toLowerCase();

    const res = await pool.query<{ id: string; email: string; recovery_email: string | null }>(
      `SELECT id, email, recovery_email FROM users WHERE email = $1`,
      [normalizedEmail],
    );
    const user = res.rows[0];
    // Always return the same generic response whether or not the account exists, so this
    // endpoint can't be used to test which emails are registered.
    if (user) {
      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
      await pool.query(`INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES ($1, $2, $3)`, [
        token,
        user.id,
        expiresAt,
      ]);
      const resetUrl = `${APP_URL}/reset-password?token=${token}`;
      await sendMail(
        user.recovery_email ?? user.email,
        "Reset your Lifer password",
        `Someone (hopefully you) requested a password reset for your Lifer account.\n\n` +
          `Reset it here: ${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.`,
      );
    }
    return { ok: true };
  });

  app.post<{ Body: ResetPasswordBody }>("/auth/reset-password", async (request, reply) => {
    const { token, newPassword } = request.body ?? {};
    if (!token || !newPassword) {
      return reply.code(400).send({ error: "token and newPassword are required" });
    }
    if (newPassword.length < 8) {
      return reply.code(400).send({ error: "Password must be at least 8 characters" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query<{ user_id: string; expires_at: Date; used_at: Date | null }>(
        `SELECT user_id, expires_at, used_at FROM password_reset_tokens WHERE token = $1 FOR UPDATE`,
        [token],
      );
      const row = res.rows[0];
      if (!row || row.used_at || row.expires_at < new Date()) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ error: "This reset link is invalid or has expired" });
      }

      const newHash = await hashPassword(newPassword);
      await client.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [newHash, row.user_id]);
      await client.query(`UPDATE password_reset_tokens SET used_at = now() WHERE token = $1`, [token]);
      // Reset invalidates every existing session — if someone else triggered this reset with
      // access to the recovery inbox, this also kicks out whoever holds the current session.
      await client.query(`DELETE FROM sessions WHERE user_id = $1`, [row.user_id]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    return { ok: true };
  });
}
