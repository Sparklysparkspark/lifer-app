import type { FastifyBaseLogger } from "fastify";
import { pino } from "pino";
import { redactShareTokens } from "./requestGuard.js";

// One logger for the whole process. index.ts hands it to Fastify as its loggerInstance, so
// app.log and request.log are children of this and everything lands in the same output.
// Use request.log inside a route handler (it carries the request id) and this everywhere else.
export const log: FastifyBaseLogger = pino({
  level: "info",
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
