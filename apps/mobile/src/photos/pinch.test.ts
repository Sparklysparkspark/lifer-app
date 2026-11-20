import { describe, expect, it } from "vitest";
import { COLUMN_STEPS, pinchGate, pinchSteps, stepColumns } from "./pinch";

describe("pinchSteps", () => {
  it("does nothing until the scale clearly changes", () => {
    expect(pinchSteps(1.25, 1)).toEqual({ steps: 0, baseline: 1 });
    expect(pinchSteps(0.75, 1)).toEqual({ steps: 0, baseline: 1 });
  });
  it("commits one step at about 30% either way", () => {
    expect(pinchSteps(1.3, 1).steps).toBe(1);
    expect(pinchSteps(0.7, 1).steps).toBe(-1);
  });
  it("a long pinch commits several steps, and the baseline moves with them", () => {
    const out = pinchSteps(2.2, 1);
    expect(out.steps).toBe(3);
    expect(pinchSteps(2.2, out.baseline).steps).toBe(0);
    expect(pinchSteps(0.3, 1).steps).toBe(-3);
  });
  it("has hysteresis: reversing needs a fresh change from the new baseline", () => {
    const first = pinchSteps(1.3, 1);
    expect(pinchSteps(1.2, first.baseline).steps).toBe(0);
    expect(pinchSteps(0.9, first.baseline).steps).toBe(-1);
  });
});

describe("pinchGate", () => {
  it("waits out the settle time after a step, then commits the pinch it kept", () => {
    let t = 0;
    const g = pinchGate(() => t);
    g.begin();
    expect(g.update(1.4)).toBe(1);
    t = 100;
    expect(g.update(2)).toBe(0);
    t = 150;
    expect(g.update(2)).toBe(1);
    g.begin();
    expect(g.update(0.6)).toBe(-1);
  });
});

describe("stepColumns", () => {
  it("steps along 1, 3, 5, 7, 9, 12, 16 and stops at the ends", () => {
    expect(COLUMN_STEPS).toEqual([1, 3, 5, 7, 9, 12, 16]);
    expect(stepColumns(3, -1)).toBe(5);
    expect(stepColumns(5, -4)).toBe(16);
    expect(stepColumns(16, -2)).toBe(16);
    expect(stepColumns(3, 5)).toBe(1);
  });
  it("snaps an old saved count onto the ladder", () => {
    expect(stepColumns(4, 0)).toBe(3);
  });
});
