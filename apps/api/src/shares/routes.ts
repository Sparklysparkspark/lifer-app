// Public, revocable links to an album's current contents (read at request time).
// The public routes below never use requireAuth or request.user, and this file is kept separate so
// it's clear which routes are unauthenticated. GPS is never included, so a link can't reveal a
// rare species' location. Links are found by their token's sha256 (token_hash, migration 132);
// the owner's copy for the share list is kept encrypted (lib/secretBox.ts), never as plain text.
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { cookieSecureFor, hashToken, requireScope } from "../auth/session.js";
import { SECRET_CONTEXT, SecretUnavailableError, secretBox } from "../lib/secretBox.js";
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from "../auth/password.js";
import { ipRateLimitKey, isRateLimited, recordAttempt } from "../auth/rateLimiter.js";
import { contentDisposition } from "../lib/httpFile.js";
import { parseDate } from "../lib/validate.js";
import { IdParams, Nullable, Ok, Uuid, notFoundOnInvalidId, replies, withSchemas } from "../lib/schema.js";
import { addUnlock, hasUnlock } from "./unlockCookie.js";

const albumNotFound = notFoundOnInvalidId("Album not found");
const TokenParams = Type.Object({ token: Type.String({ minLength: 1 }) });

const SHARE_TOKEN_MAX_ATTEMPTS = 50;
// Unlocked shares live in one signed cookie (unlockCookie.ts).
const UNLOCK_COOKIE_NAME = "share_unlock";

function isLive(row: { revoked_at: Date | null; expires_at: Date | null }): boolean {
  if (row.revoked_at) return false;
  if (row.expires_at && row.expires_at < new Date()) return false;
  return true;
}

async function resolveShare(token: string) {
  const res = await pool.query<{
    id: string;
    album_id: string;
    password_hash: string | null;
    allow_download: boolean;
    show_metadata: boolean;
    expires_at: Date | null;
    revoked_at: Date | null;
    album_name: string;
  }>(
    `SELECT sl.id, sl.album_id, sl.password_hash, sl.allow_download, sl.show_metadata, sl.expires_at, sl.revoked_at, a.name AS album_name
     FROM shared_links sl
     JOIN albums a ON a.id = sl.album_id
     WHERE sl.token_hash = $1`,
    [hashToken(token)],
  );
  return res.rows[0] ?? null;
}

/** The owner's copy of a share link's token, or null when it can't be decrypted (the server's
 *  key file was lost). The link itself still works; only showing it again doesn't. */
function readStoredToken(row: { token_encrypted: string | null; token: string | null }): string | null {
  if (row.token_encrypted) {
    try {
      return secretBox.decrypt(row.token_encrypted, SECRET_CONTEXT.shareLinkToken);
    } catch (err) {
      if (!(err instanceof SecretUnavailableError)) throw err;
      return null;
    }
  }
  // A row from before migration 132 that encryptStoredShareTokens hasn't reached yet.
  return row.token;
}

/** Moves share tokens still stored as plain text (rows from before migration 132) into their
 *  encrypted copy, at startup. Returns how many rows changed. */
export async function encryptStoredShareTokens(db: Pick<typeof pool, "query"> = pool): Promise<number> {
  const res = await db.query<{ id: string; token: string }>(`SELECT id, token FROM shared_links WHERE token IS NOT NULL`);
  for (const row of res.rows) {
    await db.query(`UPDATE shared_links SET token_encrypted = $2, token = NULL WHERE id = $1 AND token = $3`, [
      row.id,
      secretBox.encrypt(row.token, SECRET_CONTEXT.shareLinkToken),
      row.token,
    ]);
  }
  return res.rows.length;
}

function hasValidUnlock(request: { cookies: Record<string, string | undefined> }, shareId: string): boolean {
  return hasUnlock(request.cookies[UNLOCK_COOKIE_NAME], shareId);
}

