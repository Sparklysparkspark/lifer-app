import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readLocalSettingsAt } from "./localSettings.js";
import { log } from "./lib/log.js";

describe("readLocalSettingsAt", () => {
  it("returns {} when the file is missing", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "lifer-ls-"));
    expect(readLocalSettingsAt(path.join(dir, "settings.json"))).toEqual({});
  });

  it("reads valid settings", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "lifer-ls-"));
    const file = path.join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ dataDir: "/x" }));
    expect(readLocalSettingsAt(file)).toEqual({ dataDir: "/x" });
  });

  it("sets a corrupt file aside and falls back to defaults", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "lifer-ls-"));
    const file = path.join(dir, "settings.json");
    writeFileSync(file, "{ not json");
    const errSpy = vi.spyOn(log, "error").mockImplementation(() => {});
    expect(readLocalSettingsAt(file)).toEqual({});
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
    const names = readdirSync(dir);
    expect(names).not.toContain("settings.json");
    const corrupt = names.find((n) => n.startsWith("settings.json.corrupt-"));
    expect(corrupt).toBeDefined();
    expect(readFileSync(path.join(dir, corrupt!), "utf-8")).toBe("{ not json");
  });
});
