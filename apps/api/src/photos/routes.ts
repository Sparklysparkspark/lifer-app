// Authenticated file streaming. For security, display/thumb files are never served from a static
// mount; every request is checked against ownership here.
import { createReadStream, existsSync, type Stats } from "node:fs";
import path from "node:path";
import { rename } from "node:fs/promises";
import sharp from "sharp";
import { contentDisposition, parseRange } from "../lib/httpFile.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { pool } from "@lifer/core/db.js";
import { Type } from "typebox";
import { IdParams, notFoundOnInvalidId, withSchemas } from "../lib/schema.js";
import { requireScope } from "../auth/session.js";
import { signedS3Url } from "../photoSources/s3.js";
import { resolveOriginalPath } from "../storageVolumes/resolve.js";
import { APP_DATA_DIR } from "@lifer/core/config.js";
import { generateDerivatives } from "@lifer/core/uploads/image.js";
import { PHOTO_FORMATS, photoFormatFor } from "@lifer/core/uploads/formats.js";
import { ensureDefaultCardCrop } from "../collection/defaultCardCrop.js";
import { ensureDir } from "@lifer/core/lib/safeFs.js";
import { applyFileValidators, rangeStillValid, sendCachedImage, statFile } from "../lib/cachedFile.js";
import { log } from "@lifer/core/lib/log.js";

// A 1,024px copy for grid tiles: the thumbnail is soft on dense screens and the display image is
// too big. Made from the display image on first request and kept in APP_DATA_DIR/medium, rebuilt
// when the display image is newer. At most two are made at once.
const MEDIUM_WIDTH = 1024;
let mediumSlots = 2;
const mediumQueue: Array<() => void> = [];
const mediumInFlight = new Map<string, Promise<string>>();
const mediumPath = (photoId: string) => path.join(APP_DATA_DIR, "medium", `${photoId}.webp`);

