// sharp's pixel limit for opening a photo. Config-free (env only) so the inference worker and the
// desktop's inference-only sidecar can use it too.

// Memory follows image width, not area, so this guards against decompression bombs rather than
// capping memory.
const DEFAULT_MAX_IMAGE_PIXELS = 2_000_000_000;

/** LIFER_MAX_IMAGE_PIXELS: a pixel count, or 0/false for no limit. */
export function maxImagePixels(): number | false {
  const raw = process.env.LIFER_MAX_IMAGE_PIXELS?.trim().toLowerCase();
  if (!raw) return DEFAULT_MAX_IMAGE_PIXELS;
  if (raw === "0" || raw === "false") return false;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_IMAGE_PIXELS;
}

/** Options for opening an original photo from disk: the pixel limit, read top to bottom so libvips
 *  never holds the whole decoded image. */
export function originalSharpOptions(): { limitInputPixels: number | false; sequentialRead: true } {
  return { limitInputPixels: maxImagePixels(), sequentialRead: true };
}

// sharp's own default limit. Photos above it get a smaller working copy for species matching,
// so matching never decodes a huge panorama at full size.
export const INFERENCE_SOURCE_MAX_PIXELS = 268_402_689;
