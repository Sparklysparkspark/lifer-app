import { describe, expect, it } from "vitest";
import { shouldDismiss } from "./dismiss";

const H = 800;

describe("shouldDismiss", () => {
  it("springs back from a short slow drag", () => {
    expect(shouldDismiss(60, 100, H)).toBe(false);
  });
  it("closes past the distance threshold", () => {
    expect(shouldDismiss(H * 0.2, 0, H)).toBe(true);
  });
  it("closes on a fast downward flick from a short drag", () => {
    expect(shouldDismiss(40, 1500, H)).toBe(true);
  });
  it("ignores a flick with almost no travel", () => {
    expect(shouldDismiss(10, 1500, H)).toBe(false);
  });
  it("stays open when the finger moves back up before letting go", () => {
    expect(shouldDismiss(H * 0.3, -600, H)).toBe(false);
  });
  it("never closes on an upward drag", () => {
    expect(shouldDismiss(-300, -2000, H)).toBe(false);
  });
});
