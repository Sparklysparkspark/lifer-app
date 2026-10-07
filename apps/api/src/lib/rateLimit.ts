import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";

/** A per-address limit across every route. The plugin's 429 reaches the app's error handler, so it
 *  answers { error } like any other refusal, with Retry-After set. */
export async function registerRateLimit(app: FastifyInstance, perMinute: number): Promise<void> {
  if (perMinute <= 0) return;
  await app.register(rateLimit, { global: true, max: perMinute, timeWindow: 60_000 });
}
