import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ pool: { query: vi.fn() } }));

import { resolveWithinTripFolder } from "./scan.js";

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "lifer-trip-")));
  mkdirSync(path.join(tmp, "day1"));
  writeFileSync(path.join(tmp, "day1", "a.jpg"), "x");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("resolveWithinTripFolder", () => {
  it("resolves a file inside the folder", () => {
    expect(resolveWithinTripFolder(tmp, "day1/a.jpg")).toBe(path.join(tmp, "day1", "a.jpg"));
  });

  it("rejects traversal, absolute paths and the folder itself", () => {
    expect(resolveWithinTripFolder(tmp, "../etc/passwd")).toBeNull();
    expect(resolveWithinTripFolder(tmp, "/etc/hosts")).toBeNull();
    expect(resolveWithinTripFolder(tmp, ".")).toBeNull();
  });

  it("allows a file name that merely starts with two dots", () => {
    writeFileSync(path.join(tmp, "..notes.jpg"), "x");
    expect(resolveWithinTripFolder(tmp, "..notes.jpg")).toBe(path.join(tmp, "..notes.jpg"));
  });

  it("works when the trip folder is a filesystem root", () => {
    const root = path.parse(tmp).root;
    const rel = path.relative(root, path.join(tmp, "day1", "a.jpg"));
    expect(resolveWithinTripFolder(root, rel)).toBe(path.join(tmp, "day1", "a.jpg"));
  });

  it("rejects a symlink that points outside the folder", () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), "lifer-outside-"));
    try {
      writeFileSync(path.join(outside, "secret.jpg"), "x");
      symlinkSync(path.join(outside, "secret.jpg"), path.join(tmp, "link.jpg"));
      expect(resolveWithinTripFolder(tmp, "link.jpg")).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("returns null for a missing file or a directory", () => {
    expect(resolveWithinTripFolder(tmp, "day1/missing.jpg")).toBeNull();
    expect(resolveWithinTripFolder(tmp, "day1")).toBeNull();
  });
});
