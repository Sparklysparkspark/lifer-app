import { describe, expect, it } from "vitest";
import { desktopModeStartupError } from "./config.js";

describe("desktopModeStartupError", () => {
  it("is fine outside desktop mode", () => {
    expect(desktopModeStartupError({})).toBeNull();
  });
  it("refuses desktop mode without a launch token", () => {
    expect(desktopModeStartupError({ SINGLE_USER_MODE: "1" })).toMatch(/LIFER_LAUNCH_TOKEN/);
  });
  it("allows the desktop app and the dev escape hatch", () => {
    expect(desktopModeStartupError({ SINGLE_USER_MODE: "1", LIFER_LAUNCH_TOKEN: "t" })).toBeNull();
    expect(desktopModeStartupError({ SINGLE_USER_MODE: "1", LIFER_ALLOW_UNTOKENED_DESKTOP: "1" })).toBeNull();
  });
});
