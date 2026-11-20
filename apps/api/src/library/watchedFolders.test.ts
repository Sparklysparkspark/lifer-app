import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lifer/core/db.js", () => ({ pool: {} }));
vi.mock("./routes.js", () => ({ startWatchedFolderScan: vi.fn() }));

const { pollWatchedFolder } = await import("./watchedFolders.js");

describe("pollWatchedFolder", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "watched-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const folder = () => ({ path: dir, enabled: true, userId: "u", signature: null as string | null });

  it("waits for a change to settle, then scans once", async () => {
    await writeFile(path.join(dir, "a.jpg"), "x");
    const seen = new Map<string, string>();
    const start = vi.fn(() => true);
    const persist = vi.fn(async () => {});
    expect(await pollWatchedFolder(folder(), seen, start, persist)).toBe("waiting");
    expect(start).not.toHaveBeenCalled();
    await writeFile(path.join(dir, "a.jpg"), "xx"); // still being copied
    expect(await pollWatchedFolder(folder(), seen, start, persist)).toBe("waiting");
    expect(await pollWatchedFolder(folder(), seen, start, persist)).toBe("started");
    expect(start).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the folder is unchanged since the last scan", async () => {
    await writeFile(path.join(dir, "a.jpg"), "x");
    const seen = new Map<string, string>();
    let signature = "";
    const remember = async (_f: unknown, s: string) => void (signature = s);
    await pollWatchedFolder(folder(), seen, () => true, remember);
    await pollWatchedFolder(folder(), seen, () => true, remember);
    const start = vi.fn(() => true);
    expect(await pollWatchedFolder({ ...folder(), signature }, seen, start, remember)).toBe("unchanged");
    expect(start).not.toHaveBeenCalled();
  });

  it("stays quiet for a missing folder and keeps waiting while a job is busy", async () => {
    const seen = new Map<string, string>();
    const gone = { ...folder(), path: path.join(dir, "unplugged") };
    expect(
      await pollWatchedFolder(
        gone,
        seen,
        () => true,
        async () => {},
      ),
    ).toBe("offline");
    await writeFile(path.join(dir, "a.jpg"), "x");
    const busy = vi.fn(() => false);
    await pollWatchedFolder(folder(), seen, busy, async () => {});
    expect(await pollWatchedFolder(folder(), seen, busy, async () => {})).toBe("waiting");
  });
});
