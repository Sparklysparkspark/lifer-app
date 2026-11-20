import { existsSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { PORT, SINGLE_USER_MODE } from "@lifer/core/config.js";
import { requireAuth } from "../auth/session.js";
import { Nullable, replies, withSchemas } from "../lib/schema.js";

const AssistantSetup = Type.Object({
  available: Type.Boolean({ description: "This install ships the assistant server, so setup needs nothing else" }),
  command: Nullable(Type.String({ description: "The program an assistant starts" })),
  script: Nullable(Type.String({ description: "The assistant server file it runs" })),
  url: Nullable(Type.String({ description: "Where this Lifer answers" })),
});

// The desktop app ships the assistant server beside the API (<resources>/api/dist/index.js and
// <resources>/mcp/lifer-mcp.mjs) and runs on its own Node, so an assistant needs nothing installed.
function bundledScript(): string | null {
  const entry = process.argv[1];
  if (!entry) return null;
  const script = path.join(path.dirname(entry), "..", "..", "mcp", "lifer-mcp.mjs");
  return existsSync(script) ? path.resolve(script) : null;
}

export async function assistantSetupRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  app.get(
    "/assistant/setup",
    { preValidation: requireAuth, schema: { response: replies(AssistantSetup) } },
    async () => {
      const script = SINGLE_USER_MODE ? bundledScript() : null;
      return script
        ? { available: true, command: process.execPath, script, url: `http://127.0.0.1:${PORT}` }
        : { available: false, command: null, script: null, url: null };
    },
  );
}
