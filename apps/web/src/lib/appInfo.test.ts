import { describe, expect, it } from "vitest";
import { GITHUB_REPO, macUpdateDownloadUrl } from "./appInfo";

const releases = `https://github.com/${GITHUB_REPO}/releases`;

describe("macUpdateDownloadUrl", () => {
  it("picks the zip built for this Mac's architecture", () => {
    expect(macUpdateDownloadUrl("1.2.0", "arm64")).toBe(`${releases}/download/v1.2.0/Lifer-macos-arm64.zip`);
    expect(macUpdateDownloadUrl("1.2.0", "x64")).toBe(`${releases}/download/v1.2.0/Lifer-macos-x64.zip`);
  });

  it("opens the release page when the architecture is unknown, rather than guessing a zip", () => {
    expect(macUpdateDownloadUrl("1.2.0", undefined)).toBe(`${releases}/tag/v1.2.0`);
    expect(macUpdateDownloadUrl("1.2.0", "riscv64")).toBe(`${releases}/tag/v1.2.0`);
  });
});
