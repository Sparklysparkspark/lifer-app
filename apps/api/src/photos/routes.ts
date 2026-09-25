// Authenticated file streaming —security requirement, display/thumb
// paths are never served via a static mount. Every request is checked against ownership here.
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { rename } from "node:fs/promises";
import sharp from "sharp";
import { contentDisposition, parseRange } from "../lib/httpFile.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { pool } from "../db.js";
import { requireAuth, requireScope } from "../auth/session.js";
import { signedS3Url } from "../photoSources/s3.js";
import { resolveOriginalPath } from "../storageVolumes/resolve.js";
import { APP_DATA_DIR } from "../config.js";
import { generateDerivatives } from "../uploads/image.js";
import { ensureDefaultCardCrop } from "../collection/defaultCardCrop.js";
import { ensureDir } from "../lib/safeFs.js";

// A 1,024px copy for grid tiles. The 400px thumbnail looks soft on a high-density screen and the
// 2,560px display image is several times more than a tile needs, so grids asked for the display
// image and downloaded far too much. Made from the display image the first time it's asked for
// and kept in APP_DATA_DIR/medium, so existing libraries get it without a backfill. Rebuilt when
// the display image is newer (a re-crop or rotate). At most two are made at once, so a first
// scroll through a big gallery doesn't flood a NAS CPU.
const MEDIUM_WIDTH = 1024;
let mediumSlots = 2;
const mediumQueue: Array<() => void> = [];
const mediumInFlight = new Map<string, Promise<string>>();

async function mediumDerivative(photoId: string, displayPath: string): Promise<string> {
  const target = path.join(APP_DATA_DIR, "medium", `${photoId}.webp`);
  try {
    if (statSync(target).mtimeMs >= statSync(displayPath).mtimeMs) return target;
  } catch {
    // not made yet
  }
  const pending = mediumInFlight.get(photoId);
  if (pending) return pending;
  const job = (async () => {
    if (mediumSlots === 0) await new Promise<void>((resolve) => mediumQueue.push(resolve));
    mediumSlots--;
    try {
      await ensureDir(path.dirname(target));
      const tmp = `${target}.${process.pid}.tmp`;
      await sharp(displayPath).resize({ width: MEDIUM_WIDTH, withoutEnlargement: true }).webp({ quality: 80 }).toFile(tmp);
      await rename(tmp, target);
      return target;
    } catch {
      return displayPath; // can't make one: the display image still works
    } finally {
      mediumSlots++;
      mediumQueue.shift()?.();
    }
  })().finally(() => mediumInFlight.delete(photoId));
  mediumInFlight.set(photoId, job);
  return job;
}

// Photos were sent with no caching headers, so the browser downloaded every thumbnail again on
// each visit. The ETag (size and modified time) lets it ask "still the same?" and get an empty
// 304 instead; no-cache keeps a re-cropped photo from showing stale.
function sendCachedImage(request: FastifyRequest, reply: FastifyReply, filePath: string) {
  const st = statSync(filePath);
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  reply.header("ETag", etag);
  reply.header("Last-Modified", st.mtime.toUTCString());
  reply.header("Cache-Control", "private, no-cache");
  if (request.headers["if-none-match"] === etag) return reply.code(304).send();
  reply.header("Content-Type", "image/webp");
  reply.header("Content-Length", st.size);
  return reply.send(createReadStream(filePath));
}

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

