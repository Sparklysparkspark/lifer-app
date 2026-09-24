import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSafePackEntry, resolveWithinDir } from "./packPaths.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "lifer-packpaths-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("resolveWithinDir", () => {
  it("resolves a file inside the dir", () => {
    mkdirSync(path.join(tmp, "photos"));
    writeFileSync(path.join(tmp, "photos", "a.webp"), "x");
    expect(resolveWithinDir(tmp, "photos/a.webp")).toMatch(/photos[/\\]a\.webp$/);
  });

  it("rejects traversal and absolute paths", () => {
    writeFileSync(path.join(tmp, "..", `outside-${path.basename(tmp)}`), "x");
    expect(resolveWithinDir(tmp, `../outside-${path.basename(tmp)}`)).toBeNull();
    expect(resolveWithinDir(tmp, "/etc/hosts")).toBeNull();
    rmSync(path.join(tmp, "..", `outside-${path.basename(tmp)}`), { force: true });
  });

  it("rejects a symlink that points outside the dir", () => {
    const secret = path.join(os.tmpdir(), `lifer-secret-${path.basename(tmp)}`);
    writeFileSync(secret, "secret");
    symlinkSync(secret, path.join(tmp, "link.webp"));
    expect(resolveWithinDir(tmp, "link.webp")).toBeNull();
    rmSync(secret, { force: true });
  });

  it("returns null for a missing file", () => {
    expect(resolveWithinDir(tmp, "nope.webp")).toBeNull();
  });
});

describe("isSafePackEntry", () => {
  it("allows files and directories only", () => {
    expect(isSafePackEntry("a", { type: "File" })).toBe(true);
    expect(isSafePackEntry("a", { type: "Directory" })).toBe(true);
    expect(isSafePackEntry("a", { type: "SymbolicLink" })).toBe(false);
    expect(isSafePackEntry("a", { type: "Link" })).toBe(false);
  });

  it("drops symlink entries from a real archive during extract", async () => {
    const src = path.join(tmp, "src");
    mkdirSync(src);
    writeFileSync(path.join(src, "manifest.json"), "{}");
    symlinkSync("/etc/hosts", path.join(src, "evil.webp"));
    const archive = path.join(tmp, "pack.tar.gz");
    await tar.create({ gzip: true, file: archive, cwd: src }, ["manifest.json", "evil.webp"]);

    const out = path.join(tmp, "out");
    mkdirSync(out);
    await tar.extract({ file: archive, cwd: out, filter: isSafePackEntry });
    expect(existsSync(path.join(out, "manifest.json"))).toBe(true);
    expect(() => lstatSync(path.join(out, "evil.webp"))).toThrow();
  });
});
