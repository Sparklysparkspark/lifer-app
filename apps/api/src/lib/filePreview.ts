import path from "node:path";
import { stat } from "node:fs/promises";
import type { FastifyReply } from "fastify";
import sharp from "sharp";
import { originalSharpOptions } from "@lifer/core/lib/imageLimits.js";
import { VENDOR_RAW_EXTENSIONS, claimedPhotoFormat, sniffPhotoFormat } from "@lifer/core/uploads/formats.js";
import { extractEmbeddedPreview } from "../uploads/exif.js";
import { prepareWorkingImage, type WorkingImage } from "../uploads/workingImage.js";

/** Sends a WebP of a photo on disk that Lifer hasn't imported, at most `width` wide. Callers pick
 *  the file from their own records and check it is one the user may see; this never does. */
export async function sendFilePreview(absolutePath: string, reply: FastifyReply, width: number) {
  if (!(await stat(absolutePath).catch(() => null))) return reply.code(404).send({ error: "Not found" });
  let working: WorkingImage | null = null;
  try {
    let source: string | Buffer = absolutePath;
    if (VENDOR_RAW_EXTENSIONS.has(path.extname(absolutePath).toLowerCase())) {
      // sharp can't decode a RAW, so the camera's own embedded JPEG stands in.
      const embedded = await extractEmbeddedPreview(absolutePath);
      if (!embedded) return reply.code(404).send({ error: "Couldn't read this file" });
      source = embedded;
    } else {
      // A HEIC is read through its working JPEG, since sharp can't decode it.
      const format = (await sniffPhotoFormat(absolutePath)) ?? claimedPhotoFormat(null, absolutePath);
      if (format === "heic") working = await prepareWorkingImage(absolutePath, format);
      source = working?.decodePath ?? absolutePath;
    }
    const buffer = await sharp(source, originalSharpOptions())
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 75 })
      .toBuffer();
    reply.header("Content-Type", "image/webp");
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.send(buffer);
  } catch {
    return reply.code(404).send({ error: "Couldn't read this file" });
  } finally {
    await working?.release();
  }
}