export async function albumShareRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  // ---- Owner-side (authenticated) ----

  app.post(
    "/albums/:id/shares",
    {
      preValidation: requireScope("share.write"),
      config: albumNotFound,
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            // Blank means no password.
            password: Type.Optional(Type.String()),
            allowDownload: Type.Optional(Type.Boolean()),
            showMetadata: Type.Optional(Type.Boolean()),
            // Not format date-time: parseDate below takes any date string, as it always has.
            expiresAt: Type.Optional(Nullable(Type.String())),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const { password, allowDownload, showMetadata, expiresAt: rawExpiresAt } = request.body;
      const expiresAt = parseDate(rawExpiresAt);
      if (expiresAt === undefined) return reply.code(400).send({ error: "expiresAt must be a valid date" });

      const albumRes = await pool.query(`SELECT 1 FROM albums WHERE id = $1 AND user_id = $2`, [
        request.params.id,
        request.user!.id,
      ]);
      if (albumRes.rows.length === 0) return reply.code(404).send({ error: "Album not found" });

      const token = randomBytes(32).toString("base64url");
      const passwordHash = password ? await hashPassword(password) : null;

      const res = await pool.query(
        `INSERT INTO shared_links (album_id, token_hash, token_encrypted, password_hash, allow_download, show_metadata, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, allow_download, show_metadata, expires_at, created_at`,
        [
          request.params.id,
          hashToken(token),
          secretBox.encrypt(token, SECRET_CONTEXT.shareLinkToken),
          passwordHash,
          !!allowDownload,
          !!showMetadata,
          expiresAt,
        ],
      );
      const r = res.rows[0];
      return {
        id: r.id,
        token,
        hasPassword: !!passwordHash,
        allowDownload: r.allow_download,
        showMetadata: r.show_metadata,
        expiresAt: r.expires_at,
        createdAt: r.created_at,
      };
    },
  );

  app.get(
    "/albums/:id/shares",
    { preValidation: requireScope("share.read"), config: albumNotFound, schema: { params: IdParams } },
    async (request, reply) => {
      const albumRes = await pool.query(`SELECT 1 FROM albums WHERE id = $1 AND user_id = $2`, [
        request.params.id,
        request.user!.id,
      ]);
      if (albumRes.rows.length === 0) return reply.code(404).send({ error: "Album not found" });

      const res = await pool.query(
        `SELECT id, token, token_encrypted, password_hash, allow_download, show_metadata, expires_at, revoked_at, created_at
         FROM shared_links WHERE album_id = $1 ORDER BY created_at DESC`,
        [request.params.id],
      );
      return {
        shares: res.rows.map((r) => ({
          id: r.id,
          token: readStoredToken(r),
          hasPassword: !!r.password_hash,
          allowDownload: r.allow_download,
          showMetadata: r.show_metadata,
          expiresAt: r.expires_at,
          revoked: !!r.revoked_at,
          createdAt: r.created_at,
        })),
      };
    },
  );

  app.delete(
    "/shares/:id",
    {
      preValidation: requireScope("share.write"),
      config: notFoundOnInvalidId("Share not found"),
      schema: { params: IdParams, response: replies(Ok) },
    },
    async (request, reply) => {
      // Revoke rather than delete, to keep an audit trail. Ownership joins through albums.
      const res = await pool.query(
        `UPDATE shared_links sl SET revoked_at = now()
         FROM albums a
         WHERE sl.id = $1 AND sl.album_id = a.id AND a.user_id = $2 AND sl.revoked_at IS NULL`,
        [request.params.id, request.user!.id],
      );
      if (res.rowCount === 0) return reply.code(404).send({ error: "Share not found" });
      return { ok: true };
    },
  );

  // ---- Public (no requireAuth past this point) ----

  app.get("/share/:token", { schema: { params: TokenParams } }, async (request, reply) => {
    const share = await resolveShare(request.params.token);
    if (!share || !isLive(share))
      return reply.code(404).send({ error: "This link doesn't exist or is no longer available" });

    if (share.password_hash && !hasValidUnlock(request, share.id)) {
      return { needsPassword: true };
    }

    const itemsRes = await pool.query(
      `SELECT c.id AS capture_id, p.id AS photo_id, p.width, p.height, s.common_name, s.scientific_name,
              c.camera_model, c.lens, c.focal_length_mm, c.aperture, c.shutter, c.iso
       FROM album_captures ac
       JOIN captures c ON c.id = ac.capture_id
       JOIN photos p ON p.id = c.current_photo_id
       JOIN species s ON s.id = c.species_id
       WHERE ac.album_id = $1
       ORDER BY ac.added_at DESC`,
      [share.album_id],
    );

    return {
      title: share.album_name,
      allowDownload: share.allow_download,
      items: itemsRes.rows.map((row) => ({
        photoId: row.photo_id,
        captureId: row.capture_id,
        width: row.width,
        height: row.height,
        commonName: row.common_name,
        scientificName: row.scientific_name,
        // Camera EXIF only when the owner opted in. GPS is never selected above.
        ...(share.show_metadata
          ? {
              cameraModel: row.camera_model,
              lens: row.lens,
              focalLengthMm: row.focal_length_mm,
              aperture: row.aperture,
              shutter: row.shutter,
              iso: row.iso,
            }
          : {}),
      })),
    };
  });

  app.post(
    "/share/:token/unlock",
    {
      // Anything but the right password is "Incorrect password", malformed requests included, so
      // a public visitor sees one answer.
      config: { invalidInput: { body: { status: 401, error: "Incorrect password" } } },
      schema: {
        params: TokenParams,
        body: Type.Object({ password: Type.Optional(Type.String()) }, { additionalProperties: false }),
      },
    },
    async (request, reply) => {
      // Per token+IP, plus a looser per-token cap so rotating IPs (or a spoofed
      // X-Forwarded-For) can't brute-force one share's password. Only wrong passwords count,
      // so a visitor reopening the link isn't locked out.
      const ipKey = `${request.params.token}:${ipRateLimitKey(request.ip)}`;
      const tokenKey = `share-token:${request.params.token}`;
      if (isRateLimited(ipKey) || isRateLimited(tokenKey, SHARE_TOKEN_MAX_ATTEMPTS)) {
        return reply.code(429).send({ error: "Too many attempts. Try again later." });
      }

      const share = await resolveShare(request.params.token);
      const validPassword = await verifyPassword(
        share?.password_hash ?? DUMMY_PASSWORD_HASH,
        request.body.password ?? "",
      );
      if (!share || !isLive(share) || !share.password_hash || !validPassword) {
        recordAttempt(ipKey);
        recordAttempt(tokenKey);
        return reply.code(401).send({ error: "Incorrect password" });
      }

      const { value, expiresAt } = addUnlock(request.cookies[UNLOCK_COOKIE_NAME], share.id);
      reply.setCookie(UNLOCK_COOKIE_NAME, value, {
        httpOnly: true,
        secure: cookieSecureFor(request),
        sameSite: "lax",
        path: "/",
        expires: new Date(expiresAt),
      });
      return { ok: true };
    },
  );

  for (const kind of ["display", "thumb"] as const) {
    app.get(
      `/share/:token/photos/:photoId/${kind}`,
      {
        config: notFoundOnInvalidId("Photo not found"),
        schema: {
          params: Type.Object({ token: Type.String({ minLength: 1 }), photoId: Uuid() }),
          // Any other value is ignored, as before: the web app only ever sends "1".
          querystring: Type.Object({ download: Type.Optional(Type.String()) }),
        },
      },
      async (request, reply) => {
        const share = await resolveShare(request.params.token);
        if (!share || !isLive(share)) return reply.code(404).send({ error: "Not found" });
        if (share.password_hash && !hasValidUnlock(request, share.id)) {
          return reply.code(401).send({ error: "This link is password-protected" });
        }

        const column = kind === "display" ? "p.display_path" : "p.thumb_path";
        // Through the captures view and its current photo, so a trashed capture or an older
        // rendition is never served from a public link.
        const res = await pool.query<{ path: string }>(
          `SELECT ${column} AS path
           FROM album_captures ac
           JOIN captures c ON c.id = ac.capture_id
           JOIN photos p ON p.id = c.current_photo_id
           WHERE ac.album_id = $1 AND p.id = $2`,
          [share.album_id, request.params.photoId],
        );
        const filePath = res.rows[0]?.path;
        if (!filePath || !existsSync(filePath)) return reply.code(404).send({ error: "Photo not found" });

        reply.header("Content-Type", "image/webp");
        // Downloads offer only the display derivative, when opted in, never the original.
        if (kind === "display" && request.query.download === "1" && share.allow_download) {
          reply.header("Content-Disposition", contentDisposition(`${request.params.photoId}.webp`));
        }
        return reply.send(createReadStream(filePath));
      },
    );
  }
}
