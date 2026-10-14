import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { walkFiles } from "./walkFiles.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "lifer-walk-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function names(dir: string, skipDir?: (p: string) => boolean): Promise<string[]> {
  const found: string[] = [];
  for await (const f of walkFiles(dir, skipDir)) found.push(path.relative(root, f.absolutePath));
  return found.sort();
}

describe("walkFiles", () => {
  it("finds files at any depth, leaving out dotfiles, dot-folders and skipped folders", async () => {
    for (const rel of ["a.jpg", "Birds/Heron/RAW/b.nef", ".DS_Store", ".lifer/index.json", "skip/c.jpg"]) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), "x");
    }
    expect(await names(root, (dir) => path.basename(dir) === "skip")).toEqual(["Birds/Heron/RAW/b.nef", "a.jpg"]);
  });

  it("yields nothing for a folder that doesn't exist", async () => {
    expect(await names(path.join(root, "gone"))).toEqual([]);
  });
});
