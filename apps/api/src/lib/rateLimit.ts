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

/** A per-address limit across every route (a global IPv6 client counts as its /64). The plugin's 429
 *  reaches the app's error handler, so it answers { error } like any other refusal, with
 *  Retry-After set. */
export async function registerRateLimit(app: FastifyInstance, perMinute: number): Promise<void> {
  if (perMinute <= 0) return;
  await app.register(rateLimit, {
    global: true,
    max: perMinute,
    timeWindow: 60_000,
    keyGenerator: (request) => globalRateLimitKey(request.ip),
  });
}
