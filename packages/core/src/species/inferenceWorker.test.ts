import { MIN_CARD_CROP_PERCENT as SHARED_MIN } from "@lifer/shared";
import { describe, expect, it } from "vitest";
import { cardCropFor, mergeTileDetections, MIN_CARD_CROP_PERCENT, subjectCropRect } from "./inferenceWorker.js";

const outcome = (box: [number, number, number, number], width = 6000, height = 4000) =>
  ({ box, width, height, presence: {} }) as Parameters<typeof cardCropFor>[0];

describe("cardCropFor", () => {
  it("matches the shared minimum", () => {
    expect(MIN_CARD_CROP_PERCENT).toBe(SHARED_MIN);
  });

  it("never frames tighter than the minimum, centred on a tiny subject", () => {
    const crop = cardCropFor(outcome([3000, 2000, 3060, 2040]))!;
    expect(crop.size).toBeCloseTo(MIN_CARD_CROP_PERCENT);
    const centre = ((crop.x + crop.size / 2) / 100) * 6000;
    expect(centre).toBeCloseTo(3030);
  });

  it("pads a larger subject and stays inside the photo", () => {
    const crop = cardCropFor(outcome([5000, 3000, 5900, 3900]))!;
    expect(crop.size).toBeCloseTo((Math.min(900 * 1.3, 4000) / 6000) * 100);
    expect(crop.x + crop.size).toBeLessThanOrEqual(100 + 1e-9);
  });
});

describe("mergeTileDetections", () => {
  // Tile detections of a bird partly hidden by leaves, in pieces.
  const bird = 14;
  const flicker = [
    { score: 0.064, classIndex: bird, box: [2272, 1372, 3082, 2091] as [number, number, number, number] }, // leaves
    { score: 0.327, classIndex: bird, box: [3638, 1602, 4673, 2260] as [number, number, number, number] }, // head
    { score: 0.048, classIndex: bird, box: [2289, 2796, 2768, 3152] as [number, number, number, number] }, // leaves
    { score: 0.402, classIndex: bird, box: [4303, 2799, 4830, 3498] as [number, number, number, number] }, // belly
    { score: 0.186, classIndex: bird, box: [4783, 2946, 5221, 3475] as [number, number, number, number] },
  ];

  it("joins the pieces of one animal and leaves faint guesses out", () => {
    const merged = mergeTileDetections(flicker)!;
    expect(merged.box).toEqual([3638, 1602, 5221, 3498]);
    expect(merged.score).toBe(0.402);
  });

  it("keeps a distant animal out, and a different kind of animal", () => {
    const far = { score: 0.3, classIndex: bird, box: [100, 100, 400, 400] as [number, number, number, number] };
    const dog = { score: 0.3, classIndex: 16, box: [4000, 3500, 4600, 4000] as [number, number, number, number] };
    expect(mergeTileDetections([flicker[3], far, dog])!.box).toEqual(flicker[3].box);
  });
});

describe("subjectCropRect", () => {
  it("makes a tall subject's crop square around all of it, inside the photo", () => {
    // A standing heron near the right edge: 400 wide, 1600 tall.
    const rect = subjectCropRect(outcome([5500, 1000, 5900, 2600]))!;
    expect(rect.width).toBe(rect.height);
    expect(rect.left).toBeLessThanOrEqual(5500);
    expect(rect.top).toBeLessThanOrEqual(1000);
    expect(rect.left + rect.width).toBeGreaterThanOrEqual(5900);
    expect(rect.top + rect.height).toBeGreaterThanOrEqual(2600);
    expect(rect.left + rect.width).toBeLessThanOrEqual(6000);
  });

  it("caps the square at the photo's shorter side", () => {
    const rect = subjectCropRect(outcome([0, 0, 6000, 4000]))!;
    expect(rect.width).toBe(4000);
    expect(rect.height).toBe(4000);
  });
});
