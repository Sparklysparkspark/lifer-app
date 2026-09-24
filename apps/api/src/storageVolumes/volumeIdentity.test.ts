import { describe, expect, it } from "vitest";
import { parseDfMountPath } from "./volumeIdentity.js";

describe("parseDfMountPath", () => {
  it("returns a plain mount path", () => {
    const out = "Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/disk3s1 976490576 123 456 12% /\n";
    expect(parseDfMountPath(out)).toBe("/");
  });

  it("keeps spaces in the mount path", () => {
    const out = "Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/disk4s2 976490576 123 456 5% /Volumes/My Photo Drive\n";
    expect(parseDfMountPath(out)).toBe("/Volumes/My Photo Drive");
  });

  it("handles a filesystem name with spaces", () => {
    const out = "Filesystem 512-blocks Used Available Capacity Mounted on\nmap auto_home 0 0 0 100% /System/Volumes/Data/home\n";
    expect(parseDfMountPath(out)).toBe("/System/Volumes/Data/home");
  });

  it("falls back to / on unexpected output", () => {
    expect(parseDfMountPath("garbage")).toBe("/");
  });
});
