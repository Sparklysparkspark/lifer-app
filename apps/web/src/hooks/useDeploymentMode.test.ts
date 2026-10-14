import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../api/client", () => ({
  api: { get: (...args: unknown[]) => get(...args) },
}));

const { loadServerInfo } = await import("./useDeploymentMode");
const { resetSettingsCache } = await import("./useSettings");

describe("loadServerInfo", () => {
  beforeEach(() => {
    get.mockReset();
    resetSettingsCache();
  });

  it("makes one GET /settings request no matter how many callers ask", async () => {
    get.mockResolvedValue({
      deploymentMode: "server",
      dataDir: "/data",
      libraryRoots: [{ label: "NAS", path: "/library/nas" }],
    });
    const results = await Promise.all([loadServerInfo(), loadServerInfo(), loadServerInfo()]);
    await loadServerInfo();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/settings");
    expect(results[0]).toEqual({
      deploymentMode: "server",
      dataDir: "/data",
      libraryRoots: [{ label: "NAS", path: "/library/nas" }],
    });
  });

  it("retries on the next call after a failure", async () => {
    get
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ deploymentMode: "desktop", dataDir: "/x", libraryRoots: [] });
    await expect(loadServerInfo()).rejects.toThrow("offline");
    await expect(loadServerInfo()).resolves.toMatchObject({ deploymentMode: "desktop" });
    expect(get).toHaveBeenCalledTimes(2);
  });
});