async function mediumDerivative(photoId: string, displayPath: string): Promise<string> {
  const target = mediumPath(photoId);
  const [tst, dst] = await Promise.all([statFile(target), statFile(displayPath)]);
  if (tst && dst && tst.mtimeMs >= dst.mtimeMs) return target;
  const pending = mediumInFlight.get(photoId);
  if (pending) return pending;
  const job = (async () => {
    if (mediumSlots === 0) await new Promise<void>((resolve) => mediumQueue.push(resolve));
    mediumSlots--;
    try {
      await ensureDir(path.dirname(target));
      const tmp = `${target}.${process.pid}.tmp`;
      await sharp(displayPath)
        .resize({ width: MEDIUM_WIDTH, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toFile(tmp);
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

// The medium copy when it's current or can be made within a second; otherwise null and it keeps
// being made in the background while the caller serves the display image this once.
const MEDIUM_WAIT_MS = 1000;
async function mediumIfReady(
  photoId: string,
  displayPath: string,
  displaySt: Stats,
): Promise<{ path: string; st: Stats } | null> {
  const current = await statFile(mediumPath(photoId));
  if (current && current.mtimeMs >= displaySt.mtimeMs) return { path: mediumPath(photoId), st: current };
  let timer: NodeJS.Timeout | undefined;
  const made = await Promise.race([
    mediumDerivative(photoId, displayPath),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), MEDIUM_WAIT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  if (!made || made === displayPath) return null;
  const st = await statFile(made);
  return st ? { path: made, st } : null;
}

// Streams an original (JPEG or RAW) with a strong ETag, Last-Modified and 304 support.
function sendOriginalFile(
  request: FastifyRequest,
  reply: FastifyReply,
  filePath: string,
  st: Stats,
  contentType: string,
) {
  if (applyFileValidators(request, reply, st, { weak: false }).notModified) return reply.code(304).send();
  reply.header("Content-Type", contentType);
  reply.header("Content-Length", st.size);
  return reply.send(createReadStream(filePath));
}

// The other rendition of the same photo (thumb for display, display for thumb), when it exists
// on disk, to show while the missing one is repaired in the background.
async function siblingRendition(
  photoId: string,
  userId: string,
  kind: "display" | "thumb",
): Promise<{ path: string; st: Stats } | null> {
  const other = await resolvePhotoPath(photoId, userId, kind === "display" ? "thumb" : "display");
  const st = other ? await statFile(other) : null;
  return other && st ? { path: other, st } : null;
}

// The file routes below look photos up in captures_all, not the `captures` view: the view leaves
// out hidden and trashed photos, which their owner still sees in the Gallery's Hidden filter and
// on the Trash page. Ownership (user_id) is still checked on every lookup.
async function resolvePhotoPath(photoId: string, userId: string, kind: "display" | "thumb"): Promise<string | null> {
  const column = kind === "display" ? "p.display_path" : "p.thumb_path";
  const res = await pool.query<{ path: string }>(
    // captures_all (see ownedCaptures), so hidden and trashed photos still show to their owner.
    `SELECT ${column} AS path
     FROM photos p
     JOIN captures_all c ON c.id = p.capture_id
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
  // photos.id -> captures.id -> originals.capture_id: a capture has at most one original per kind.
  const res = await pool.query<{
    ref: string;
    ref_type: string;
    volume_id: string | null;
    volume_relative_path: string | null;
  }>(
    `SELECT o.ref, o.ref_type, o.volume_id, o.volume_relative_path
     FROM photos p
     JOIN captures_all c ON c.id = p.capture_id
     JOIN originals o ON o.capture_id = c.id
     WHERE p.id = $1 AND c.user_id = $2 AND o.kind = $3`,
    [photoId, userId, kind],
  );
  const row = res.rows[0];
  if (!row) return null;
  if (row.ref_type === "s3") return { ref: row.ref, refType: row.ref_type, connected: true };

  const resolved = await resolveOriginalPath({
    ref: row.ref,
    volume_id: row.volume_id,
    volume_relative_path: row.volume_relative_path,
  });
  return {
    ref: resolved.path,
    refType: row.ref_type,
    connected: resolved.connected,
    volumeLabel: resolved.volumeLabel,
  };
}

// Recovers a photo whose thumb/display file is missing while its row points at it: use a file
// already at its canonical path, else rebuild both from the JPEG original. Images only.
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
      await pool.query(`UPDATE photos SET display_path = $2, thumb_path = $3 WHERE id = $1`, [
        photoId,
        canonical.display,
        canonical.thumb,
      ]);
      return true;
    }
    const kindRes = await pool.query<{ kind: string }>(
      `SELECT p.kind FROM photos p JOIN captures_all c ON c.id = p.capture_id WHERE p.id = $1 AND c.user_id = $2`,
      [photoId, userId],
    );
    if (kindRes.rows[0]?.kind === "video") return false;
    const original = await resolveOriginal(photoId, userId, "jpeg");
    if (!original || original.refType !== "path" || !original.connected || !original.ref || !existsSync(original.ref))
      return false;
    try {
      // By path, so a huge original is decoded top to bottom rather than read into memory.
      const out = await generateDerivatives(original.ref, photoId);
      await pool.query(`UPDATE photos SET display_path = $2, thumb_path = $3 WHERE id = $1`, [
        photoId,
        out.displayPath,
        out.thumbPath,
      ]);
      return true;
    } catch (err) {
      log.warn({ err }, `[photos] couldn't rebuild derivatives for ${photoId}`);
      return false;
    }
  })().finally(() => healing.delete(photoId));
  healing.set(photoId, job);
  return job;
}

// Last resort when a featured photo can't be shown at all: feature the best other photo of that
// species that still has a thumbnail (crop cleared, it was framed for the old photo), or fall
// back to the reference photo if there's none. Same shape as the repoint on delete in
// captures/trash.ts.
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
     JOIN captures_all c ON c.id = p.capture_id
     WHERE p.id = $1 AND c.user_id = $2 AND p.kind = 'video'`,
    [photoId, userId],
  );
  return res.rows[0]?.preview_path ?? null;
}

// Streams a file with Range support (206), which video seeking needs.
// Every branch must return reply.send(...): an async handler that doesn't return it races the
// stream and Fastify sends an empty response.
function sendRangeableFile(
  request: FastifyRequest,
  reply: FastifyReply,
  filePath: string,
  stat: Stats,
  contentType: string,
): FastifyReply {
  const { notModified, etag } = applyFileValidators(request, reply, stat, { weak: false });
  if (notModified) return reply.code(304).send();
  const range = rangeStillValid(request, stat, etag) ? (request.headers.range as string | undefined) : undefined;
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

// Only "1" asks for a download; "0" is accepted as the explicit default.
const DownloadQuery = Type.Object({
  download: Type.Optional(Type.Enum(["0", "1"], { description: "1 to set Content-Disposition: attachment" })),
});

export async function photoRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  for (const kind of ["display", "medium", "thumb"] as const) {
    app.get(
      `/photos/:id/${kind}`,
      {
        preValidation: requireScope("photos.read"),
        config: notFoundOnInvalidId("Photo not found"),
        schema: { params: IdParams },
      },
      async (request, reply) => {
        const userId = request.user!.id;
        const photoId = request.params.id;
        const sourceKind = kind === "medium" ? "display" : kind;
        let filePath = await resolvePhotoPath(photoId, userId, sourceKind);
        let st = filePath ? await statFile(filePath) : null;
        let standIn = false;
        if (filePath && !st) {
          const sibling = await siblingRendition(photoId, userId, sourceKind);
          if (sibling) {
            // Show the other rendition now; the repair (deduplicated per photo) runs behind it.
            ({ path: filePath, st } = sibling);
            standIn = true;
            void healDerivatives(photoId, userId)
              .then((ok) => (ok ? undefined : replaceUnshowableCover(photoId, userId)))
              .catch((err) => log.warn({ err }, `[photos] background repair failed for ${photoId}`));
          } else {
            filePath = (await healDerivatives(photoId, userId))
              ? await resolvePhotoPath(photoId, userId, sourceKind)
              : null;
            if (!filePath) await replaceUnshowableCover(photoId, userId);
            st = filePath ? await statFile(filePath) : null;
          }
        }
        if (!filePath || !st) {
          return reply.code(404).send({ error: "Photo not found" });
        }
        if (kind === "medium" && !standIn) {
          const medium = await mediumIfReady(photoId, filePath, st);
          if (medium) ({ path: filePath, st } = medium);
          else standIn = true;
        }
        return sendCachedImage(request, reply, filePath, st, { standIn });
      },
    );
  }

  // Inline by default (usable directly as an <img src> for the lightbox/crop editor);
  // ?download=1 adds Content-Disposition so it saves instead of navigating in-browser.
  app.get(
    "/photos/:id/original",
    {
      preValidation: requireScope("photos.read"),
      config: notFoundOnInvalidId("Original not found"),
      schema: { params: IdParams, querystring: DownloadQuery },
    },
    async (request, reply) => {
      const original = await resolveOriginal(request.params.id, request.user!.id, "jpeg");
      if (!original) return reply.code(404).send({ error: "Original not found" });

      if (original.refType === "s3") {
        // Only ResponseContentDisposition on the presigned URL makes S3 serve a download; a
        // header on this redirect response never reaches the client.
        const downloadFilename = request.query.download === "1" ? path.basename(original.ref!) : undefined;
        return reply.redirect(await signedS3Url(original.ref!, downloadFilename));
      }

      if (!original.connected) {
        // 409, not 404: the file isn't missing, its drive isn't connected. volumeLabel names the drive.
        return reply
          .code(409)
          .send({ error: "This photo's drive isn't connected right now", volumeLabel: original.volumeLabel });
      }
      const st = original.ref ? await statFile(original.ref) : null;
      if (!original.ref || !st) {
        return reply.code(404).send({ error: "Original not found" });
      }
      if (request.query.download === "1") {
        // The file on disk is named after the original file, so its basename is the download name.
        reply.header("Content-Disposition", contentDisposition(path.basename(original.ref)));
      }
      // The "jpeg" original is any edited photo format (PNG, WebP, TIFF, HEIC too).
      const format = photoFormatFor(original.ref);
      return sendOriginalFile(
        request,
        reply,
        original.ref,
        st,
        format ? PHOTO_FORMATS[format].mimeTypes[0] : "application/octet-stream",
      );
    },
  );

  // Same as the JPEG route above, for the capture's 'raw' original.
  app.get(
    "/photos/:id/original-raw",
    {
      preValidation: requireScope("photos.read"),
      config: notFoundOnInvalidId("No RAW original for this photo"),
      schema: { params: IdParams, querystring: DownloadQuery },
    },
    async (request, reply) => {
      const original = await resolveOriginal(request.params.id, request.user!.id, "raw");
      if (!original) return reply.code(404).send({ error: "No RAW original for this photo" });

      if (original.refType === "s3") {
        const downloadFilename = request.query.download === "1" ? path.basename(original.ref!) : undefined;
        return reply.redirect(await signedS3Url(original.ref!, downloadFilename));
      }

      if (!original.connected) {
        return reply
          .code(409)
          .send({ error: "This RAW's drive isn't connected right now", volumeLabel: original.volumeLabel });
      }
      const st = original.ref ? await statFile(original.ref) : null;
      if (!original.ref || !st) {
        return reply.code(404).send({ error: "RAW original not found" });
      }
      if (request.query.download === "1") {
        reply.header("Content-Disposition", contentDisposition(path.basename(original.ref)));
      }
      return sendOriginalFile(request, reply, original.ref, st, "application/octet-stream");
    },
  );

  // Playback: the transcoded preview when one exists, else the original (already web-safe). Range
  // support is what lets the player seek.
  app.get(
    "/photos/:id/video",
    {
      preValidation: requireScope("photos.read"),
      config: notFoundOnInvalidId("No video for this photo"),
      schema: { params: IdParams },
    },
    async (request, reply) => {
      const previewPath = await resolveVideoPreviewPath(request.params.id, request.user!.id);
      const previewSt = previewPath ? await statFile(previewPath) : null;
      if (previewPath && previewSt) {
        return sendRangeableFile(request, reply, previewPath, previewSt, "video/mp4");
      }

      const original = await resolveOriginal(request.params.id, request.user!.id, "video");
      if (!original) return reply.code(404).send({ error: "No video for this photo" });
      if (!original.connected) {
        return reply
          .code(409)
          .send({ error: "This video's drive isn't connected right now", volumeLabel: original.volumeLabel });
      }
      const st = original.ref ? await statFile(original.ref) : null;
      if (!original.ref || !st) {
        return reply.code(404).send({ error: "Video not found" });
      }
      const contentType = original.ref.toLowerCase().endsWith(".mov") ? "video/quicktime" : "video/mp4";
      return sendRangeableFile(request, reply, original.ref, st, contentType);
    },
  );
}
