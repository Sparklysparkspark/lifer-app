// A featured photo cut to the user's crop, for a paired phone: a species card, an album cover or a
// trip cover as a 1024 px square WebP (a 2-column card at 3x, and the species hero). The phone used
// to crop the 400 px thumbnail, which looks rough. Cut from the display image, or from the original
// (a RAW through its preview) when the crop is too small to fill 1024 px of the display image.
// Kept in APP_DATA_DIR/square, one file per photo, crop and size; a new crop replaces the old files.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { APP_DATA_DIR } from "@lifer/core/config.js";
import { ensureDir } from "@lifer/core/lib/safeFs.js";
import { originalSharpOptions } from "@lifer/core/lib/imageLimits.js";
import { requireScope } from "../auth/session.js";
import { statFile } from "../lib/cachedFile.js";
import { withSchemas } from "../lib/schema.js";
import { fullRender, isJpegPath } from "../photos/fullRender.js";
import { resolveOriginal, resolvePhotoPath } from "../photos/routes.js";

export const SQUARE_SIDE = 1024;
const scope = requireScope("sync", ["companion"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = "regexp_replace(s.scientific_name, '[^A-Za-z0-9-]', '_', 'g')";

export interface SquareCrop {
  x: number;
  y: number;
  size: number;
}

const dir = () => path.join(APP_DATA_DIR, "square");
const key = (photoId: string, crop: SquareCrop | null) =>
  createHash("sha1")
    .update(`${photoId}|${crop ? `${crop.x}|${crop.y}|${crop.size}` : "centre"}|${SQUARE_SIDE}`)
    .digest("hex")
    .slice(0, 24);

/** The strong ETag: changes with the photo, the crop or the size. */
export const squareEtag = (photoId: string, crop: SquareCrop | null) => `"${key(photoId, crop)}"`;

let slots = 2;
const waiting: Array<() => void> = [];
const inFlight = new Map<string, Promise<string | null>>();

async function orientedSize(file: string): Promise<{ width: number; height: number } | null> {
  const m = await sharp(file, originalSharpOptions()).metadata();
  if (!m.width || !m.height) return null;
  return (m.orientation ?? 1) >= 5 ? { width: m.height, height: m.width } : { width: m.width, height: m.height };
}

/** The picture to cut from: the display image, unless the crop is too small to fill the square
 *  from it and an original (connected drive) is bigger. */
async function bestSource(photoId: string, userId: string, display: string, crop: SquareCrop | null) {
  const shown = await orientedSize(display);
  if (!shown) return null;
  const cutPx = crop ? (crop.size / 100) * shown.width : Math.min(shown.width, shown.height);
  if (cutPx >= SQUARE_SIDE) return { file: display, ...shown };
  for (const kind of ["jpeg", "raw"] as const) {
    const original = await resolveOriginal(photoId, userId, kind);
    if (!original?.connected || !original.ref || !(await statFile(original.ref))) continue;
    const file = kind === "jpeg" && isJpegPath(original.ref) ? original.ref : await fullRender(photoId, original.ref, kind === "raw");
    const size = file ? await orientedSize(file).catch(() => null) : null;
    if (file && size && size.width > shown.width) return { file, ...size };
  }
  return { file: display, ...shown };
}

async function squareFile(photoId: string, userId: string, display: string, crop: SquareCrop | null): Promise<string | null> {
  const name = key(photoId, crop);
  const target = path.join(dir(), `${photoId}_${name}.webp`);
  const [made, shown] = await Promise.all([statFile(target), statFile(display)]);
  if (made && shown && made.mtimeMs >= shown.mtimeMs) return target;
  const pending = inFlight.get(target);
  if (pending) return pending;
  const job = (async () => {
    if (slots === 0) await new Promise<void>((resolve) => waiting.push(resolve));
    slots--;
    try {
      const src = await bestSource(photoId, userId, display, crop);
      if (!src) return null;
      const { width, height } = src;
      const cut = Math.max(1, Math.min(crop ? Math.round((crop.size / 100) * width) : Math.min(width, height), width, height));
      const left = crop ? Math.min(Math.max(0, Math.round((crop.x / 100) * width)), width - cut) : Math.floor((width - cut) / 2);
      const top = crop ? Math.min(Math.max(0, Math.round((crop.y / 100) * width)), height - cut) : Math.floor((height - cut) / 2);
      await ensureDir(dir());
      const tmp = `${target}.${process.pid}.tmp`;
      await sharp(src.file, originalSharpOptions())
        .rotate()
        .extract({ left, top, width: cut, height: cut })
        .resize({ width: SQUARE_SIDE, height: SQUARE_SIDE, withoutEnlargement: true })
        .webp({ quality: 82 })
        .toFile(tmp);
      await rename(tmp, target);
      // The photo's earlier crops are no longer shown.
      const old = (await readdir(dir())).filter((f) => f.startsWith(`${photoId}_`) && f !== path.basename(target) && !f.endsWith(".tmp"));
      await Promise.all(old.map((f) => rm(path.join(dir(), f), { force: true })));
      return target;
    } catch {
      return null;
    } finally {
      slots++;
      waiting.shift()?.();
    }
  })().finally(() => inFlight.delete(target));
  inFlight.set(target, job);
  return job;
}

const toCrop = (x: unknown, y: unknown, size: unknown): SquareCrop | null =>
  x != null && y != null && size != null && Number(size) > 0 ? { x: Number(x), y: Number(y), size: Number(size) } : null;

/** The user's crop for this owner, when the photo shown is the cover it was framed for. */
async function cropFor(kind: "species" | "album" | "trip", id: string, userId: string, photoId: string): Promise<SquareCrop | null> {
  if (kind === "species") {
    const r = await pool.query(
      `SELECT us.card_crop_x x, us.card_crop_y y, us.card_crop_size size FROM user_species us JOIN species s ON s.id = us.species_id
        WHERE us.user_id = $1 AND ${SLUG} = $2 AND us.cover_photo_id = $3`,
      [userId, id, photoId],
    );
    return r.rows[0] ? toCrop(r.rows[0].x, r.rows[0].y, r.rows[0].size) : null;
  }
  if (!UUID.test(id)) return null;
  const r =
    kind === "album"
      ? await pool.query(
          `SELECT cover_crop_x x, cover_crop_y y, cover_crop_size size FROM albums WHERE id = $1 AND user_id = $2 AND cover_photo_id = $3`,
          [id, userId, photoId],
        )
      : await pool.query(
          `SELECT t.cover_crop_x x, t.cover_crop_y y, t.cover_crop_size size FROM trips t
            JOIN captures_all c ON c.id = t.cover_capture_id AND c.current_photo_id = $3
            WHERE t.id = $1 AND t.user_id = $2`,
          [id, userId, photoId],
        );
  return r.rows[0] ? toCrop(r.rows[0].x, r.rows[0].y, r.rows[0].size) : null;
}

export async function squareRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  app.get(
    "/companion/v1/square/:kind/:id",
    {
      preValidation: scope,
      schema: {
        params: Type.Object({
          kind: Type.Enum(["species", "album", "trip"]),
          id: Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }),
        }),
        // The photo the phone shows for this owner; its crop applies only when it is the chosen cover.
        querystring: Type.Object({ photo: Type.String({ format: "uuid" }) }),
      },
    },
    async (request, reply) => {
      const { kind, id } = request.params;
      const userId = request.user!.id;
      const photoId = request.query.photo;
      // Ownership is checked here, so a key never reads another account's photo.
      const display = await resolvePhotoPath(photoId, userId, "display");
      if (!display || !(await statFile(display))) return reply.code(404).send({ error: "Photo not found" });
      const crop = await cropFor(kind, id, userId, photoId);
      const etag = squareEtag(photoId, crop);
      reply.header("ETag", etag).header("Cache-Control", "private, no-cache");
      if (request.headers["if-none-match"]?.split(",").some((t) => t.trim() === etag)) return reply.code(304).send();
      const file = await squareFile(photoId, userId, display, crop);
      const st = file ? await statFile(file) : null;
      if (!file || !st) return reply.code(404).send({ error: "Photo not found" });
      reply.header("Content-Type", "image/webp").header("Content-Length", st.size);
      return reply.send(createReadStream(file));
    },
  );
}
