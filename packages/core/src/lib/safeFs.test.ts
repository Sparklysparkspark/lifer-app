import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The library folder points somewhere that doesn't exist, for the "library folder went away" case.
const missingLibrary = await vi.hoisted(async () => {
  const os = await import("node:os");
  const p = await import("node:path");
  const dir = p.join(os.tmpdir(), `lifer-safefs-missing-library-${process.pid}`);
  process.env.DATA_DIR = dir;
  process.env.APP_DATA_DIR = os.tmpdir();
  return dir;
});

// Real filesystem calls unless a test swaps one in, to act out what a misbehaving NAS does.
type FsCall = (...args: unknown[]) => Promise<unknown>;
const fake = vi.hoisted(() => ({
  calls: { mkdir: [] as string[] },
  stat: null as FsCall | null,
  mkdir: null as FsCall | null,
  access: null as FsCall | null,
  writeFile: null as FsCall | null,
  copyFile: null as FsCall | null,
  rename: null as FsCall | null,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const swappable =
    (name: "stat" | "mkdir" | "access" | "writeFile" | "copyFile" | "rename", original: FsCall): FsCall =>
    (...args) => {
      if (name === "mkdir") fake.calls.mkdir.push(String(args[0]));
      return (fake[name] ?? original)(...args);
    };
  return {
    ...real,
    stat: swappable("stat", real.stat as FsCall),
    mkdir: swappable("mkdir", real.mkdir as FsCall),
    access: swappable("access", real.access as FsCall),
    writeFile: swappable("writeFile", real.writeFile as FsCall),
    copyFile: swappable("copyFile", real.copyFile as FsCall),
    rename: swappable("rename", real.rename as FsCall),
  };
});

import { ensureDir, writeNewFile, copyToNewFile, moveToFolder, uniqueDestination } from "./safeFs.js";

// `rejects.toThrow(text)` also passes when a promise rejects with null, so check the error itself.
async function rejection(promise: Promise<unknown>): Promise<Error> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return err as Error;
}

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "lifer-safefs-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  fake.calls.mkdir = [];
  fake.stat = fake.mkdir = fake.access = fake.writeFile = fake.copyFile = fake.rename = null;
});

describe("ensureDir", () => {
  it("creates only the missing levels, one at a time from the top", async () => {
    const dir = path.join(root, "Wildlife 2026", "Birds", "Pileated Woodpecker");
    await ensureDir(dir);
    expect(existsSync(dir)).toBe(true);
    expect(fake.calls.mkdir).toEqual([
      path.join(root, "Wildlife 2026"),
      path.join(root, "Wildlife 2026", "Birds"),
      path.join(root, "Wildlife 2026", "Birds", "Pileated Woodpecker"),
    ]);
    fake.calls.mkdir = [];
    await ensureDir(path.join(dir, "Adjusted"));
    expect(fake.calls.mkdir).toEqual([path.join(dir, "Adjusted")]);
  });

  it("is fine when the folder already exists", async () => {
    await expect(ensureDir(root)).resolves.toBeUndefined();
  });

  it("names the folder and the reason instead of retrying when a file is in the way", async () => {
    writeFileSync(path.join(root, "Birds"), "not a folder");
    const err = await ensureDir(path.join(root, "Birds", "Osprey", "RAW")).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(`Couldn't create folder ${path.join(root, "Birds")} (EEXIST)`);
    expect((err as Error).cause).toMatchObject({ code: "EEXIST" });
  });

  it("carries on when another request creates the same folder first", async () => {
    const dir = path.join(root, "Birds");
    const { mkdir } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    fake.mkdir = async () => {
      await mkdir(dir);
      throw fsError("EEXIST");
    };
    await expect(ensureDir(dir)).resolves.toBeUndefined();
  });

  it("gives up with a message, not an endless loop, when no part of the path exists", async () => {
    fake.stat = () => Promise.reject(fsError("ENOENT"));
    expect((await rejection(ensureDir(path.join(root, "Birds")))).message).toMatch(/no part of that path exists/);
  });

  it("says the library folder is missing instead of a bare ENOENT", async () => {
    fake.mkdir = () => Promise.reject(fsError("ENOENT"));
    const err = await rejection(ensureDir(path.join(missingLibrary, "Birds")));
    expect(err).toMatchObject({
      statusCode: 503,
      message: expect.stringMatching(/photo library folder .* is missing/),
    });
  });

  it("reports ENOENT as such outside the library folder", async () => {
    fake.mkdir = () => Promise.reject(fsError("ENOENT"));
    const err = await rejection(ensureDir(path.join(root, "Birds")));
    expect(err.message).toBe(`Couldn't create folder ${path.join(root, "Birds")} (ENOENT)`);
  });

  it("doesn't blame a permission error on a missing library folder", async () => {
    fake.mkdir = () => Promise.reject(fsError("EACCES"));
    expect((await rejection(ensureDir(path.join(missingLibrary, "Birds")))).message).toMatch(/\(EACCES\)$/);
  });

  it("uses the error message when the filesystem gives no code", async () => {
    fake.mkdir = () => Promise.reject(new Error("socket hang up"));
    expect((await rejection(ensureDir(path.join(root, "Birds")))).message).toMatch(/\(socket hang up\)$/);
  });

  it("fails when the filesystem says it created the folder but it isn't there", async () => {
    fake.mkdir = () => Promise.resolve(undefined);
    expect((await rejection(ensureDir(path.join(root, "Birds")))).message).toMatch(
      /still doesn't exist after creating it/,
    );
  });
});

