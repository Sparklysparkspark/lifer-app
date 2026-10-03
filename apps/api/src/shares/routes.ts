// Public, revocable links to an album's current contents (read at request time).
// The public routes below never use requireAuth or request.user, and this file is kept separate so
// it's clear which routes are unauthenticated. GPS is never included, so a link can't reveal a
// rare species' location.
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { cookieSecureFor, requireScope } from "../auth/session.js";
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from "../auth/password.js";
import { ipRateLimitKey, isRateLimited, recordAttempt } from "../auth/rateLimiter.js";
import { contentDisposition } from "../lib/httpFile.js";
import { isUuid, parseDate } from "../lib/validate.js";
import { addUnlock, hasUnlock } from "./unlockCookie.js";

interface CreateShareBody {
  password?: string;
  allowDownload?: boolean;
  showMetadata?: boolean;
  expiresAt?: string | null;
}

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
     WHERE sl.token = $1`,
    [token],
  );
  return res.rows[0] ?? null;
}

function hasValidUnlock(request: { cookies: Record<string, string | undefined> }, shareId: string): boolean {
  return hasUnlock(request.cookies[UNLOCK_COOKIE_NAME], shareId);
}

export async function albumShareRoutes(app: FastifyInstance): Promise<void> {
  // ---- Owner-side (authenticated) ----

  app.post<{ Params: { id: string }; Body: CreateShareBody }>(
    "/albums/:id/shares",
    { preHandler: requireScope("share.write") },
    async (request, reply) => {
      if (!isUuid(request.params.id)) return reply.code(404).send({ error: "Album not found" });
      const { password, allowDownload, showMetadata, expiresAt: rawExpiresAt } = request.body ?? {};
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
        `INSERT INTO shared_links (album_id, token, password_hash, allow_download, show_metadata, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, token, allow_download, show_metadata, expires_at, created_at`,
        [request.params.id, token, passwordHash, !!allowDownload, !!showMetadata, expiresAt],
      );
      const r = res.rows[0];
      return {
        id: r.id,
        token: r.token,
        hasPassword: !!passwordHash,
        allowDownload: r.allow_download,
        showMetadata: r.show_metadata,
        expiresAt: r.expires_at,
        createdAt: r.created_at,
      };
    },
  );

  app.get<{ Params: { id: string } }>("/albums/:id/shares", { preHandler: requireScope("share.read") }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(404).send({ error: "Album not found" });
    const albumRes = await pool.query(`SELECT 1 FROM albums WHERE id = $1 AND user_id = $2`, [
      request.params.id,
      request.user!.id,
    ]);
    if (albumRes.rows.length === 0) return reply.code(404).send({ error: "Album not found" });

    const res = await pool.query(
      `SELECT id, token, password_hash, allow_download, show_metadata, expires_at, revoked_at, created_at
       FROM shared_links WHERE album_id = $1 ORDER BY created_at DESC`,
      [request.params.id],
    );
    return {
      shares: res.rows.map((r) => ({
        id: r.id,
        token: r.token,
        hasPassword: !!r.password_hash,
        allowDownload: r.allow_download,
        showMetadata: r.show_metadata,
        expiresAt: r.expires_at,
        revoked: !!r.revoked_at,
        createdAt: r.created_at,
      })),
    };
  });

  app.delete<{ Params: { id: string } }>("/shares/:id", { preHandler: requireScope("share.write") }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(404).send({ error: "Share not found" });
    // Revoke rather than delete, to keep an audit trail. Ownership joins through albums.
    const res = await pool.query(
      `UPDATE shared_links sl SET revoked_at = now()
       FROM albums a
       WHERE sl.id = $1 AND sl.album_id = a.id AND a.user_id = $2 AND sl.revoked_at IS NULL`,
      [request.params.id, request.user!.id],
    );
    if (res.rowCount === 0) return reply.code(404).send({ error: "Share not found" });
    return { ok: true };
  });

  // ---- Public (no requireAuth past this point) ----

  app.get<{ Params: { token: string } }>("/share/:token", async (request, reply) => {
    const share = await resolveShare(request.params.token);
    if (!share || !isLive(share)) return reply.code(404).send({ error: "This link doesn't exist or is no longer available" });

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

  app.post<{ Params: { token: string }; Body: { password?: string } }>(
    "/share/:token/unlock",
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
      const validPassword = await verifyPassword(share?.password_hash ?? DUMMY_PASSWORD_HASH, request.body?.password ?? "");
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
    app.get<{ Params: { token: string; photoId: string }; Querystring: { download?: string } }>(
      `/share/:token/photos/:photoId/${kind}`,
      async (request, reply) => {
        const share = await resolveShare(request.params.token);
        if (!share || !isLive(share)) return reply.code(404).send({ error: "Not found" });
        if (!isUuid(request.params.photoId)) return reply.code(404).send({ error: "Photo not found" });
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
