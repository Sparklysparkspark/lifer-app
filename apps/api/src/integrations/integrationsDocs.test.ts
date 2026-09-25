// Keeps the API documentation honest: every route an API key can reach (anything using
// requireScope) must be in the OpenAPI document with the same scope, and the document must not
// list routes that no longer exist. Scans the route source files, so a new key-accessible route
// fails this test until it's documented in openapi.ts (and, for anything user-facing, docs/API.md).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { API_KEY_SCOPES } from "../auth/apiKeyRoutes.js";
import { documentedRoutes } from "./openapi.js";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return name.endsWith(".ts") && !name.includes(".test.") ? [full] : [];
  });
}

// Routes whose path is a template over a fixed list (`/photos/:id/${kind}` for each image size).
// Your own photos also come in a medium size; reference photos don't.
const expansionsFor = (p: string): Record<string, string[]> => ({ "${kind}": p.startsWith("/photos/") ? ["thumb", "medium", "display"] : ["thumb", "display"] });

function scopedRoutesInSource(): Array<{ method: string; path: string; scope: string }> {
  const routes: Array<{ method: string; path: string; scope: string }> = [];
  const routeStart = /app\.(get|post|put|patch|delete)\s*(?:<[^()]*?>)?\s*\(\s*(["`])([^"`]+)\2/gs;
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(routeStart)) {
      let tail = src.slice(m.index! + m[0].length, m.index! + m[0].length + 400);
      const next = tail.search(/app\.(get|post|put|patch|delete)/);
      if (next >= 0) tail = tail.slice(0, next);
      const scope = /requireScope\("([^"]+)"\)/.exec(tail)?.[1];
      if (!scope) continue;
      const openApiPath = m[3].replace(/:(\w+)/g, "{$1}");
      const expansions = expansionsFor(openApiPath);
      const templates = Object.keys(expansions).filter((t) => openApiPath.includes(t));
      const expanded = templates.length
        ? expansions[templates[0]].map((v) => openApiPath.replace(templates[0], v))
        : [openApiPath];
      for (const p of expanded) routes.push({ method: m[1].toUpperCase(), path: p, scope });
    }
  }
  return routes;
}

const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

describe("API documentation", () => {
  const inSource = scopedRoutesInSource();
  const documented = documentedRoutes();

  it("finds the key-accessible routes", () => {
    expect(inSource.length).toBeGreaterThan(40);
  });

  it("documents every key-accessible route with its real scope", () => {
    const docs = new Map(documented.map((r) => [key(r), r.scope]));
    const missing = inSource.filter((r) => docs.get(key(r)) !== r.scope).map((r) => `${key(r)} (${r.scope})`);
    expect(missing).toEqual([]);
  });

  it("doesn't document routes that don't exist", () => {
    const real = new Set(inSource.map(key));
    expect(documented.filter((r) => !real.has(key(r))).map(key)).toEqual([]);
  });

  it("only uses scopes a key can actually be given", () => {
    const scopes = new Set<string>(API_KEY_SCOPES);
    expect([...new Set(inSource.map((r) => r.scope))].filter((s) => !scopes.has(s))).toEqual([]);
  });
});