describe("writeNewFile", () => {
  it("never overwrites: same name gets -2, -3", async () => {
    const dir = path.join(root, "Adjusted");
    const a = await writeNewFile(dir, "IMG_0001.jpg", Buffer.from("a"));
    const b = await writeNewFile(dir, "IMG_0001.jpg", Buffer.from("b"));
    const c = await writeNewFile(dir, "IMG_0001.jpg", Buffer.from("c"));
    expect([a, b, c].map((p) => path.basename(p))).toEqual(["IMG_0001.jpg", "IMG_0001-2.jpg", "IMG_0001-3.jpg"]);
    expect(readFileSync(a, "utf8")).toBe("a");
    expect(readFileSync(b, "utf8")).toBe("b");
    expect(readFileSync(c, "utf8")).toBe("c");
  });

  it("gives two uploads of the same name at the same moment their own files", async () => {
    const dir = path.join(root, "Adjusted");
    const paths = await Promise.all(["x", "y", "z", "w"].map((v) => writeNewFile(dir, "IMG_0001.jpg", Buffer.from(v))));
    expect(new Set(paths).size).toBe(4);
    expect(paths.map((p) => readFileSync(p, "utf8")).sort()).toEqual(["w", "x", "y", "z"]);
  });

  it("handles names without an extension", async () => {
    await writeNewFile(root, "README", Buffer.from("1"));
    expect(path.basename(await writeNewFile(root, "README", Buffer.from("2")))).toBe("README-2");
  });

  it("passes on a write error instead of trying other names", async () => {
    fake.writeFile = () => Promise.reject(fsError("EIO"));
    await expect(writeNewFile(root, "IMG_0001.jpg", Buffer.from("a"))).rejects.toMatchObject({ code: "EIO" });
  });

  it("stops with a message when every name is taken", async () => {
    fake.writeFile = () => Promise.reject(fsError("EEXIST"));
    await expect(writeNewFile(root, "IMG_0001.jpg", Buffer.from("a"))).rejects.toThrow(
      `Couldn't find a free file name for IMG_0001.jpg in ${root}`,
    );
  });
});

describe("copyToNewFile, moveToFolder, uniqueDestination", () => {
  it("copies without overwriting", async () => {
    const src = path.join(root, "clip.mp4");
    writeFileSync(src, "video");
    const dir = path.join(root, "Video");
    const first = await copyToNewFile(dir, "clip.mp4", src);
    writeFileSync(src, "second video");
    const second = await copyToNewFile(dir, "clip.mp4", src);
    expect(path.basename(second)).toBe("clip-2.mp4");
    expect(readFileSync(first, "utf8")).toBe("video");
    expect(readFileSync(second, "utf8")).toBe("second video");
    expect(existsSync(src)).toBe(true);
  });

  it("passes on a missing source instead of trying other names", async () => {
    await expect(copyToNewFile(root, "clip.mp4", path.join(root, "gone.mp4"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("stops with a message when every copy name is taken", async () => {
    fake.copyFile = () => Promise.reject(fsError("EEXIST"));
    await expect(copyToNewFile(root, "clip.mp4", path.join(root, "x"))).rejects.toThrow(
      /Couldn't find a free file name for clip.mp4/,
    );
  });

  it("moves into a new folder under a free name", async () => {
    const src = path.join(root, "holding", "IMG_0002.CR3");
    await ensureDir(path.dirname(src));
    writeFileSync(src, "raw");
    const dir = path.join(root, "Birds", "Osprey", "RAW");
    await ensureDir(dir);
    writeFileSync(path.join(dir, "IMG_0002.CR3"), "someone else");
    const dest = await moveToFolder(src, dir);
    expect(path.basename(dest)).toBe("IMG_0002-2.CR3");
    expect(readFileSync(dest, "utf8")).toBe("raw");
    expect(readFileSync(path.join(dir, "IMG_0002.CR3"), "utf8")).toBe("someone else");
    expect(existsSync(src)).toBe(false);
    expect(await uniqueDestination(dir, "IMG_0002.CR3")).toBe(path.join(dir, "IMG_0002-3.CR3"));
  });

  it("copies then deletes when the destination is on another drive", async () => {
    const src = path.join(root, "IMG_0003.CR3");
    writeFileSync(src, "raw");
    fake.rename = () => Promise.reject(fsError("EXDEV"));
    const dest = await moveToFolder(src, path.join(root, "RAW"), "Osprey.CR3");
    expect(dest).toBe(path.join(root, "RAW", "Osprey.CR3"));
    expect(readFileSync(dest, "utf8")).toBe("raw");
    expect(existsSync(src)).toBe(false);
  });

  it("uniqueDestination stops with a message when every name is taken", async () => {
    fake.access = () => Promise.resolve(undefined);
    await expect(uniqueDestination(root, "IMG.jpg")).rejects.toThrow(
      `Couldn't find a free file name for IMG.jpg in ${root}`,
    );
  });
});
