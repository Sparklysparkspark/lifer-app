import { afterEach, describe, expect, it } from "vitest";
import { clearBursts, joinBurst, pooledVectors, type BurstFrame } from "./bursts.js";

const unit = (...xs: number[]) => {
  const v = new Float32Array(xs);
  const n = Math.hypot(...xs);
  return v.map((x) => x / n);
};
const frame = (uploadId: string, seconds: number, clip: Float32Array, context = "r:m"): BurstFrame => ({
  uploadId,
  takenAt: seconds * 1000,
  clip,
  vectors: [unit(seconds + 1, 1)],
  context,
});

afterEach(clearBursts);

describe("joinBurst", () => {
  it("groups near-identical frames taken close together, whichever order they're checked in", () => {
    const scene = unit(1, 0.05);
    joinBurst("u", frame("b", 5, scene));
    joinBurst("u", frame("a", 0, scene));
    const frames = joinBurst("u", frame("c", 9, scene));
    expect(frames.map((f) => f.uploadId)).toEqual(["a", "b", "c"]);
  });

  it("keeps apart a different scene, a long gap, another region, and another user", () => {
    joinBurst("u", frame("a", 0, unit(1, 0)));
    expect(joinBurst("u", frame("other-scene", 1, unit(0, 1)))).toHaveLength(1);
    expect(joinBurst("u", frame("later", 1000, unit(1, 0)))).toHaveLength(1);
    expect(joinBurst("u", frame("elsewhere", 2, unit(1, 0), "r2:m"))).toHaveLength(1);
    expect(joinBurst("v", frame("someone-else", 2, unit(1, 0)))).toHaveLength(1);
  });

  it("merges two bursts a frame links", () => {
    joinBurst("u", frame("a", 0, unit(1, 0.3)));
    joinBurst("u", frame("b", 100, unit(1, -0.3)));
    const frames = joinBurst("u", frame("c", 50, unit(1, 0)));
    expect(frames.map((f) => f.uploadId)).toEqual(["a", "c", "b"]);
  });
});

describe("pooledVectors", () => {
  it("puts the frame's own vectors first and caps the rest", () => {
    const scene = unit(1, 0);
    let frames: BurstFrame[] = [];
    for (let i = 0; i < 12; i++) frames = joinBurst("u", frame(`f${i}`, i, scene));
    const own = frames[frames.length - 1];
    const pooled = pooledVectors(own, frames);
    expect(pooled[0]).toBe(own.vectors[0]);
    expect(pooled).toHaveLength(8);
  });
});
