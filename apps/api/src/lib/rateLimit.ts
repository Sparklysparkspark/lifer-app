import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import { ipRateLimitKey } from "../auth/rateLimiter.js";

// A global unicast /64 is one subscriber; any other IPv6 range (link-local, unique-local, mapped,
// NAT64) holds many hosts in one /64, so those count per address.
export function globalRateLimitKey(ip: string): string {
  const key = ipRateLimitKey(ip);
  if (!key.endsWith("::/64")) return key;
  const first = parseInt(key.split(":")[0], 16);
  return first >= 0x2000 && first <= 0x3fff ? key : ip.trim().toLowerCase();
}

// A photo or card image: one fast scroll through thousands of cards fetches thousands of these,
// each a cheap cached file read. They get their own, larger budget so a scroll can't use up the
// one every other request shares (and a refused image would stay a blank card).
const IMAGE_ROUTE = /^\/api\/[^?]*\/(thumb|medium|display|card)(\?|$)/;
export const IMAGE_LIMIT_FACTOR = 20;

export function isImageRequest(method: string, url: string): boolean {
  return method === "GET" && IMAGE_ROUTE.test(url);
}

// An import: resumable-upload chunks (tus), the per-file check and the import itself. A large card
// makes several of these per file, all signed in (every route under /api/uploads requires auth).
const UPLOAD_ROUTE = /^\/api\/uploads(\/|\?|$)/;
export const UPLOAD_LIMIT_FACTOR = 10;

export function isUploadRequest(method: string, url: string): boolean {
  return method !== "GET" && UPLOAD_ROUTE.test(url);
}

/** Which separate budget a request counts against, or null for the shared one. */
function budgetOf(method: string, url: string): { suffix: string; factor: number } | null {
  if (isImageRequest(method, url)) return { suffix: "|images", factor: IMAGE_LIMIT_FACTOR };
  if (isUploadRequest(method, url)) return { suffix: "|uploads", factor: UPLOAD_LIMIT_FACTOR };
  return null;
}

// The web app's own built files: hashed, cached and cheap. A cold page load fetches dozens, so they
// would eat the budget real requests need.
export function isStaticAsset(method: string, url: string): boolean {
  return (method === "GET" || method === "HEAD") && url.startsWith("/assets/");
}

/** A per-address limit across every route (a global IPv6 client counts as its /64), with images
 *  and uploads each counted apart under a larger limit. The plugin's 429 reaches the app's error handler, so it
 *  answers { error } like any other refusal, with Retry-After set. */
export async function registerRateLimit(app: FastifyInstance, perMinute: number): Promise<void> {
  if (perMinute <= 0) return;
  await app.register(rateLimit, {
    global: true,
    allowList: (request) => isStaticAsset(request.method, request.url),
    max: (request) => perMinute * (budgetOf(request.method, request.url)?.factor ?? 1),
    timeWindow: 60_000,
    keyGenerator: (request) =>
      `${globalRateLimitKey(request.ip)}${budgetOf(request.method, request.url)?.suffix ?? ""}`,
  });
}
