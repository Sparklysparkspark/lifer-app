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

  it("refuses siblings, traversal, and relative paths with a 403", async () => {
    const { assertAllowedPath, PathNotAllowedError } = await load({ desktop: false });
    expect(() => assertAllowedPath(outside)).toThrow(PathNotAllowedError);
    expect(() => assertAllowedPath(path.join(nas, "..", "outside"))).toThrow(PathNotAllowedError);
    expect(() => assertAllowedPath("nas/trips")).toThrow(PathNotAllowedError);
    try {
      assertAllowedPath(outside);
    } catch (err) {
      expect((err as { statusCode: number }).statusCode).toBe(403);
    }
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
});
