import type { FastifyBaseLogger } from "fastify";
import { pino } from "pino";
import { redactShareTokens } from "./requestGuard.js";

// One logger for the whole process. index.ts hands it to Fastify as its loggerInstance, so
// app.log and request.log are children of this and everything lands in the same output.
// Use request.log inside a route handler (it carries the request id) and this everywhere else.
// LOG_LEVEL picks how much is logged (debug for troubleshooting). A typo falls back to info with a
// warning instead of stopping the server.
const LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];
const requestedLevel = process.env.LOG_LEVEL?.trim().toLowerCase();
const level = requestedLevel && LEVELS.includes(requestedLevel) ? requestedLevel : "info";

export const log: FastifyBaseLogger = pino({
  level,
  serializers: {
    // Same fields as Fastify's default, with share tokens hidden: a logged token opens the share.
    req(request: { method: string; url: string; host?: string; ip?: string; socket?: { remotePort?: number } }) {
      return {
        method: request.method,
        url: redactShareTokens(request.url),
        host: request.host,
        remoteAddress: request.ip,
        remotePort: request.socket?.remotePort,
      };
    },
  },
});

if (requestedLevel && level !== requestedLevel) {
  log.warn(`LOG_LEVEL "${process.env.LOG_LEVEL}" isn't one of ${LEVELS.join(", ")}; using info`);
}
