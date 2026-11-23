// copyVerified: a copy is either complete and identical with the original's times, or absent with
// the source untouched and no partial file left.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({
  fillDisk: false,
  changeSourceOnRestat: null as string | null,
  noLinks: false,
  statCalls: new Map<string, number>(),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    // The source is edited while it is being read: the second look at it sees the change.
    stat: async (file: string) => {
      const calls = (fault.statCalls.get(file) ?? 0) + 1;
      fault.statCalls.set(file, calls);
      if (file === fault.changeSourceOnRestat && calls === 2) appendFileSync(file, "edited");
      return real.stat(file);
    },
    // A drive that fills up part way through the copy.
    open: async (file: string, flags: string) => {
      const handle = await real.open(file, flags);
      if (!fault.fillDisk) return handle;
      return Object.assign(handle, {
        write: async () => {
          await real.appendFile(file, "par");
          throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
        },
      });
    },
    // A filesystem without hard links (exFAT), so the copy takes its name by rename.
    link: async (from: string, to: string) => {
      if (fault.noLinks) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      return real.link(from, to);
    },
  };
});

const { copyVerified, hashFile, PARTIAL_SUFFIX } = await import("./verifiedCopy.js");
const { DiskFullError } = await import("./freeSpace.js");

let dir: string;
let src: string;
let dest: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "lifer-verified-copy-"));
  src = path.join(dir, "IMG_0001.CR3");
  dest = path.join(dir, "copy", "IMG_0001.CR3");
  writeFileSync(src, "raw photo bytes");
  mkdirSync(path.dirname(dest));
  Object.assign(fault, { fillDisk: false, changeSourceOnRestat: null, noLinks: false });
  fault.statCalls.clear();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const untouched = () => expect(readFileSync(src, "utf8")).toBe("raw photo bytes");
const nothingLeft = () => {
  expect(existsSync(dest)).toBe(false);
  expect(existsSync(dest + PARTIAL_SUFFIX)).toBe(false);
};

describe("copyVerified", () => {
  it("copies the bytes, keeps the original's times and leaves no partial file", async () => {
    const taken = new Date("2021-05-04T10:00:00Z");
    utimesSync(src, taken, taken);
    const result = await copyVerified(src, dest);
    expect(readFileSync(dest, "utf8")).toBe("raw photo bytes");
    expect(statSync(dest).mtime.getTime()).toBe(taken.getTime());
    expect(result).toEqual({ sha256: await hashFile(src), size: 15 });
    expect(existsSync(dest + PARTIAL_SUFFIX)).toBe(false);
    untouched();
  });

  it("copies a file larger than one read chunk", async () => {
    const big = Buffer.alloc(3 * 1024 * 1024 + 7);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    writeFileSync(src, big);
    await copyVerified(src, dest);
    expect(readFileSync(dest).equals(big)).toBe(true);
  });

  it("never replaces a file already at the destination", async () => {
    writeFileSync(dest, "someone else's photo");
    await expect(copyVerified(src, dest)).rejects.toMatchObject({ code: "EEXIST" });
    expect(readFileSync(dest, "utf8")).toBe("someone else's photo");
    expect(existsSync(dest + PARTIAL_SUFFIX)).toBe(false);
    untouched();
  });

  it("removes a copy that reads back differently from the original", async () => {
    const corrupting = async (file: string) => {
      writeFileSync(file, "raw photo bytez");
      return hashFile(file);
    };
    await expect(copyVerified(src, dest, { rehash: corrupting })).rejects.toMatchObject({ code: "verify_failed" });
    nothingLeft();
    untouched();
  });

  it("gives up when the source changes while it is being copied", async () => {
    fault.changeSourceOnRestat = src;
    await expect(copyVerified(src, dest)).rejects.toMatchObject({ code: "source_changed" });
    nothingLeft();
    expect(readFileSync(src, "utf8")).toBe("raw photo bytesedited");
  });

  it("reports a full drive plainly and removes the partial file", async () => {
    fault.fillDisk = true;
    await expect(copyVerified(src, dest)).rejects.toBeInstanceOf(DiskFullError);
    nothingLeft();
    untouched();
  });

  it("reuses a partial file an interrupted run left behind", async () => {
    writeFileSync(dest + PARTIAL_SUFFIX, "half a photo from a crash, longer than the real one");
    await copyVerified(src, dest);
    expect(readFileSync(dest, "utf8")).toBe("raw photo bytes");
    expect(existsSync(dest + PARTIAL_SUFFIX)).toBe(false);
  });

  it("takes its name by rename on a filesystem without hard links, still never replacing", async () => {
    fault.noLinks = true;
    await copyVerified(src, dest);
    expect(readFileSync(dest, "utf8")).toBe("raw photo bytes");
    expect(existsSync(dest + PARTIAL_SUFFIX)).toBe(false);
  });

  it("fails without a trace when the destination folder is missing", async () => {
    const lost = path.join(dir, "missing", "x.CR3");
    await expect(copyVerified(src, lost)).rejects.toMatchObject({ code: "ENOENT" });
    expect(existsSync(path.dirname(lost))).toBe(false);
    untouched();
  });
});
