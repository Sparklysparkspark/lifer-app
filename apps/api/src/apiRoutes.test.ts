// Every /api route declares a schema for its input, so nothing reaches a handler unchecked.
// Registers the real route plugins (no database needed: nothing queries until a request).
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiRoutes } from "./apiRoutes.js";
import { installSchemas, routeCatalog, type CatalogRoute } from "./lib/schema.js";
import { PUBLIC_API_ROUTES } from "./auth/publicRoutes.js";
import { AUDITED_GET_ROUTES, GET_ROUTES_THAT_WRITE } from "./readOnlyGetRoutes.js";

const key = (r: CatalogRoute) => `${r.method} ${r.url}`;
// SQL that changes data, as it appears in a handler's own source.
const SQL_WRITE = /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|DROP\s+TABLE)\b/i;

describe("API route schemas", () => {
  const app = Fastify();
  let routes: CatalogRoute[] = [];

  beforeAll(async () => {
    // At the root, as the server does, so a plugin that skips withSchemas is still listed.
    installSchemas(app);
    await app.register(apiRoutes, { prefix: "/api" });
    await app.ready();
    routes = [...routeCatalog.values()].filter((r) => r.url.startsWith("/api/"));
  });
  afterAll(() => app.close());

  it("catalogs the routes", () => {
    expect(routes.length).toBeGreaterThan(150);
  });

  it("gives every route a schema", () => {
    expect(routes.filter((r) => !r.schema).map((r) => `${r.method} ${r.url}`)).toEqual([]);
  });

  it("validates exactly the path parameters each route has", () => {
    const wrong = routes.filter((r) => {
      const names = [...r.url.matchAll(/:(\w+)/g)].map((m) => m[1]).sort();
      const params = r.schema?.params as { properties?: Record<string, unknown> } | undefined;
      const declared = Object.keys(params?.properties ?? {}).sort();
      return names.join() !== declared.join();
    });
    expect(wrong.map((r) => `${r.method} ${r.url}`)).toEqual([]);
  });

  // Process check: a route without a sign-in hook is public, so it has to be on the allowlist
  // with its reason (auth/publicRoutes.ts). The desktop app's request gate uses the same list.
  it("guards every route with a sign-in hook unless it's on the public allowlist", () => {
    const unguarded = routes.filter((r) => !r.auth).map(key);
    expect(unguarded.filter((k) => !Object.hasOwn(PUBLIC_API_ROUTES, k))).toEqual([]);
  });

  it("keeps the public allowlist to routes that exist and are public", () => {
    const byKey = new Map(routes.map((r) => [key(r), r]));
    const stale = Object.keys(PUBLIC_API_ROUTES).filter((k) => !byKey.has(k) || byKey.get(k)!.auth);
    expect(stale).toEqual([]);
  });

  // Process check: GETs pass the cross-site write guard, so they must not change state. A new GET
  // route fails here until it's reviewed and added to readOnlyGetRoutes.ts.
  it("lists every GET route as audited read-only", () => {
    const gets = routes.filter((r) => r.method === "GET").map((r) => r.url);
    expect(gets.filter((u) => !AUDITED_GET_ROUTES.includes(u))).toEqual([]);
    expect(AUDITED_GET_ROUTES.filter((u) => !gets.includes(u))).toEqual([]);
  });

  it("doesn't write from a GET handler unless the write is listed as harmless", () => {
    const gets = routes.filter((r) => r.method === "GET");
    const writers = gets.filter((r) => SQL_WRITE.test(String(r.handler))).map((r) => r.url);
    expect(writers.filter((u) => !Object.hasOwn(GET_ROUTES_THAT_WRITE, u))).toEqual([]);
    expect(Object.keys(GET_ROUTES_THAT_WRITE).filter((u) => !gets.some((r) => r.url === u))).toEqual([]);
  });
});
