import { describe, expect, it } from "vitest";

const { installerFor, isIntelMac, installErrorKey, SUGGESTED_APPS } = await import("./suggestedApps");

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
    expect(installerFor(app({ "linux-x86_64": { format: "deb" } }), "linux-x86_64")).toEqual({
      host: "dl.example.com",
      pending: false,
    });
  });

  it("never installs an AppImage or a missing target, and a placeholder is only Available soon", () => {
    expect(installerFor(app({ "linux-x86_64": { format: "appimage" } }), "linux-x86_64")).toBeUndefined();
    expect(installerFor(app({ "darwin-aarch64": { format: "dmg" } }), "linux-x86_64")).toBeUndefined();
    expect(
      installerFor(app({ "linux-x86_64": { format: "deb" } }, { minisignKeys: ["PLACEHOLDER"] }), "linux-x86_64")
        ?.pending,
    ).toBe(true);
  });

  it("picks the entry for each Mac chip, and only Intel is flagged slower", () => {
    const both = app({ "darwin-aarch64": { format: "dmg" }, "darwin-x86_64": { format: "dmg" } });
    expect(installerFor(both, "darwin-aarch64")).toBeDefined();
    expect(installerFor(both, "darwin-x86_64")).toBeDefined();
    expect(installerFor(app({ "darwin-aarch64": { format: "dmg" } }), "darwin-x86_64")).toBeUndefined();
    expect(installerFor(both, null)).toBeUndefined();
    expect(isIntelMac("darwin-x86_64")).toBe(true);
    expect(isIntelMac("darwin-aarch64")).toBe(false);
  });

  it("maps shell codes to words, and a cancel to nothing", () => {
    expect(installErrorKey("verification")).toBe("suggestedApps.error.verification");
    expect(installErrorKey("cancelled")).toBeNull();
    expect(installErrorKey(new Error("x"))).toBe("suggestedApps.failed");
  });
});
