import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "lifer-libfolder-"));
  vi.resetModules();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.doUnmock("../config.js");
});

async function load(dataDir: string, singleUser: boolean) {
  vi.doMock("../config.js", () => ({
    DATA_DIR: dataDir,
    APP_DATA_DIR: root,
    SINGLE_USER_MODE: singleUser,
    LIBRARY_ROOTS: [],
  }));
  return import("./libraryFolder.js");
}

describe("libraryFolderStatus", () => {
  it("is ok while the library folder exists", async () => {
    const { libraryFolderStatus } = await load(root, false);
    expect(libraryFolderStatus()).toEqual({ ok: true, problems: [] });
  });

  it("reports a missing library folder with the Docker fix on a server", async () => {
    const gone = path.join(root, "Lifer");
    const { libraryFolderStatus } = await load(gone, false);
    const status = libraryFolderStatus();
    expect(status.ok).toBe(false);
    expect(status.problems).toHaveLength(1);
    expect(status.problems[0]).toMatchObject({ folder: "library", path: gone, problem: "missing" });
    expect(status.problems[0].message).toMatch(/Docker setup/);
  });

  it("points desktop users at Settings instead", async () => {
    const { libraryFolderStatus } = await load(path.join(root, "gone"), true);
    expect(libraryFolderStatus().problems[0].message).toMatch(/Settings > Storage/);
  });
});

describe("explainMissingLibraryFolder", () => {
  it("explains a failed write inside a missing library folder, and nothing else", async () => {
    const gone = path.join(root, "Lifer");
    const { explainMissingLibraryFolder } = await load(gone, false);
    const err = explainMissingLibraryFolder(path.join(gone, "Lifer Photos", "Birds"));
    expect(err?.statusCode).toBe(503);
    expect(err?.message).toMatch(/is missing/);
    expect(explainMissingLibraryFolder(path.join(root, "elsewhere"))).toBeNull();
  });
});
