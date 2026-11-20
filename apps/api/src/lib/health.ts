// GET /health: the container healthcheck and the desktop shell's "is my API up" probe.
// launchId lets the desktop shell tell its own API process apart from an older one still on the
// port. It's a separate, non-secret per-launch value: LIFER_LAUNCH_TOKEN is the desktop
// credential (auth/localCredential.ts) and never leaves the process.
// instanceId is the install's id (migration 148): the desktop app keys what it knows about a
// server by it, so a server stays the same server across every address it's reached at.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { APP_VERSION } from "@lifer/core/config.js";
import { Nullable } from "./schema.js";
import { getInstallSetting } from "./installSettings.js";

/** 2: albums, trips and their membership sync beside captures and species marks. */
export const SYNC_PROTOCOL = 2;

let cachedInstanceId: string | null = null;

/** The install's id, read once. Null until the database answers (first start, migrations running). */
export async function readInstanceId(): Promise<string | null> {
  if (cachedInstanceId) return cachedInstanceId;
  try {
    cachedInstanceId = await getInstallSetting<string>(pool, "instance_id");
  } catch {
    return null;
  }
  return cachedInstanceId;
}

export function registerHealthRoute(
  app: FastifyInstance,
  env: NodeJS.ProcessEnv = process.env,
  instanceId: () => Promise<string | null> = readInstanceId,
): void {
  app.get(
    "/health",
    // Warn level, so the container healthcheck doesn't fill the log.
    {
      logLevel: "warn",
      schema: {
        response: {
          200: Type.Object({
            ok: Type.Boolean(),
            launchId: Nullable(Type.String()),
            instanceId: Nullable(Type.String()),
            syncProtocol: Type.Integer(),
            version: Type.String(),
          }),
        },
      },
    },
    async () => ({
      ok: true,
      launchId: env.LIFER_LAUNCH_ID || null,
      instanceId: await instanceId(),
      syncProtocol: SYNC_PROTOCOL,
      version: APP_VERSION,
    }),
  );
}
