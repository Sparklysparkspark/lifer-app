import { describe, expect, it } from "vitest";
import { progressDisplay } from "./progressDisplay";

describe("progressDisplay", () => {
  it("is indeterminate for unknown or zero progress", () => {
    for (const v of [null, undefined, 0, -0.5, NaN, Infinity]) {
      expect(progressDisplay(v).indeterminate).toBe(true);
    }
  });

  it("keeps a tiny value visible with a 2% floor", () => {
    expect(progressDisplay(0.001)).toEqual({ indeterminate: false, widthPct: 2, percent: 0 });
  });

  it("uses the exact value, not a rounded percent", () => {
    const d = progressDisplay(0.12345);
    expect(d.widthPct).toBeCloseTo(12.345, 6);
    expect(d.percent).toBe(12);
  });

  it("clamps above 1", () => {
    expect(progressDisplay(1.7)).toEqual({ indeterminate: false, widthPct: 100, percent: 100 });
  });
});
