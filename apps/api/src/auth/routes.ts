import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool, withTransaction } from "@lifer/core/db.js";
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from "./password.js";
import { createSession, destroySession, getSessionUser, requireAuth, rotateSessions } from "./session.js";
import { clearAttempts, ipRateLimitKey, isRateLimited, recordAttempt } from "./rateLimiter.js";
import { tryRestoreCollectionStateOnce } from "../lib/collectionState.js";
import { SINGLE_USER_MODE } from "@lifer/core/config.js";
import { hasLaunchTokenHeader, localCredentialConfig, setLocalSessionCookie } from "./localCredential.js";
import { Ok, replies, withSchemas, type InvalidInputReply } from "../lib/schema.js";

// These forms show the server's message to a person (the setup and sign-in pages, the desktop
// app's server check), so a malformed body keeps the plain sentence they always got.
const required = (error: string): { invalidInput: { body: InvalidInputReply } } => ({
  invalidInput: { body: { status: 400, error } },
});
const NonEmpty = Type.String({ minLength: 1 });
const Credentials = Type.Object({ email: NonEmpty, password: NonEmpty }, { additionalProperties: false });

// Across every IP, so rotating addresses can't keep guessing at one account.
const LOGIN_PER_EMAIL_MAX = 50;
// Arbitrary constant key that serializes first-run registrations.
const REGISTER_LOCK_KEY = 4_310_109;

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  // This is a single-user instance: no invite codes, and no path to a second account.
  // Register only ever works once, at first run before any user exists. A forgotten password is
  // recovered with `lifer-admin reset-password` in a shell inside the container.
  app.get(
    "/auth/setup-status",
    { schema: { response: replies(Type.Object({ needsSetup: Type.Boolean() })) } },
    async () => {
      const res = await pool.query<{ count: string }>(`SELECT count(*) FROM users`);
      return { needsSetup: Number(res.rows[0].count) === 0 };
    },
  );

  app.post(
    "/auth/register",
    { config: required("email and password are required"), schema: { body: Credentials } },
    async (request, reply) => {
      const { email, password } = request.body;
      // Here rather than in the schema, for the sentence the setup page shows.
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
    },
  );

  app.post(
    "/auth/login",
    { config: required("email and password are required"), schema: { body: Credentials } },
    async (request, reply) => {
      const { email, password } = request.body;
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
    },
  );

  app.post("/auth/logout", { schema: { response: replies(Ok) } }, async (request, reply) => {
    await destroySession(request, reply);
    return { ok: true };
  });

  app.get("/auth/me", { schema: {} }, async (request) => {
    const user = await getSessionUser(request);
    // A fresh install's user first appears here: bring back its archived/hidden/seen/target
    // species from the library's record, if there is one (lib/collectionState.ts).
    if (user) tryRestoreCollectionStateOnce(user.id);
    return { user };
  });

  // Desktop mode: the app's window presents the per-launch secret (handed to it by the desktop
  // shell) once and gets the HttpOnly cookie that signs in its later requests, images included.
  // See localCredential.ts.
  app.post("/auth/desktop-session", { schema: { response: replies(Ok) } }, async (request, reply) => {
    if (!SINGLE_USER_MODE) {
      return reply.code(404).send({ error: "Only available in the desktop app", code: "desktop_only" });
    }
    const config = localCredentialConfig();
    // Development without the desktop shell (LIFER_ALLOW_UNTOKENED_DESKTOP=1): nothing to trade.
    if (!config.token && config.allowUntokened) return { ok: true };
    if (!config.token || !hasLaunchTokenHeader(request, config)) {
      return reply.code(401).send({ error: "Not authenticated" });
    }
    setLocalSessionCookie(reply, config.token);
    return { ok: true };
  });

  // Separate from /auth/me, the light "am I logged in" check, so the settings page reads the
  // stored account rather than the session's copy.
  app.get(
    "/auth/settings",
    { preValidation: requireAuth, schema: { response: replies(Type.Object({ email: Type.String() })) } },
    async (request) => {
      const res = await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [request.user!.id]);
      return { email: res.rows[0].email };
    },
  );

  app.put(
    "/auth/password",
    {
      preValidation: requireAuth,
      config: required("currentPassword and newPassword are required"),
      schema: {
        body: Type.Object({ currentPassword: NonEmpty, newPassword: NonEmpty }, { additionalProperties: false }),
        response: replies(Ok),
      },
    },
    async (request, reply) => {
      const { currentPassword, newPassword } = request.body;
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
    },
  );

  app.put(
    "/auth/email",
    {
      preValidation: requireAuth,
      config: required("currentPassword and newEmail are required"),
      schema: {
        body: Type.Object({ currentPassword: NonEmpty, newEmail: NonEmpty }, { additionalProperties: false }),
        response: replies(Type.Object({ email: Type.String() })),
      },
    },
    async (request, reply) => {
      const { currentPassword, newEmail } = request.body;
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
    },
  );
}
