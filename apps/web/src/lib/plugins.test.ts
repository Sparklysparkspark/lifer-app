import { describe, expect, it } from "vitest";
import { pluginPath, safeAccent, safeIconPath } from "./plugins";

describe("safeAccent", () => {
  it("accepts plain colour values", () => {
    for (const ok of [
      "#3a7",
      "#33aa77",
      "#33aa7788",
      "rgb(10 20 30)",
      "rgba(10, 20, 30, 0.5)",
      "hsl(120deg 40% 50%)",
    ]) {
      expect(safeAccent(ok)).toBe(ok);
    }
  });

  it("rejects anything that could carry CSS", () => {
    for (const bad of [
      "red",
      "url(https://x)",
      "#fff; background: red",
      "rgb(0 0 0)}",
      "var(--x)",
      "expression(1)",
      "",
    ]) {
      expect(safeAccent(bad)).toBeNull();
    }
  });
});

describe("safeIconPath", () => {
  it("accepts path data", () => {
    expect(safeIconPath("M4 4h7v7H4zM13 4l-2.5 3.5")).toBe("M4 4h7v7H4zM13 4l-2.5 3.5");
  });

  it("rejects markup, scripts and oversized data", () => {
    expect(safeIconPath('M0 0"><script>alert(1)</script>')).toBeNull();
    expect(safeIconPath("javascript:alert(1)")).toBeNull();
    expect(safeIconPath("M0 0".repeat(400))).toBeNull();
    expect(safeIconPath("")).toBeNull();
  });
});

describe("pluginPath", () => {
  it("encodes the id", () => {
    expect(pluginPath("com.example.app")).toBe("/apps/com.example.app");
    expect(pluginPath("a/b")).toBe("/apps/a%2Fb");
  });
});