async function resolveOriginal(
  photoId: string,
  userId: string,
  kind: "jpeg" | "raw" | "video" = "jpeg",
): Promise<ResolvedOriginalRef | null> {
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

// A photo's thumb/display file can go missing while its row still points at it: a derivatives
// move that stopped between moving files and rewriting rows (migrateDerivativesLocation), or a
// cleared app cache. Without this the species card for that photo stayed blank forever. Tries,
// in order: the file already sitting at its canonical path (just fix the row), then rebuilding
// both files from the JPEG original. Images only; video posters come from a separate pipeline.
const healing = new Map<string, Promise<boolean>>();

async function healDerivatives(photoId: string, userId: string): Promise<boolean> {
  const inFlight = healing.get(photoId);
  if (inFlight) return inFlight;
  const job = (async () => {
    const canonical = {
      display: path.join(APP_DATA_DIR, "display", `${photoId}.webp`),
      thumb: path.join(APP_DATA_DIR, "thumb", `${photoId}.webp`),
    };
    if (existsSync(canonical.display) && existsSync(canonical.thumb)) {
      await pool.query(`UPDATE photos SET display_path = $2, thumb_path = $3 WHERE id = $1`, [photoId, canonical.display, canonical.thumb]);
      return true;
    }
    const kindRes = await pool.query<{ kind: string }>(
      `SELECT p.kind FROM photos p JOIN captures c ON c.id = p.capture_id WHERE p.id = $1 AND c.user_id = $2`,
      [photoId, userId],
    );
    if (kindRes.rows[0]?.kind === "video") return false;
    const original = await resolveOriginal(photoId, userId, "jpeg");
    if (!original || original.refType !== "path" || !original.connected || !original.ref || !existsSync(original.ref)) return false;
    try {
      const out = await generateDerivatives(readFileSync(original.ref), photoId);
      await pool.query(`UPDATE photos SET display_path = $2, thumb_path = $3 WHERE id = $1`, [photoId, out.displayPath, out.thumbPath]);
      return true;
    } catch (err) {
      console.warn(`[photos] couldn't rebuild derivatives for ${photoId}:`, err);
      return false;
    }
  })().finally(() => healing.delete(photoId));
  healing.set(photoId, job);
  return job;
}

// Last resort when a featured photo can't be shown at all: feature the best other photo of that
// species that still has a thumbnail (crop cleared, it was framed for the old photo), or fall
// back to the reference photo if there's none. Same shape as the repoint on delete in
// captures/routes.ts.
async function replaceUnshowableCover(photoId: string, userId: string): Promise<void> {
  const covers = await pool.query<{ species_id: string }>(
    `SELECT species_id FROM user_species WHERE user_id = $1 AND cover_photo_id = $2`,
    [userId, photoId],
  );
  for (const { species_id } of covers.rows) {
    const candidates = await pool.query<{ id: string; thumb_path: string }>(
      `SELECT p.id, p.thumb_path
       FROM photos p
       JOIN captures c ON c.id = p.capture_id
       WHERE c.user_id = $1 AND c.species_id = $2 AND p.id <> $3 AND p.thumb_path IS NOT NULL
       ORDER BY c.quality_rating DESC NULLS LAST, c.taken_at DESC NULLS LAST
       LIMIT 50`,
      [userId, species_id, photoId],
    );
    const next = candidates.rows.find((r) => existsSync(r.thumb_path)) ?? null;
    await pool.query(
      `UPDATE user_species SET cover_photo_id = $1, card_crop_x = NULL, card_crop_y = NULL, card_crop_size = NULL
       WHERE user_id = $2 AND species_id = $3 AND cover_photo_id = $4`,
      [next?.id ?? null, userId, species_id, photoId],
    );
    if (next) await ensureDefaultCardCrop(userId, species_id);
  }
}

async function resolveVideoPreviewPath(photoId: string, userId: string): Promise<string | null> {
  const res = await pool.query<{ preview_path: string | null }>(
    `SELECT p.preview_path
     FROM photos p
     JOIN captures c ON c.id = p.capture_id
     WHERE p.id = $1 AND c.user_id = $2 AND p.kind = 'video'`,
    [photoId, userId],
  );
  return res.rows[0]?.preview_path ?? null;
}

// Streams a local file with HTTP Range support (206 Partial Content) — needed for video
// scrubbing/seeking, which the plain full-file streaming the other routes here use doesn't
// support. Kept generic (not video-specific) in case another large-file route ever needs it.
//
// Every branch must `return reply.send(...)` (not call it and fall through) — an async Fastify
// handler that doesn't return its reply.send() call has its own resolved value (undefined)
// race the stream, and Fastify ends up sending a 0-byte response with a stale/absent
// Content-Length despite the stream itself never erroring.
function sendRangeableFile(request: FastifyRequest, reply: FastifyReply, filePath: string, contentType: string): FastifyReply {
  const stat = statSync(filePath);
  const range = request.headers.range as string | undefined;
  reply.header("Accept-Ranges", "bytes");
  reply.header("Content-Type", contentType);

  if (!range) {
    reply.header("Content-Length", stat.size);
    return reply.send(createReadStream(filePath));
  }

  const parsed = parseRange(range, stat.size);
  if (parsed.kind === "unsatisfiable") {
    return reply.code(416).header("Content-Range", `bytes */${stat.size}`).send();
  }
  if (parsed.kind === "full") {
    reply.header("Content-Length", stat.size);
    return reply.send(createReadStream(filePath));
  }
  const { start, end } = parsed;
  reply.code(206);
  reply.header("Content-Range", `bytes ${start}-${end}/${stat.size}`);
  reply.header("Content-Length", end - start + 1);
  return reply.send(createReadStream(filePath, { start, end }));
}

export async function photoRoutes(app: FastifyInstance): Promise<void> {
  for (const kind of ["display", "medium", "thumb"] as const) {
    app.get<{ Params: { id: string } }>(`/photos/:id/${kind}`, { preHandler: requireScope("photos.read") }, async (request, reply) => {
      const userId = request.user!.id;
      const sourceKind = kind === "medium" ? "display" : kind;
      let filePath = await resolvePhotoPath(request.params.id, userId, sourceKind);
      if (filePath && !existsSync(filePath)) {
        filePath = (await healDerivatives(request.params.id, userId)) ? await resolvePhotoPath(request.params.id, userId, sourceKind) : null;
        if (!filePath) await replaceUnshowableCover(request.params.id, userId);
      }
      if (!filePath || !existsSync(filePath)) {
        return reply.code(404).send({ error: "Photo not found" });
      }
      if (kind === "medium") filePath = await mediumDerivative(request.params.id, filePath);
      return sendCachedImage(request, reply, filePath);
    });
  }

  // Inline by default (usable directly as an <img src> for the lightbox/crop editor);
  // ?download=1 adds Content-Disposition so it saves instead of navigating in-browser.
  app.get<{ Params: { id: string }; Querystring: { download?: string } }>(
    "/photos/:id/original",
    { preHandler: requireScope("photos.read") },
    async (request, reply) => {
      const original = await resolveOriginal(request.params.id, request.user!.id, "jpeg");
      if (!original) return reply.code(404).send({ error: "Original not found" });

      if (original.refType === "s3") {
        // ResponseContentDisposition on the presigned URL itself is the only way to make S3
        // serve this as a download — see signedS3Url's own comment on why a header set on THIS
        // response never reaches the client for a redirect target.
        const downloadFilename = request.query.download === "1" ? path.basename(original.ref!) : undefined;
        return reply.redirect(await signedS3Url(original.ref!, downloadFilename));
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
        reply.header("Content-Disposition", contentDisposition(path.basename(original.ref)));
      }
      return reply.send(createReadStream(original.ref));
    },
  );

  // Same shape as the JPEG route above, just the 'raw' kind original — mirrors an existing
  // capture, not the "just uploaded" standalone RAW path in uploads/routes.ts.
  app.get<{ Params: { id: string }; Querystring: { download?: string } }>(
    "/photos/:id/original-raw",
    { preHandler: requireScope("photos.read") },
    async (request, reply) => {
      const original = await resolveOriginal(request.params.id, request.user!.id, "raw");
      if (!original) return reply.code(404).send({ error: "No RAW original for this photo" });

      if (original.refType === "s3") {
        const downloadFilename = request.query.download === "1" ? path.basename(original.ref!) : undefined;
        return reply.redirect(await signedS3Url(original.ref!, downloadFilename));
      }

      if (!original.connected) {
        return reply.code(409).send({ error: "This RAW's drive isn't connected right now", volumeLabel: original.volumeLabel });
      }
      if (!original.ref || !existsSync(original.ref)) {
        return reply.code(404).send({ error: "RAW original not found" });
      }
      reply.header("Content-Type", "application/octet-stream");
      if (request.query.download === "1") {
        reply.header("Content-Disposition", contentDisposition(path.basename(original.ref)));
      }
      return reply.send(createReadStream(original.ref));
    },
  );

  // Playback route — prefers the transcoded preview (photos.preview_path) when one was
  // generated at upload time (see uploads/image.ts's generateVideoDerivatives); a source
  // that was already natively web-safe (H.264/AAC-in-MP4) has no preview and is served
  // directly from `originals`. Range support (sendRangeableFile) is what actually lets
  // Lightbox's <video> element scrub/seek — a plain full-file stream can only ever play
  // from the start.
  app.get<{ Params: { id: string } }>("/photos/:id/video", { preHandler: requireScope("photos.read") }, async (request, reply) => {
    const previewPath = await resolveVideoPreviewPath(request.params.id, request.user!.id);
    if (previewPath && existsSync(previewPath)) {
      return sendRangeableFile(request, reply, previewPath, "video/mp4");
    }

    const original = await resolveOriginal(request.params.id, request.user!.id, "video");
    if (!original) return reply.code(404).send({ error: "No video for this photo" });
    if (!original.connected) {
      return reply.code(409).send({ error: "This video's drive isn't connected right now", volumeLabel: original.volumeLabel });
    }
    if (!original.ref || !existsSync(original.ref)) {
      return reply.code(404).send({ error: "Video not found" });
    }
    const contentType = original.ref.toLowerCase().endsWith(".mov") ? "video/quicktime" : "video/mp4";
    return sendRangeableFile(request, reply, original.ref, contentType);
  });
}
