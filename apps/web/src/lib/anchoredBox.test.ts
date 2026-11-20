import { describe, expect, it } from "vitest";
import { anchoredBox } from "./anchoredBox";

const view = { width: 1280, height: 800 };

describe("anchoredBox", () => {
  it("opens below an anchor with room under it, at least 224px wide", () => {
    expect(anchoredBox({ top: 100, bottom: 140, left: 50, width: 112 }, 200, view)).toEqual({
      left: 50,
      width: 224,
      top: 144,
      maxHeight: 320,
    });
  });

  it("opens above an anchor at the bottom of the window, as tall as there's room", () => {
    const box = anchoredBox({ top: 620, bottom: 790, left: 400, width: 112 }, 300, view);
    expect(box).toMatchObject({ bottom: 184, maxHeight: 320 });
    expect(box.top).toBeUndefined();
  });

  it("stays inside the window at the right edge", () => {
    expect(anchoredBox({ top: 100, bottom: 140, left: 1200, width: 112 }, 100, view).left).toBe(1280 - 224 - 8);
  });
});
