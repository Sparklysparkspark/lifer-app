// Authenticated file streaming — per lifer-spec.md §8 security requirement, display/thumb
// paths are never served via a static mount. Every request is checked against ownership here.
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireAuth } from "../auth/session.js";
import { signedS3Url } from "../photoSources/s3.js";
import { resolveOriginalPath } from "../storageVolumes/resolve.js";

async function resolvePhotoPath(photoId: string, userId: string, kind: "display" | "thumb"): Promise<string | null> {
  const column = kind === "display" ? "p.display_path" : "p.thumb_path";
  const res = await pool.query<{ path: string }>(
    `SELECT ${column} AS path
     FROM photos p
     JOIN captures c ON c.id = p.capture_id
     WHERE p.id = $1 AND c.user_id = $2`,
    [photoId, userId],
  );
  return res.rows[0]?.path ?? null;
}

interface ResolvedOriginalRef {
  ref: string | null;
  refType: string;
  connected: boolean;
  volumeLabel?: string;
}

async function resolveOriginal(photoId: string, userId: string, kind: "jpeg" | "raw" = "jpeg"): Promise<ResolvedOriginalRef | null> {
  // photos.id -> captures.id -> originals.capture_id (originals is keyed by capture, since a
  // capture has at most one original per kind, independent of which rendition is "current").
  const res = await pool.query<{
    ref: string;
    ref_type: string;
    volume_id: string | null;
    volume_relative_path: string | null;
  }>(
    `SELECT o.ref, o.ref_type, o.volume_id, o.volume_relative_path
     FROM photos p
     JOIN captures c ON c.id = p.capture_id
     JOIN originals o ON o.capture_id = c.id
     WHERE p.id = $1 AND c.user_id = $2 AND o.kind = $3`,
    [photoId, userId, kind],
  );
  const row = res.rows[0];
  if (!row) return null;
  if (row.ref_type === "s3") return { ref: row.ref, refType: row.ref_type, connected: true };

  const resolved = await resolveOriginalPath({ ref: row.ref, volume_id: row.volume_id, volume_relative_path: row.volume_relative_path });
  return { ref: resolved.path, refType: row.ref_type, connected: resolved.connected, volumeLabel: resolved.volumeLabel };
}

export async function photoRoutes(app: FastifyInstance): Promise<void> {
  for (const kind of ["display", "thumb"] as const) {
    app.get<{ Params: { id: string } }>(`/photos/:id/${kind}`, { preHandler: requireAuth }, async (request, reply) => {
      const filePath = await resolvePhotoPath(request.params.id, request.user!.id, kind);
      if (!filePath || !existsSync(filePath)) {
        return reply.code(404).send({ error: "Photo not found" });
      }
      reply.header("Content-Type", "image/webp");
      return reply.send(createReadStream(filePath));
    });
  }

  // Inline by default (usable directly as an <img src> for the lightbox/crop editor);
  // ?download=1 adds Content-Disposition so it saves instead of navigating in-browser.
  app.get<{ Params: { id: string }; Querystring: { download?: string } }>(
    "/photos/:id/original",
    { preHandler: requireAuth },
    async (request, reply) => {
      const original = await resolveOriginal(request.params.id, request.user!.id, "jpeg");
      if (!original) return reply.code(404).send({ error: "Original not found" });

      if (original.refType === "s3") {
        // A signed URL is time-limited and only usable directly, so ?download=1 can't add a
        // Content-Disposition header here the way the local-file branch does below.
        return reply.redirect(await signedS3Url(original.ref!));
      }

      if (!original.connected) {
        // 409 (not 404) — the file isn't missing, its drive just isn't plugged in right now.
        // volumeLabel lets the client tell the user exactly which drive to go grab, instead of
        // a generic "not found" that reads as data loss.
        return reply.code(409).send({ error: "This photo's drive isn't connected right now", volumeLabel: original.volumeLabel });
      }
      if (!original.ref || !existsSync(original.ref)) {
        return reply.code(404).send({ error: "Original not found" });
      }
      reply.header("Content-Type", "image/jpeg");
      if (request.query.download === "1") {
        // Previously this sent the photo's own UUID as the download filename, discarding the
        // real one. Store/link mode both already name the file on disk after the original
        // filename (see uploads/routes.ts's originalFilename helper), so its basename is the
        // real name and can be reused directly.
        reply.header("Content-Disposition", `attachment; filename="${path.basename(original.ref)}"`);
      }
      return reply.send(createReadStream(original.ref));
    },
  );

  // Same shape as the JPEG route above, just the 'raw' kind original — mirrors an existing
  // capture, not the "just uploaded" standalone RAW path in uploads/routes.ts.
  app.get<{ Params: { id: string }; Querystring: { download?: string } }>(
    "/photos/:id/original-raw",
    { preHandler: requireAuth },
    async (request, reply) => {
      const original = await resolveOriginal(request.params.id, request.user!.id, "raw");
      if (!original) return reply.code(404).send({ error: "No RAW original for this photo" });

      if (original.refType === "s3") {
        return reply.redirect(await signedS3Url(original.ref!));
      }

      if (!original.connected) {
        return reply.code(409).send({ error: "This RAW's drive isn't connected right now", volumeLabel: original.volumeLabel });
      }
      if (!original.ref || !existsSync(original.ref)) {
        return reply.code(404).send({ error: "RAW original not found" });
      }
      reply.header("Content-Type", "application/octet-stream");
      if (request.query.download === "1") {
        reply.header("Content-Disposition", `attachment; filename="${path.basename(original.ref)}"`);
      }
      return reply.send(createReadStream(original.ref));
    },
  );
}
