// The userdata.read routes must never describe a catalog-derived field.
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiRoutes } from "../apiRoutes.js";
import { installSchemas, routeCatalog } from "../lib/schema.js";
import { CATALOG_FIELD } from "./responses.js";

function fieldNames(schema: unknown, out: string[] = []): string[] {
  if (!schema || typeof schema !== "object") return out;
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === "properties" && v && typeof v === "object") out.push(...Object.keys(v));
    // Skip annotations: a field's own description text is not a field.
    if (k !== "description") fieldNames(v, out);
  }
  return out;
}

describe("userdata routes", () => {
  const app = Fastify();
  beforeAll(async () => {
    installSchemas(app);
    await app.register(apiRoutes, { prefix: "/api" });
    await app.ready();
  });
  afterAll(() => app.close());

  it("are guarded by userdata.read (reads) or userdata.write (writes) and return no catalog field", () => {
    const routes = [...routeCatalog.values()].filter((r) => r.url.startsWith("/api/userdata/"));
    expect(routes.length).toBe(12);
    for (const r of routes) {
      const writes = ["PATCH", "PUT", "DELETE"].includes(r.method);
      expect([r.method, r.url, r.scope]).toEqual([r.method, r.url, writes ? "userdata.write" : "userdata.read"]);
      const names = fieldNames((r.schema as { response?: unknown } | undefined)?.response);
      expect([r.url, names.filter((n) => CATALOG_FIELD.test(n))]).toEqual([r.url, []]);
    }
  });
});
