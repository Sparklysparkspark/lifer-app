import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ current: {} as Record<string, unknown>, written: [] as Array<Record<string, unknown>> }));
vi.mock("../localSettings.js", () => ({
  readLocalSettings: () => settings.current,
  writeLocalSettings: (patch: Record<string, unknown>) => settings.written.push(patch),
}));
vi.mock("../db.js", () => ({ withTransaction: async (fn: (c: { query: () => Promise<void> }) => Promise<void>) => fn({ query: async () => {} }) }));

const { recoverInterruptedStorageMigration } = await import("./storageMove.js");

let root: string;
let from: string;
let to: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "lifer-move-"));
  from = path.join(root, "old");
  to = path.join(root, "new");
  mkdirSync(from);
  mkdirSync(to);
  writeFileSync(path.join(from, "left-behind.jpg"), "x");
  writeFileSync(path.join(to, "complete-copy.jpg"), "x");
  settings.written = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("recoverInterruptedStorageMigration", () => {
  it("finishes a move whose copy completed, even with the old folder only partly deleted", async () => {
    settings.current = { migration: { from, to, copied: true } };
    await recoverInterruptedStorageMigration();
    expect(existsSync(path.join(to, "complete-copy.jpg"))).toBe(true);
    expect(existsSync(from)).toBe(false);
    expect(settings.written.at(-1)).toEqual({ dataDir: to, migration: undefined });
  });

  it("rolls back a move interrupted while copying", async () => {
    settings.current = { migration: { from, to } };
    await recoverInterruptedStorageMigration();
    expect(existsSync(to)).toBe(false);
    expect(existsSync(path.join(from, "left-behind.jpg"))).toBe(true);
    expect(settings.written.at(-1)).toEqual({ dataDir: from, migration: undefined });
  });
});
