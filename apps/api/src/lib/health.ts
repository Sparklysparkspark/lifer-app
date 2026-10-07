// GET /health: the container healthcheck and the desktop shell's "is my API up" probe.
// launchId lets the desktop shell tell its own API process apart from an older one still on the
// port. It's a separate, non-secret per-launch value: LIFER_LAUNCH_TOKEN is the desktop
// credential (auth/localCredential.ts) and never leaves the process.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { Nullable } from "./schema.js";

export function registerHealthRoute(app: FastifyInstance, env: NodeJS.ProcessEnv = process.env): void {
  app.get(
    "/health",
    // Warn level, so the container healthcheck doesn't fill the log.
    {
      logLevel: "warn",
      schema: { response: { 200: Type.Object({ ok: Type.Boolean(), launchId: Nullable(Type.String()) }) } },
    },
    async () => ({ ok: true, launchId: env.LIFER_LAUNCH_ID || null }),
  );
}
