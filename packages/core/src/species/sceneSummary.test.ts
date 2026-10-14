import { describe, expect, it } from "vitest";
import { pixelColors, SCENE_LABELS, summarizeScene } from "./sceneSummary.js";

describe("SCENE_LABELS", () => {
  it("lists ADE20K's 150 classes in the model's order", () => {
    expect(SCENE_LABELS).toHaveLength(150);
    expect([SCENE_LABELS[2], SCENE_LABELS[21], SCENE_LABELS[32], SCENE_LABELS[149]]).toEqual([
      "sky",
      "water",
      "fence",
      "flag",
    ]);
  });
});

describe("pixelColors", () => {
  it.each([
    [[10, 10, 10], ["black"]],
    [[240, 240, 240], ["white"]],
    [[128, 128, 128], ["gray"]],
    [[230, 30, 30], ["red"]],
    [[240, 140, 30], ["orange"]],
    [[120, 70, 20], ["brown"]],
    [[230, 220, 40], ["yellow"]],
    [[40, 180, 60], ["green"]],
    [[40, 90, 220], ["blue"]],
    [[140, 50, 200], ["purple"]],
    [[230, 80, 180], ["pink"]],
    [[120, 40, 100], ["purple"]],
  ])("names %j %j", (rgb, names) => {
    expect(pixelColors(rgb[0], rgb[1], rgb[2])).toEqual(names);
  });

  it("counts dark plum red as both red and purple", () => {
    expect(pixelColors(110, 30, 40)).toEqual(["red", "purple"]);
    // Bright or washed-out reds stay just red.
    expect(pixelColors(200, 30, 40)).toEqual(["red"]);
    expect(pixelColors(110, 90, 90)).toEqual(["red"]);
  });
});

describe("summarizeScene", () => {
  it("gives each class and colour its share of the frame, one decimal, 1% and up", () => {
    const classes = new Uint8Array(1000);
    classes.fill(2, 0, 700); // sky
    classes.fill(21, 700, 995); // water
    classes.fill(32, 995); // fence, under 1%
    const rgb = new Uint8Array(3000);
    for (let i = 0; i < 1000; i++) rgb.set(i < 663 ? [40, 90, 220] : [240, 240, 240], i * 3);
    expect(summarizeScene(classes, rgb)).toEqual({
      labels: { sky: 70, water: 29.5 },
      colors: { blue: 66.3, white: 33.7 },
    });
  });
});
