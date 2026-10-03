// Conditional-request helpers for streaming files from disk: ETag and Last-Modified from size
// and mtime, so browsers revalidate with an empty 304.
import { createReadStream, type Stats } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyReply, FastifyRequest } from "fastify";

export async function statFile(filePath: string): Promise<Stats | null> {
  try {
    const st = await stat(filePath);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

/** Weak for re-encoded derivatives (kept so browsers' cached tags stay valid); strong for
 *  originals, where a Range request may send If-Range. */
export function fileEtag(st: Stats, weak: boolean): string {
  const tag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  return weak ? `W/${tag}` : tag;
}

function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  const bare = (t: string) => t.trim().replace(/^W\//, "");
  return header.split(",").some((t) => bare(t) === bare(etag));
}

/**
 * Sets ETag, Last-Modified and Cache-Control, and reports whether the client's copy is still
 * current (If-None-Match, or If-Modified-Since when no If-None-Match was sent). The caller then
 * answers 304 with no body.
 */
export function applyFileValidators(
  request: FastifyRequest,
  reply: FastifyReply,
  st: Stats,
  opts: { weak: boolean; cacheControl?: string },
): { notModified: boolean; etag: string } {
  const etag = fileEtag(st, opts.weak);
  reply.header("ETag", etag);
  reply.header("Last-Modified", st.mtime.toUTCString());
  reply.header("Cache-Control", opts.cacheControl ?? "private, no-cache");
  const inm = request.headers["if-none-match"];
  if (inm) return { notModified: etagMatches(inm, etag), etag };
  const ims = request.headers["if-modified-since"];
  if (ims) {
    const since = Date.parse(ims);
    // HTTP dates have whole-second precision.
    if (!Number.isNaN(since) && Math.floor(st.mtimeMs / 1000) * 1000 <= since) return { notModified: true, etag };
  }
  return { notModified: false, etag };
}

/** If-Range: honor the Range only when the validator still matches (strong ETag or date). */
export function rangeStillValid(request: FastifyRequest, st: Stats, etag: string): boolean {
  const raw = request.headers["if-range"];
  const ifRange = Array.isArray(raw) ? raw[0] : raw;
  if (!ifRange) return true;
  if (ifRange.startsWith('"') || ifRange.startsWith("W/")) return !etag.startsWith("W/") && ifRange.trim() === etag;
  const date = Date.parse(ifRange);
  return !Number.isNaN(date) && Math.floor(st.mtimeMs / 1000) * 1000 === date;
}

/** Streams a cached WebP rendition with a weak ETag and 304 support. A stand-in (a sibling shown
 *  while the real file is repaired) is sent with no-store so it's never kept. */
export function sendCachedImage(
  request: FastifyRequest,
  reply: FastifyReply,
  filePath: string,
  st: Stats,
  opts: { standIn?: boolean; cacheControl?: string } = {},
) {
  if (opts.standIn) {
    reply.header("Cache-Control", "no-store");
  } else if (applyFileValidators(request, reply, st, { weak: true, cacheControl: opts.cacheControl }).notModified) {
    return reply.code(304).send();
  }
  reply.header("Content-Type", "image/webp");
  reply.header("Content-Length", st.size);
  return reply.send(createReadStream(filePath));
}
