// The OpenAPI document and the API guide must describe the routes as they really are. The document
// is generated from the registered routes' schemas and scopes, so these tests check that every
// key-accessible route has its prose, that the prose has no stale routes, and that the guide in
// docs/docs/api/overview.md names real routes with the parameters and fields their schemas accept.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_KEY_SCOPES } from "../auth/apiKeyRoutes.js";
import { apiRoutes } from "../apiRoutes.js";
import { installSchemas, routeCatalog, type CatalogRoute } from "../lib/schema.js";
import { OPS, buildOpenApi, keyRoutes, openApiPath } from "./openapi.js";

const GUIDE = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../docs/docs/api/overview.md");

interface Operation {
  parameters: Array<{ name: string; in: string; description?: string }>;
  requestBody?: { content: Record<string, { schema: { properties?: Record<string, unknown> } }> };
}
type Doc = { paths: Record<string, Record<string, Operation>> };

const key = (method: string, p: string) => `${method.toUpperCase()} ${p}`;
// Parameter names differ between the guide and the routes ({photoId} vs {id}); their places don't.
const shape = (p: string) => p.replace(/\{\w+\}/g, "{}");
const propertiesOf = (schema: unknown) =>
  Object.keys((schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {});
const requiredOf = (schema: unknown) => (schema as { required?: string[] } | undefined)?.required ?? [];

describe("API documentation", () => {
  const app = Fastify();
  let routes: CatalogRoute[] = [];
  let doc: Doc;
  const guide = readFileSync(GUIDE, "utf8");

  beforeAll(async () => {
    installSchemas(app);
    await app.register(apiRoutes, { prefix: "/api" });
    await app.ready();
    routes = keyRoutes(routeCatalog.values());
    doc = buildOpenApi(routes) as Doc;
  });
  afterAll(() => app.close());

  const routeFor = (method: string, guidePath: string) =>
    routes.find((r) => r.method === method && shape(openApiPath(r.url)) === shape(guidePath.replace(/^\/api/, "")));

  it("finds the key-accessible routes", () => {
    expect(routes.length).toBeGreaterThan(40);
  });

  it("has prose for every key-accessible route", () => {
    const missing = routes.filter((r) => !OPS[openApiPath(r.url)]?.[r.method.toLowerCase() as "get"]);
    expect(missing.map((r) => key(r.method, openApiPath(r.url)))).toEqual([]);
  });

  it("has no prose for routes a key can't reach", () => {
    const real = new Set(routes.map((r) => key(r.method, openApiPath(r.url))));
    const stale = Object.entries(OPS).flatMap(([p, methods]) =>
      Object.keys(methods)
        .map((m) => key(m, p))
        .filter((k) => !real.has(k)),
    );
    expect(stale).toEqual([]);
  });

  it("only uses scopes a key can actually be given", () => {
    const scopes = new Set<string>(API_KEY_SCOPES);
    expect([...new Set(routes.map((r) => r.scope))].filter((s) => !scopes.has(s!))).toEqual([]);
  });

  it("documents each route's own parameters and body, from its schema", () => {
    for (const r of routes) {
      const op = doc.paths[openApiPath(r.url)][r.method.toLowerCase()];
      const schema = (r.schema ?? {}) as Record<string, unknown>;
      const names = (where: string) => op.parameters.filter((p) => p.in === where).map((p) => p.name);
      expect([r.method, r.url, names("path")]).toEqual([r.method, r.url, propertiesOf(schema.params)]);
      expect([r.method, r.url, names("query")]).toEqual([r.method, r.url, propertiesOf(schema.querystring)]);
      const body = op.requestBody?.content["application/json"]?.schema;
      expect([r.method, r.url, propertiesOf(body)]).toEqual([r.method, r.url, propertiesOf(schema.body)]);
    }
  });

  it("describes every query parameter", () => {
    const bare = routes.flatMap((r) =>
      doc.paths[openApiPath(r.url)][r.method.toLowerCase()].parameters
        .filter((p) => p.in === "query" && !p.description)
        .map((p) => `${key(r.method, openApiPath(r.url))} ?${p.name}`),
    );
    expect(bare).toEqual([]);
  });

  it("names only real routes in the guide", () => {
    const mentioned = [...guide.matchAll(/`(GET|POST|PATCH|PUT|DELETE|HEAD) (\/api\/[^`?\s]*)/g)];
    expect(mentioned.length).toBeGreaterThan(10);
    // Any route counts here: the guide also names public ones like /api/openapi.json.
    const all = [...routeCatalog.values()].map((r) => key(r.method, shape(openApiPath(r.url))));
    const unknown = mentioned
      .filter((m) => !all.includes(key(m[1], shape(m[2].replace(/^\/api/, "")))))
      .map((m) => `${m[1]} ${m[2]}`);
    expect(unknown).toEqual([]);
  });

  it("lists the query parameters each guide section's route accepts", () => {
    // A "### `GET /api/x`" section with a "| Query |" table lists exactly the route's parameters.
    const sections = guide.split(/^### /m).slice(1);
    let checked = 0;
    for (const section of sections) {
      const heading = /^`(GET|POST|PATCH|PUT|DELETE) (\/api\/[^`?\s]*)`/.exec(section);
      const table = /^\| Query \|[^\n]*\n\|[-| ]+\|\n((?:\|[^\n]*\n)+)/m.exec(section);
      if (!heading || !table) continue;
      const names = [...table[1].matchAll(/^\| `(\w+)/gm)].map((m) => m[1]).sort();
      const route = routeFor(heading[1], heading[2]);
      expect([heading[2], names]).toEqual([heading[2], propertiesOf(route?.schema?.querystring).sort()]);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("shows request bodies with fields their routes accept", () => {
    // Rows like | `PATCH /api/captures/{id}/rating` | `{ "rating": 1-5 }`, ... |
    const rows = [...guide.matchAll(/^\| `(POST|PATCH|PUT) (\/api\/[^`]+)` \| `(\{[^`]*\})`/gm)];
    expect(rows.length).toBeGreaterThan(3);
    for (const [, method, p, example] of rows) {
      const body = routeFor(method, p)?.schema?.body;
      const fields = [...example.matchAll(/"(\w+)":/g)].map((m) => m[1]);
      const accepted = propertiesOf(body);
      expect([p, fields.filter((f) => !accepted.includes(f))]).toEqual([p, []]);
      expect([p, requiredOf(body).filter((f) => !fields.includes(f))]).toEqual([p, []]);
    }
  });

  it("lists the import form's fields as the document does", () => {
    const section = guide.split(/^### /m).find((s) => s.startsWith("`POST /api/uploads` "))!;
    // The first column of its "| Field |" table.
    const firstCells = [...section.matchAll(/^\| (`[^|]*)\|/gm)].map((m) => m[1]);
    const fields = firstCells.flatMap((cell) => [...cell.matchAll(/`(\w+)`/g)].map((m) => m[1]));
    expect(fields.length).toBeGreaterThan(5);
    const multipart = (OPS["/uploads"].post!.multipart as { properties: Record<string, unknown> }).properties;
    expect(fields.filter((f) => !(f in multipart))).toEqual([]);
  });
});
