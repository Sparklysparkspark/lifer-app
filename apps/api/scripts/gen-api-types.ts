// Writes the web app's API types from the routes' own schemas: registers every /api route (no
// database or network needed), builds the full OpenAPI document and turns it into TypeScript
// with openapi-typescript.
//   npm run gen:api-types     rewrites apps/web/src/api/openapi.gen.json and schema.gen.ts
//   npm run check:api-types   fails when either file is stale
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Some route modules query at registration. An unreachable address (always, even when the shell
// has a DATABASE_URL) keeps them off any real library, and their failures out of the output.
process.env.DATABASE_URL = "postgres://none@127.0.0.1:1/no-database";
process.env.LOG_LEVEL = "silent";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const OUT_DIR = path.join(ROOT, "apps/web/src/api");
const JSON_FILE = path.join(OUT_DIR, "openapi.gen.json");
const TYPES_FILE = path.join(OUT_DIR, "schema.gen.ts");

const HEADER = `// Generated from the API's route schemas by \`npm run gen:api-types\`. Do not edit by hand:
// change the route's TypeBox schema in apps/api and regenerate. CI fails when this file is stale.
`;

async function generate(): Promise<{ json: string; types: string }> {
  const { default: Fastify } = await import("fastify");
  const { default: openapiTS, astToString } = await import("openapi-typescript");
  const prettier = await import("prettier");
  const { apiRoutes } = await import("../src/apiRoutes.js");
  const { installSchemas, routeCatalog } = await import("../src/lib/schema.js");
  const { buildOpenApi } = await import("../src/integrations/openapi.js");

  const app = Fastify();
  installSchemas(app);
  await app.register(apiRoutes, { prefix: "/api" });
  await app.ready();
  const doc = buildOpenApi(routeCatalog.values(), { internal: true }) as { paths: Record<string, unknown> };
  await app.close();
  // Route registration order isn't meaningful; sorted paths keep the diff small.
  doc.paths = Object.fromEntries(Object.entries(doc.paths).sort(([a], [b]) => a.localeCompare(b)));

  const config = (await prettier.resolveConfig(TYPES_FILE)) ?? {};
  const json = await prettier.format(JSON.stringify(doc), { ...config, parser: "json" });
  const ast = await openapiTS(JSON.parse(JSON.stringify(doc)));
  const types = await prettier.format(HEADER + "\n" + astToString(ast), { ...config, parser: "typescript" });
  return { json, types };
}

const check = process.argv.includes("--check");
const { json, types } = await generate();
if (check) {
  const read = (file: string) => readFile(file, "utf8").catch(() => "");
  const stale = [
    ...((await read(JSON_FILE)) === json ? [] : [JSON_FILE]),
    ...((await read(TYPES_FILE)) === types ? [] : [TYPES_FILE]),
  ];
  if (stale.length) {
    console.error(
      `Stale generated API types: ${stale.map((f) => path.relative(ROOT, f)).join(", ")}. Run npm run gen:api-types.`,
    );
    process.exit(1);
  }
  console.log("Generated API types are up to date.");
} else {
  await writeFile(JSON_FILE, json);
  await writeFile(TYPES_FILE, types);
  console.log(`Wrote ${path.relative(ROOT, JSON_FILE)} and ${path.relative(ROOT, TYPES_FILE)}.`);
}
// Some route modules hold open handles (child processes, timers) that would keep Node running.
process.exit(0);
