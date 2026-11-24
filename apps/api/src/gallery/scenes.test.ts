import { describe, expect, it } from "vitest";
import { BURST_JOIN, SCENE_GAP_MS, groupBursts, groupScenes, sceneOf, type SceneFrame } from "./scenes.js";

// Unit vectors whose cosine with unit(0) is `similarity`.
const unit = (similarity: number) => {
  const a = Math.acos(similarity);
  return [Math.cos(a), Math.sin(a)];
};
const T0 = Date.UTC(2025, 4, 1, 10);
const frame = (id: string, ms: number, more: Partial<SceneFrame> = {}): SceneFrame => ({
  id,
  at: T0 + ms,
  body: "R5",
  lens: "600mm",
  lat: null,
  lon: null,
  ...more,
});
const run = (prefix: string, n: number, startMs: number, stepMs: number, more: Partial<SceneFrame> = {}) =>
  Array.from({ length: n }, (_, i) => frame(`${prefix}${i}`, startMs + i * stepMs, more));

describe("groupBursts", () => {
  it("cuts at half a second when the camera wrote sub-seconds", () => {
    const frames = [...run("a", 5, 120, 120), ...run("b", 3, 120 + 4 * 120 + 501, 120)];
    expect(groupBursts(frames).map((b) => b.length)).toEqual([5, 3]);
  });

  it("falls back to a one-second gap on whole-second times", () => {
    const frames = [...run("a", 4, 0, 1000), frame("b", 5000)];
    expect(groupBursts(frames)).toEqual([["a0", "a1", "a2", "a3"], ["b"]]);
  });

  it("never mixes two camera bodies", () => {
    const frames = [frame("a", 100), frame("b", 200, { body: "R7" }), frame("c", 300)];
    expect(groupBursts(frames)).toEqual([["a", "c"], ["b"]]);
  });

  it("cuts where the picture changes completely, and rejoins a pause that looks the same", () => {
    const frames = [frame("a", 100), frame("b", 200), frame("c", 300), frame("d", 5100)];
    const vectors = new Map([
      ["a", unit(1)],
      ["b", unit(1)],
      ["c", unit(0.3)],
      ["d", unit(0.99)],
    ]);
    // c looks nothing like b. d looks like a and b, but c sits between them, so d stays apart.
    expect(groupBursts(frames, vectors)).toEqual([["a", "b"], ["c"], ["d"]]);
    const paused = [frame("a", 100), frame("b", 200), frame("d", 200 + BURST_JOIN.withinMs - 1)];
    expect(groupBursts(paused, new Map([...vectors].filter(([k]) => k !== "c")))).toEqual([["a", "b", "d"]]);
  });
});

describe("groupScenes", () => {
  const scenesOf = (frames: SceneFrame[], vectors = new Map<string, number[]>()) =>
    groupScenes(groupBursts(frames, vectors), frames, vectors).map((s) => s.map((b) => b[0]));

  it("keeps bursts a little apart together and splits after five minutes", () => {
    const frames = [frame("a", 0), frame("b", 40_000), frame("c", 40_000 + SCENE_GAP_MS + 1)];
    expect(scenesOf(frames)).toEqual([["a", "b"], ["c"]]);
  });

  it("splits when the camera moved more than 200 m", () => {
    const frames = [frame("a", 0, { lat: 49, lon: -123 }), frame("b", 30_000, { lat: 49.003, lon: -123 })];
    expect(scenesOf(frames)).toEqual([["a"], ["b"]]);
  });

  it("splits a different subject, and keeps the same one, by mean vector", () => {
    const frames = [frame("a", 0), frame("b", 20_000), frame("c", 40_000)];
    const vectors = new Map([
      ["a", unit(1)],
      ["b", unit(0.95)],
      ["c", unit(0.2)],
    ]);
    expect(scenesOf(frames, vectors)).toEqual([["a", "b"], ["c"]]);
  });

  it("without vectors, splits on a lens change or a gap well over the usual one", () => {
    expect(scenesOf([frame("a", 0), frame("b", 10_000, { lens: "100mm" })])).toEqual([["a"], ["b"]]);
    // Usual gap 5 s, so 8x is 40 s, but never under two minutes: 3 minutes splits.
    const frames = [frame("a", 0), frame("b", 5000), frame("c", 10_000), frame("d", 10_000 + 180_000)];
    expect(scenesOf(frames)).toEqual([["a", "b", "c"], ["d"]]);
  });
});

describe("sceneOf", () => {
  it("finds the photo's burst and frame", () => {
    const frames = [...run("a", 3, 120, 120), ...run("b", 2, 30_120, 120)];
    expect(sceneOf("b1", frames)).toMatchObject({
      bursts: [
        ["a0", "a1", "a2"],
        ["b0", "b1"],
      ],
      burst: 1,
      frame: 1,
      truncated: false,
    });
    expect(sceneOf("zz", frames)).toBeNull();
  });

  it("cuts a long burst to the frames around the photo", () => {
    const frames = run("f", 400, 100, 100);
    const answer = sceneOf("f390", frames, new Map(), 300)!;
    expect(answer.truncated).toBe(true);
    expect(answer.bursts).toHaveLength(1);
    expect(answer.bursts[0]).toHaveLength(300);
    expect(answer.bursts[0][answer.frame]).toBe("f390");
    expect(answer.bursts[0].at(-1)).toBe("f399");
  });

  it("keeps whole bursts nearest the photo when the scene is too big", () => {
    const frames = [...run("a", 4, 120, 120), ...run("b", 3, 20_120, 120), ...run("c", 4, 40_120, 120)];
    const answer = sceneOf("b0", frames, new Map(), 8)!;
    expect(answer).toMatchObject({ burst: 1, frame: 0, truncated: true });
    expect(answer.bursts.map((b) => b[0])).toEqual(["a0", "b0"]);
  });
});
