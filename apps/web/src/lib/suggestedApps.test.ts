import { describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({ platform: "other" }));
const { installerFor, installErrorKey, SUGGESTED_APPS } = await import("./suggestedApps");

const app = (platforms: Record<string, { format: string }>, extra = {}) => ({
  ...SUGGESTED_APPS[0],
  install: {
    feed: "https://dl.example.com/{channel}/latest.json",
    hosts: ["dl.example.com"],
    minisignKeys: ["RWQ"],
    platforms,
    ...extra,
  },
});

describe("installerFor", () => {
  it("names the feed host for a package this computer can open", () => {
    expect(installerFor(app({ "linux-x86_64": { format: "deb" } }))).toEqual({
      host: "dl.example.com",
      pending: false,
    });
  });

  it("never installs an AppImage or a missing target, and a placeholder is only Available soon", () => {
    expect(installerFor(app({ "linux-x86_64": { format: "appimage" } }))).toBeUndefined();
    expect(installerFor(app({ "darwin-aarch64": { format: "dmg" } }))).toBeUndefined();
    expect(installerFor(app({ "linux-x86_64": { format: "deb" } }, { minisignKeys: ["PLACEHOLDER"] }))?.pending).toBe(
      true,
    );
  });

  it("maps shell codes to words, and a cancel to nothing", () => {
    expect(installErrorKey("verification")).toBe("suggestedApps.error.verification");
    expect(installErrorKey("cancelled")).toBeNull();
    expect(installErrorKey(new Error("x"))).toBe("suggestedApps.failed");
  });
});
