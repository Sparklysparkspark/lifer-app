// Public, revocable links onto an album's LIVE contents — read fresh at request time, never a
// frozen snapshot of what was in the album when the link was created (see 071_albums_and_shares.sql).
//
// Everything below the "public routes" marker deliberately never attaches `requireAuth` and
// never touches `request.user` — this file is kept separate from every other route module
// specifically so it's obvious at a glance which routes are intentionally unauthenticated. GPS
// is never included in any response here, full stop, no toggle for it — see the plan this was
// built from for why (a public link must never be able to leak a rare species' location).
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireScope } from "../auth/session.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { isRateLimited, recordAttempt } from "../auth/rateLimiter.js";
import { COOKIE_SECURE } from "../config.js";

interface CreateShareBody {
  password?: string;
  allowDownload?: boolean;
  showMetadata?: boolean;
  expiresAt?: string | null;
}

// A dummy hash to run verifyPassword against when a share/token doesn't exist or has no
// password — same non-distinguishing-timing trick auth/routes.ts's own login route uses, so a
// missing-token response and a wrong-password response can't be told apart by response timing.
const DUMMY_HASH = "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// Ephemeral unlock grants for password-protected shares — same in-memory, not-persisted-across-
// restart pattern as trips/routes.ts's own scanJobs map. Losing this on a restart just means a
// visitor re-enters the password, not data loss, so a DB table would be overkill here.
const UNLOCK_TTL_MS = 24 * 60 * 60 * 1000;
const unlockGrants = new Map<string, { token: string; expiresAt: number }>();
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

function hasValidUnlock(request: { cookies: Record<string, string | undefined> }, token: string): boolean {
  const grantId = request.cookies[UNLOCK_COOKIE_NAME];
  if (!grantId) return false;
  const grant = unlockGrants.get(grantId);
  if (!grant || grant.expiresAt < Date.now() || grant.token !== token) return false;
  return true;
}

export async function albumShareRoutes(app: FastifyInstance): Promise<void> {
  // ---- Owner-side (authenticated) ----

  app.post<{ Params: { id: string }; Body: CreateShareBody }>(
    "/albums/:id/shares",
    { preHandler: requireScope("share.write") },
    async (request, reply) => {
      const albumRes = await pool.query(`SELECT 1 FROM albums WHERE id = $1 AND user_id = $2`, [
        request.params.id,
        request.user!.id,
      ]);
      if (albumRes.rows.length === 0) return reply.code(404).send({ error: "Album not found" });

      const { password, allowDownload, showMetadata, expiresAt } = request.body ?? {};
      const token = randomBytes(32).toString("base64url");
      const passwordHash = password ? await hashPassword(password) : null;

      const res = await pool.query(
        `INSERT INTO shared_links (album_id, token, password_hash, allow_download, show_metadata, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, token, allow_download, show_metadata, expires_at, created_at`,
        [request.params.id, token, passwordHash, !!allowDownload, !!showMetadata, expiresAt || null],
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
    // Revoking (not deleting) preserves an audit trail, same spirit as the trash system's
    // soft-delete — and the ownership check joins through albums since shared_links has no
    // user_id column of its own.
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

    if (share.password_hash && !hasValidUnlock(request, request.params.token)) {
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
        // Camera EXIF only when the owner opted in — GPS was never selected by the query above,
        // so there is nothing location-bearing to accidentally include here regardless of this
        // flag.
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
      const rateLimitKey = `${request.params.token}:${request.ip}`;
      if (isRateLimited(rateLimitKey)) {
        return reply.code(429).send({ error: "Too many attempts. Try again later." });
      }
      recordAttempt(rateLimitKey);

      const share = await resolveShare(request.params.token);
      const validPassword = await verifyPassword(share?.password_hash ?? DUMMY_HASH, request.body?.password ?? "");
      if (!share || !isLive(share) || !share.password_hash || !validPassword) {
        return reply.code(401).send({ error: "Incorrect password" });
      }

      const grantId = randomBytes(32).toString("base64url");
      const expiresAt = Date.now() + UNLOCK_TTL_MS;
      unlockGrants.set(grantId, { token: request.params.token, expiresAt });
      reply.setCookie(UNLOCK_COOKIE_NAME, grantId, {
        httpOnly: true,
        secure: COOKIE_SECURE,
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
        if (share.password_hash && !hasValidUnlock(request, request.params.token)) {
          return reply.code(401).send({ error: "This link is password-protected" });
        }

        const column = kind === "display" ? "p.display_path" : "p.thumb_path";
        const res = await pool.query<{ path: string }>(
          `SELECT ${column} AS path
           FROM album_captures ac
           JOIN photos p ON p.capture_id = ac.capture_id
           WHERE ac.album_id = $1 AND p.id = $2`,
          [share.album_id, request.params.photoId],
        );
        const filePath = res.rows[0]?.path;
        if (!filePath || !existsSync(filePath)) return reply.code(404).send({ error: "Photo not found" });

        reply.header("Content-Type", "image/webp");
        // Only the display (not thumb) size is ever offered as an actual download, and only
        // when the owner opted in — still the same processed derivative every viewer already
        // sees inline, never the original/RAW file.
        if (kind === "display" && request.query.download === "1" && share.allow_download) {
          reply.header("Content-Disposition", `attachment; filename="${request.params.photoId}.webp"`);
        }
        return reply.send(createReadStream(filePath));
      },
    );
  }
}
