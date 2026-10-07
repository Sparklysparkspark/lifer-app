import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Records the order of fsync and rename calls while still doing the real work.
const calls: string[] = [];
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    fsyncSync: (fd: number) => {
      calls.push(`fsync:${fs.fstatSync(fd).isDirectory() ? "dir" : "file"}`);
      return fs.fsyncSync(fd);
    },
    renameSync: (from: string, to: string) => {
      calls.push("rename");
      return fs.renameSync(from, to);
    },
  };
});

const { writeFileAtomicSync } = await import("./atomicWrite.js");

describe("writeFileAtomicSync", () => {
  let dir: string;
  const platform = process.platform;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "lifer-atomic-"));
    calls.length = 0;
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform });
    rmSync(dir, { recursive: true, force: true });
  });

  it("flushes the temp file before the rename and the folder after it", () => {
    const file = path.join(dir, "state.json");
    writeFileSync(file, "old");
    writeFileAtomicSync(file, '{"new":true}');
    expect(readFileSync(file, "utf8")).toBe('{"new":true}');
    expect(calls).toEqual(["fsync:file", "rename", "fsync:dir"]);
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  it("skips the folder flush on Windows, which can't open a folder to sync it", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    writeFileAtomicSync(path.join(dir, "state.json"), "x");
    expect(calls).toEqual(["fsync:file", "rename"]);
  });

  it("leaves no temp file behind when the write fails", () => {
    expect(() => writeFileAtomicSync(path.join(dir, "missing", "state.json"), "x")).toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});
