import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../api/client", () => ({ api: { get: (...args: unknown[]) => get(...args) } }));

const { loadSettings, refreshSettings, setLocalSettings, getSettingsState, resetSettingsCache } = await import("./useSettings");
const { loadServerInfo } = await import("./useDeploymentMode");

const base = { deploymentMode: "server", dataDir: "/data", libraryRoots: [], hideObscureSpecies: true, speciesNamingStyles: [] };

describe("settings cache", () => {
  beforeEach(() => {
    get.mockReset();
    resetSettingsCache();
  });

  it("shares one request between settings and server info callers", async () => {
    get.mockResolvedValue(base);
    await Promise.all([loadSettings(), loadServerInfo(), loadSettings()]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("merges local patches and refetches on refresh", async () => {
    get.mockResolvedValueOnce(base).mockResolvedValueOnce({ ...base, hideObscureSpecies: false });
    await loadSettings();
    setLocalSettings({ speciesNamingStyles: ["aba"] });
    expect(getSettingsState().settings?.speciesNamingStyles).toEqual(["aba"]);
    await refreshSettings();
    expect(getSettingsState().settings?.hideObscureSpecies).toBe(false);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("ignores a response that lands after a reset", async () => {
    let resolve!: (v: unknown) => void;
    get.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const stale = loadSettings();
    resetSettingsCache();
    resolve(base);
    await stale;
    expect(getSettingsState().settings).toBeNull();
  });

  it("defaults a missing libraryRoots to []", async () => {
    get.mockResolvedValue({ ...base, libraryRoots: undefined });
    expect((await loadSettings()).libraryRoots).toEqual([]);
  });
});
