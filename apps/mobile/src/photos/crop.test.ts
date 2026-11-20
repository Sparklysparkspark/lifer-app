import { describe, expect, it } from "vitest";
import { cropFrame, toCrop } from "./crop";

describe("cropFrame", () => {
  it("places a landscape photo so the crop square fills the box", () => {
    // A 50% wide square at the left edge of a 3:2 photo: shown twice the box wide.
    expect(cropFrame({ x: 0, y: 0, size: 50 }, 1.5)).toEqual({
      width: "200%",
      height: "133.33333333333334%",
      left: "0%",
      top: "0%",
    });
    expect(cropFrame({ x: 25, y: 10, size: 50 }, 1.5)).toMatchObject({ left: "-50%", top: "-20%" });
  });

  it("falls back to centring with no crop or an unknown shape", () => {
    expect(cropFrame(null, 1.5)).toBeNull();
    expect(cropFrame({ x: 0, y: 0, size: 50 }, null)).toBeNull();
    expect(cropFrame({ x: 0, y: 0, size: 50 }, 0)).toBeNull();
  });

  it("clamps a crop that leaves the photo, as the hub's square does", () => {
    // 90% of the width on a very wide photo is taller than the photo: the full height shows.
    expect(cropFrame({ x: 0, y: 0, size: 90 }, 4)).toEqual({ width: "400%", height: "100%", left: "0%", top: "0%" });
    expect(cropFrame({ x: 60, y: 0, size: 50 }, 1)).toMatchObject({ width: "200%", left: "-100%" });
  });

  it("frames a full-height crop of a 3:2 photo whatever rounding the thumbnail has (Red Fox)", () => {
    const fox = { x: 4.581177234649658, y: 0, size: 66.6796875 };
    for (const aspect of [400 / 267, 2560 / 1707, 1.5, 400 / 266, 400 / 268]) {
      const f = cropFrame(fox, aspect)!;
      expect(f).not.toBeNull();
      // The photo covers the box: no gap at the bottom or right.
      expect(parseFloat(f.height) + parseFloat(f.top)).toBeGreaterThanOrEqual(99.99);
      expect(parseFloat(f.width) + parseFloat(f.left)).toBeGreaterThanOrEqual(100);
    }
  });

  it("reads a stored crop only when all three numbers exist", () => {
    expect(toCrop(1, 2, 3)).toEqual({ x: 1, y: 2, size: 3 });
    expect(toCrop(1, null, 3)).toBeNull();
    expect(toCrop(0, 0, 0)).toBeNull();
  });
});
