// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }));
vi.mock("../api/client", () => ({ api }));
const env = vi.hoisted(() => ({ tauri: true, jobs: [] as Array<{ done: boolean }> }));
vi.mock("./tauri", () => ({ isTauri: () => env.tauri }));
vi.mock("./uploadQueue", () => ({ getUploadQueueState: () => ({ jobs: env.jobs }) }));
const relaunch = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch }));

const { changeLibraryFolder, resumeDownloadsAfterRestart } = await import("./libraryFolderChange");

const setLocalDataDir = vi.fn();
beforeEach(() => {
  env.tauri = true;
  env.jobs = [];
  localStorage.clear();
  api.put.mockResolvedValue({ dataDir: "/new", filesMoved: true });
  api.get.mockResolvedValue({ running: false, packIds: [] });
  api.post.mockResolvedValue({ started: true });
  relaunch.mockResolvedValue(undefined);
  setLocalDataDir.mockResolvedValue(undefined);
  window.liferSetup = { setLocalDataDir } as unknown as Window["liferSetup"];
});
afterEach(() => vi.clearAllMocks());

describe("changeLibraryFolder", () => {
  it("saves the folder, tells the desktop shell, then relaunches", async () => {
    expect(await changeLibraryFolder("/new")).toEqual({ kind: "restarting" });
    expect(api.put).toHaveBeenCalledWith("/settings/storage", { dataDir: "/new" });
    expect(setLocalDataDir).toHaveBeenCalledWith("/new");
    expect(relaunch).toHaveBeenCalled();
  });

  it("notes running downloads so they resume after the relaunch", async () => {
    api.get.mockResolvedValue({ running: true, packIds: ["ca-birds", "us-birds"] });
    await changeLibraryFolder("/new");
    await resumeDownloadsAfterRestart();
    expect(api.post).toHaveBeenCalledWith("/offline-packs/download", { packIds: ["ca-birds", "us-birds"] });
    // Only once: a later launch starts nothing.
    api.post.mockClear();
    await resumeDownloadsAfterRestart();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("refuses before saving anything while an import is still sending files", async () => {
    env.jobs = [{ done: false }];
    expect(await changeLibraryFolder("/new")).toEqual({ kind: "importsRunning" });
    expect(api.put).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("doesn't restart onto the old folder when the shell couldn't record the new one", async () => {
    setLocalDataDir.mockRejectedValue(new Error("disk is read-only"));
    expect(await changeLibraryFolder("/new")).toEqual({
      kind: "launchConfigFailed",
      error: expect.any(String),
      dataDir: "/new",
    });
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("asks for a manual restart outside the desktop app", async () => {
    env.tauri = false;
    expect(await changeLibraryFolder("/new")).toEqual({ kind: "restartManually", filesMoved: true });
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("passes an API failure on to the caller", async () => {
    api.put.mockRejectedValue(new Error("That folder isn't empty"));
    await expect(changeLibraryFolder("/new")).rejects.toThrow("That folder isn't empty");
    expect(relaunch).not.toHaveBeenCalled();
  });
});
