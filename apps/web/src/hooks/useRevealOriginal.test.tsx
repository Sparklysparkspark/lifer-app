// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("../api/client", () => ({
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));
const mode = { current: "desktop" as "desktop" | "server" | null };
vi.mock("./useDeploymentMode", () => ({ useDeploymentMode: () => mode.current }));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock("./useToast", () => ({ useToast: () => toast }));

const { locateInRoots, resetMountedRoots, useRevealOriginal } = await import("./useRevealOriginal");

const invoke = vi.fn();
const setTauri = (on: boolean) => {
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = on ? { core: { invoke } } : undefined;
};

const ROOTS = [
  { root: "/data", relativePath: "originals/a.NEF", size: 5 },
  { root: "/data/library", relativePath: "2024/b.jpg", size: 9 },
];

describe("locateInRoots", () => {
  it("picks the most specific root and the path inside it", () => {
    expect(locateInRoots("/data/library/2024/x.jpg", ROOTS)).toEqual({ root: ROOTS[1], relativePath: "2024/x.jpg" });
    expect(locateInRoots("/data/originals/y.jpg", ROOTS)).toEqual({ root: ROOTS[0], relativePath: "originals/y.jpg" });
  });

  it("matches whole folder names only", () => {
    expect(locateInRoots("/data2/x.jpg", ROOTS)).toBeNull();
    expect(locateInRoots("/elsewhere/x.jpg", ROOTS)).toBeNull();
  });
});

describe("useRevealOriginal", () => {
  beforeEach(() => {
    resetMountedRoots();
    get.mockReset();
    post.mockReset().mockResolvedValue({ ok: true });
    invoke.mockReset();
  });
  afterEach(() => setTauri(false));

  it("offers nothing without a file", () => {
    setTauri(true);
    const { result } = renderHook(() => useRevealOriginal());
    expect(result.current(null)).toBeNull();
  });

  it("reveals through the local API in the desktop app's own library", () => {
    setTauri(true);
    mode.current = "desktop";
    const { result } = renderHook(() => useRevealOriginal());
    const action = result.current("/Users/me/Pictures/a.jpg")!;
    expect(action.kind).toBe("reveal");
    action.run();
    expect(post).toHaveBeenCalledWith("/originals/reveal", { path: "/Users/me/Pictures/a.jpg" });
  });

  it("reveals a server's file on this Mac when its folder is mounted here", async () => {
    setTauri(true);
    mode.current = "server";
    get.mockResolvedValue({ roots: ROOTS });
    invoke.mockImplementation(async (cmd: string, args: { serverRoot: string }) =>
      cmd === "server_root_on_this_mac" ? args.serverRoot === "/data" : undefined,
    );
    const { result } = renderHook(() => useRevealOriginal());
    await waitFor(() => expect(result.current("/data/originals/z.NEF")?.kind).toBe("reveal"));
    // The library root isn't mounted here, so its files can only be copied.
    expect(result.current("/data/library/2024/q.jpg")?.kind).toBe("copy");
    result.current("/data/originals/z.NEF")!.run();
    expect(invoke).toHaveBeenCalledWith("reveal_server_file", {
      serverRoot: "/data",
      relativePath: "originals/z.NEF",
    });
    // Only the folder goes to the Mac: it checks the server's own sample file itself.
    expect(invoke).toHaveBeenCalledWith("server_root_on_this_mac", { serverRoot: "/data" });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("looks for the share again when a reveal misses, then retries", async () => {
    setTauri(true);
    mode.current = "server";
    get.mockResolvedValue({ roots: ROOTS });
    invoke.mockImplementation(async (cmd: string, args: { serverRoot: string }) =>
      cmd === "server_root_on_this_mac" ? args.serverRoot === "/data" : undefined,
    );
    const { result } = renderHook(() => useRevealOriginal());
    await waitFor(() => expect(result.current("/data/originals/z.NEF")?.kind).toBe("reveal"));
    invoke.mockClear();
    let reveals = 0;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "server_root_on_this_mac") return true;
      if (++reveals === 1) throw new Error("moved");
    });
    result.current("/data/originals/z.NEF")!.run();
    await waitFor(() => expect(reveals).toBe(2));
    expect(get).toHaveBeenCalledTimes(2);
    expect(toast.error).not.toHaveBeenCalled();
    // Mounted since: the library root can be revealed too, without a reload.
    await waitFor(() => expect(result.current("/data/library/2024/q.jpg")?.kind).toBe("reveal"));
  });

  it("looks again when the window comes back to the front", async () => {
    setTauri(true);
    mode.current = "server";
    get.mockResolvedValue({ roots: ROOTS });
    invoke.mockResolvedValue(false);
    const { result } = renderHook(() => useRevealOriginal());
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    expect(result.current("/data/originals/z.NEF")?.kind).toBe("copy");
    invoke.mockResolvedValue(true);
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(result.current("/data/originals/z.NEF")?.kind).toBe("reveal"));
  });

  it("copies the path in a browser", async () => {
    setTauri(false);
    mode.current = "server";
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { result } = renderHook(() => useRevealOriginal());
    const action = result.current("/data/originals/z.NEF")!;
    expect(action.kind).toBe("copy");
    action.run();
    expect(writeText).toHaveBeenCalledWith("/data/originals/z.NEF");
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(get).not.toHaveBeenCalled();
  });
});
