import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmp: string;
let dataDir: string;
let nas: string;
let outside: string;

async function load(opts: { desktop: boolean; roots?: { label: string; path: string }[] }) {
  vi.resetModules();
  vi.doMock("../config.js", () => ({
    DATA_DIR: dataDir,
    SINGLE_USER_MODE: opts.desktop,
    LIBRARY_ROOTS: opts.roots ?? [{ label: "NAS", path: nas }],
  }));
  return import("./allowedPaths.js");
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "lifer-allowed-")));
  dataDir = path.join(tmp, "data");
  nas = path.join(tmp, "nas");
  outside = path.join(tmp, "outside");
  for (const d of [dataDir, path.join(nas, "trips", "Alaska"), outside]) mkdirSync(d, { recursive: true });
});
afterEach(() => {
  vi.doUnmock("../config.js");
  rmSync(tmp, { recursive: true, force: true });
});

describe("assertAllowedPath", () => {
  it("allows anything on desktop", async () => {
    const { assertAllowedPath } = await load({ desktop: true });
    expect(assertAllowedPath(outside)).toBe(outside);
  });

  it("allows DATA_DIR and folders inside a declared root", async () => {
    const { assertAllowedPath } = await load({ desktop: false });
    expect(assertAllowedPath(dataDir)).toBe(dataDir);
    expect(assertAllowedPath(path.join(nas, "trips", "Alaska"))).toBe(path.join(nas, "trips", "Alaska"));
  });

  it("refuses siblings and traversal with a 403", async () => {
    const { assertAllowedPath, PathNotAllowedError } = await load({ desktop: false });
    const forbidden = expect.objectContaining({ statusCode: 403, name: "PathNotAllowedError" });
    expect(() => assertAllowedPath(outside)).toThrow(forbidden);
    expect(() => assertAllowedPath(path.join(nas, "..", "outside"))).toThrow(PathNotAllowedError);
    // A sibling whose name starts with the root's: a startsWith check would let it through.
    mkdirSync(`${nas}-private`);
    expect(() => assertAllowedPath(`${nas}-private`)).toThrow(PathNotAllowedError);
  });

  it("refuses a relative path even when it would resolve inside a root", async () => {
    const { assertAllowedPath, PathNotAllowedError } = await load({ desktop: false });
    const relativeIntoRoot = path.relative(process.cwd(), path.join(nas, "trips"));
    expect(path.isAbsolute(relativeIntoRoot)).toBe(false);
    expect(() => assertAllowedPath(relativeIntoRoot)).toThrow(PathNotAllowedError);
  });

  it("answers a non-string path (a bad request body) with a 403, not a crash", async () => {
    const { assertAllowedPath } = await load({ desktop: false });
    expect(() => assertAllowedPath(42 as unknown as string)).toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  it("gives the same answer for a missing path outside the roots as an existing one", async () => {
    const { assertAllowedPath } = await load({ desktop: false });
    const existing = () => assertAllowedPath(outside);
    const missing = () => assertAllowedPath(path.join(tmp, "does-not-exist"));
    expect(existing).toThrowError(/LIFER_LIBRARY_ROOTS/);
    expect(missing).toThrowError(/LIFER_LIBRARY_ROOTS/);
  });

  it("refuses a missing path inside a root", async () => {
    const { assertAllowedPath } = await load({ desktop: false });
    expect(() => assertAllowedPath(path.join(nas, "nope"))).toThrowError(/doesn't exist/);
  });

  it("refuses a symlink inside a root that leads outside it", async () => {
    symlinkSync(outside, path.join(nas, "escape"));
    const { assertAllowedPath } = await load({ desktop: false });
    expect(() => assertAllowedPath(path.join(nas, "escape"))).toThrowError(/LIFER_LIBRARY_ROOTS/);
  });

  it("accepts the realpath it returns when DATA_DIR is reached through a symlink", async () => {
    // Like macOS's /tmp -> /private/tmp: the configured DATA_DIR is a symlink to the real folder.
    const realData = dataDir;
    const linkedData = path.join(tmp, "linked-data");
    symlinkSync(realData, linkedData);
    mkdirSync(path.join(realData, "Costa Rica"));
    dataDir = linkedData;
    const { assertAllowedPath, allowedRootFor } = await load({ desktop: false });
    const source = assertAllowedPath(path.join(linkedData, "Costa Rica"));
    expect(source).toBe(path.join(realData, "Costa Rica"));
    // A path built from that realpath (a trip's default destination parent) is still allowed.
    expect(assertAllowedPath(source)).toBe(source);
    expect(assertAllowedPath(realData)).toBe(realData);
    expect(allowedRootFor(path.join(source, "Wildlife"))?.label).toBe("Lifer library");
  });

  it("still refuses an escape when DATA_DIR is reached through a symlink", async () => {
    const realData = dataDir;
    const linkedData = path.join(tmp, "linked-data");
    symlinkSync(realData, linkedData);
    symlinkSync(outside, path.join(realData, "escape"));
    mkdirSync(`${realData}2`);
    dataDir = linkedData;
    const { assertAllowedPath, PathNotAllowedError } = await load({ desktop: false });
    expect(() => assertAllowedPath(path.join(realData, "escape"))).toThrow(PathNotAllowedError);
    expect(() => assertAllowedPath(path.join(linkedData, "escape"))).toThrow(PathNotAllowedError);
    expect(() => assertAllowedPath(path.join(realData, ".."))).toThrow(PathNotAllowedError);
    expect(() => assertAllowedPath(`${realData}2`)).toThrow(PathNotAllowedError);
    expect(() => assertAllowedPath(outside)).toThrow(PathNotAllowedError);
  });

  it("picks the most specific root when roots are nested", async () => {
    const inner = path.join(nas, "trips");
    const { allowedRootFor } = await load({
      desktop: false,
      roots: [
        { label: "NAS", path: nas },
        { label: "Trips", path: inner },
      ],
    });
    expect(allowedRootFor(path.join(inner, "Alaska"))?.label).toBe("Trips");
    expect(allowedRootFor(nas)?.label).toBe("NAS");
    expect(allowedRootFor(outside)).toBeNull();
  });

  it("picks the most specific root whatever order the roots are listed in", async () => {
    const inner = path.join(nas, "trips");
    const { allowedRootFor } = await load({
      desktop: false,
      roots: [
        { label: "Trips", path: inner },
        { label: "NAS", path: nas },
      ],
    });
    expect(allowedRootFor(path.join(inner, "Alaska"))?.label).toBe("Trips");
  });

  it("labels DATA_DIR as the Lifer library, even when it's also listed as a library root", async () => {
    const { allowedRootFor, allowedRoots } = await load({ desktop: false, roots: [{ label: "Data", path: dataDir }] });
    expect(allowedRoots()[0]).toEqual({ label: "Lifer library", path: dataDir });
    expect(allowedRootFor(path.join(dataDir, "Birds"))?.label).toBe("Lifer library");
  });
});
