// A paired phone's key reaches exactly the phone routes the desktop listener forwards
// (companion_listener.rs RULES) and gets a 401 or 403 on every other signed-in route, on a server
// and on a desktop. Real route plugins, a stubbed database.
import { readFileSync } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const DEVICE = "device-key-reach";

vi.mock("@lifer/core/db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lifer/core/db.js")>()),
  pool: {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM api_keys k")) {
        const { hashApiKey } = await import("../auth/apiKeys.js");
        const { DEVICE_KEY_SCOPES } = await import("../auth/apiKeyRoutes.js");
        if (params?.[0] !== hashApiKey(DEVICE)) return { rows: [] };
        const row = { id: "k1", user_id: "00000000-0000-4000-8000-000000000001", email: "p@lifer.app" };
        return { rows: [{ ...row, permissions: [...DEVICE_KEY_SCOPES] }] };
      }
      return { rows: [], rowCount: 0 };
    }),
  },
}));
// The upload routes would otherwise make folders on disk once a key is accepted.
vi.mock("../lib/tusUploads.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tusUploads.js")>()),
  ensureTusUploadDirs: async () => {},
  tusServer: () => ({
    handle: async (_req: unknown, res: { writeHead(n: number): void; end(): void }) => {
      res.writeHead(204);
      res.end();
    },
  }),
}));

function listenerRoutes(): Set<string> {
  const src = readFileSync(new URL("../../../desktop/src-tauri/src/companion_listener.rs", import.meta.url), "utf8");
  const rules = src.slice(src.indexOf("const RULES"), src.indexOf("];", src.indexOf("const RULES")));
  return new Set([...rules.matchAll(/rule\("([A-Z]+)",\s*"([^"]+)"/g)].map((m) => `${m[1]} ${m[2]}`));
}

const PORT = 4310;

for (const desktop of [false, true]) {
  describe(`device key reach on a ${desktop ? "desktop" : "server"}`, () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      vi.stubEnv("LIFER_LAUNCH_TOKEN", "launch-secret-for-tests");
      vi.resetModules();
      vi.doMock("@lifer/core/config.js", async (importOriginal) => ({
        ...(await importOriginal<typeof import("@lifer/core/config.js")>()),
        SINGLE_USER_MODE: desktop,
      }));
      const { apiRoutes } = await import("../apiRoutes.js");
      const { installSchemas } = await import("../lib/schema.js");
      const { desktopRequestGate } = await import("../auth/desktopGate.js");
      app = Fastify();
      installSchemas(app);
      await app.register(cookie);
      if (desktop) app.addHook("onRequest", desktopRequestGate(PORT));
      await app.register(apiRoutes, { prefix: "/api" });
      await app.ready();
    }, 60_000);

    afterAll(async () => {
      await app?.close();
      vi.doUnmock("@lifer/core/config.js");
      vi.unstubAllEnvs();
    });

    it("reaches every phone route it can and nothing else", async () => {
      const { SINGLE_USER_MODE } = await import("@lifer/core/config.js");
      expect(SINGLE_USER_MODE).toBe(desktop);
      const { routeCatalog } = await import("../lib/schema.js");
      const { isPublicApiRoute } = await import("../auth/publicRoutes.js");
      const phone = listenerRoutes();
      expect(phone.size).toBeGreaterThan(20);
      let reached = 0;
      for (const r of routeCatalog.values()) {
        if (isPublicApiRoute(r.method, r.url)) continue;
        const name = `${r.method} ${r.url.replace(/:[A-Za-z]+/g, ":id")}`;
        const url = r.url.replace(/:[A-Za-z]+/g, "00000000-0000-4000-8000-000000000009");
        const headers = { host: `127.0.0.1:${PORT}`, "x-api-key": DEVICE };
        const res = await app.inject({ method: r.method as "GET", url, headers });
        if (phone.has(name)) {
          reached++;
          expect([401, 403], name).not.toContain(res.statusCode);
        } else {
          expect([401, 403], name).toContain(res.statusCode);
        }
      }
      // The sync feeds, gallery, photo renditions and resumable uploads.
      expect(reached).toBeGreaterThanOrEqual(20);
    }, 120_000);
  });
}
