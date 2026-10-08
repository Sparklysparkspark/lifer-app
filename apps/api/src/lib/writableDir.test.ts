import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkWritableDir } from "./writableDir.js";

const root = mkdtempSync(path.join(os.tmpdir(), "lifer-writable-"));
afterAll(() => {
  chmodSync(root, 0o755);
  rmSync(root, { recursive: true, force: true });
});

describe("checkWritableDir", () => {
  it("creates a missing folder and leaves nothing behind", async () => {
    const dir = path.join(root, "app-data", "uploads");
    expect(await checkWritableDir(dir)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)("reports a folder it can't write to instead of throwing", async () => {
    const locked = path.join(root, "locked");
    await checkWritableDir(locked);
    chmodSync(locked, 0o555);
    expect((await checkWritableDir(path.join(locked, "uploads")))?.code).toBe("EACCES");
    chmodSync(locked, 0o755);
  });
});
