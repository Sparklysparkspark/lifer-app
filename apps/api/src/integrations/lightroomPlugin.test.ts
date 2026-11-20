// The Lightroom Classic plugin (integrations/lightroom-classic) may only talk to the user's own
// Lifer, through public routes under the scopes a plugin key can hold.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PLUGIN_SCOPES } from "../auth/desktopGate.js";

const dir = path.resolve(import.meta.dirname, "../../../../integrations/lightroom-classic/lifer.lrplugin");
const lua = readdirSync(dir)
  .filter((f) => f.endsWith(".lua"))
  .map((f) => ({ file: f, text: readFileSync(path.join(dir, f), "utf8") }));

describe("Lightroom Classic plugin", () => {
  it("names no host but the default local Lifer address", () => {
    const urls = lua.flatMap(({ file, text }) =>
      [...text.matchAll(/https?:\/\/[^\s"')]+/g)].map((m) => `${file} ${m[0]}`),
    );
    expect(
      urls.filter((u) => !/ http:\/\/127\.0\.0\.1(:4310)?|\^https\?:/.test(u) && !u.includes("localhost")),
    ).toEqual([]);
  });

  it("asks only for scopes a plugin key can hold", () => {
    const api = lua.find((l) => l.file === "LiferApi.lua")!.text;
    const scopes = [...(api.match(/SCOPES = \{([^}]*)\}/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(scopes.length).toBeGreaterThan(0);
    for (const s of scopes) expect(PLUGIN_SCOPES.has(s)).toBe(true);
  });

  it("calls only plugin routes", () => {
    const api = lua.find((l) => l.file === "LiferApi.lua")!.text;
    const routes = [...api.matchAll(/"(\/api\/[^"?]*)/g)].map((m) => m[1]);
    for (const r of routes) expect(r).toMatch(/^\/api\/(plugins\/v1|userdata\/v1|imports\/v1)\//);
  });
});
