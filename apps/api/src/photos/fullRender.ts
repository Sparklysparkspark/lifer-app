// "View full size" on a phone: a full-resolution JPEG of a photo's original, made on demand. A JPEG
// original is streamed as it is by the route; anything else (HEIC, AVIF, JPEG 2000, JPEG XL, PNG, TIFF, WebP, or a RAW's
// embedded preview, the largest picture the RAW holds) is rendered here to JPEG and kept for an
// hour, so scrolling back doesn't render it twice. Never part of the showcase.
import { readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { APP_DATA_DIR } from "@lifer/core/config.js";
import { ensureDir } from "@lifer/core/lib/safeFs.js";
import { originalSharpOptions } from "@lifer/core/lib/imageLimits.js";
import { DECODED_FORMATS, sniffPhotoFormat } from "@lifer/core/uploads/formats.js";
import { decodedJpegBuffer } from "@lifer/core/uploads/decodedJpeg.js";
import { extractEmbeddedPreview } from "../uploads/exif.js";
import { statFile } from "../lib/cachedFile.js";

const FULL_TTL_MS = 60 * 60_000;
const fullDir = () => path.join(APP_DATA_DIR, "full");
const inFlight = new Map<string, Promise<string | null>>();

export const isJpegPath = (file: string) => /\.jpe?g$/i.test(file);

/** Deletes renders older than the keep time; best effort, run as renders are asked for. */
async function sweep(): Promise<void> {
  const files = await readdir(fullDir()).catch(() => []);
  await Promise.all(
    files.map(async (f) => {
      const full = path.join(fullDir(), f);
      const st = await stat(full).catch(() => null);
      if (st && Date.now() - st.mtimeMs > FULL_TTL_MS) await rm(full, { force: true });
    }),
  );
}

/** The cached JPEG render of this original, made if missing or older than the original; null when
 *  it can't be made (a RAW with no preview, an unreadable file). */
export function fullRender(photoId: string, sourcePath: string, raw: boolean): Promise<string | null> {
  // A capture can hold a RAW and another original; each gets its own render.
  return cachedRender(raw ? `${photoId}-raw` : photoId, sourcePath, async (tmp) => {
    const format = raw ? null : await sniffPhotoFormat(sourcePath);
    const input = raw
      ? await extractEmbeddedPreview(sourcePath)
      : format && DECODED_FORMATS.has(format)
        ? await decodedJpegBuffer(format, sourcePath)
        : sourcePath;
    if (!input) return false;
    await sharp(input, originalSharpOptions()).rotate().jpeg({ quality: 92 }).toFile(tmp);
    return true;
  });
}

/** Runs `make` into a temp file once per key, kept for an hour and remade when the source is newer. */
function cachedRender(
  key: string,
  sourcePath: string,
  make: (tmp: string) => Promise<boolean>,
): Promise<string | null> {
  const pending = inFlight.get(key);
  if (pending) return pending;
  const job = (async () => {
    const target = path.join(fullDir(), `${key}.jpg`);
    const [cached, source] = await Promise.all([statFile(target), statFile(sourcePath)]);
    if (!source) return null;
    if (cached && cached.mtimeMs >= source.mtimeMs) return target;
    await ensureDir(fullDir());
    void sweep().catch(() => {});
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      if (!(await make(tmp))) return null;
      await rename(tmp, target);
      return target;
    } catch {
      await rm(tmp, { force: true });
      return null;
    }
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}
