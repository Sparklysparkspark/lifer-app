import { describe, expect, it } from "vitest";
import { candidateRuns, groupRun, pairKey, SIMILAR_RULES, type SimilarCandidate } from "./similar.js";

// Unit vectors whose cosine with unit(0) is `similarity`.
const unit = (similarity: number) => {
  const a = Math.acos(similarity);
  return [Math.cos(a), Math.sin(a)];
};
const at = (id: string, seconds: number, speciesId = "s1"): SimilarCandidate => ({
  id,
  speciesId,
  takenAt: seconds * 1000,
  computedAt: "t",
});

describe("candidateRuns", () => {
  it("keeps same-species photos within the widest rule together and drops loners", () => {
    const widest = SIMILAR_RULES[SIMILAR_RULES.length - 1].withinMs / 1000;
    const runs = candidateRuns([
      at("a", 0),
      at("b", 10),
      at("c", 10 + widest), // just within the widest gap of b
      at("d", 10 + widest * 2 + 1), // too far: alone
      at("e", 0, "s2"), // another species: never joins s1's run
    ]);
    expect(runs.map((r) => r.map((c) => c.id))).toEqual([["a", "b", "c"]]);
  });
});

describe("groupRun thresholds", () => {
  const group = (run: SimilarCandidate[], sims: Record<string, number>) =>
    groupRun(run, new Map(Object.entries(sims).map(([id, s]) => [id, unit(s)])));

  it("links a burst at the burst threshold but not just below it", () => {
    const burst = SIMILAR_RULES[0];
    const t = burst.withinMs / 1000;
    expect(group([at("a", 0), at("b", t)], { a: 1, b: burst.minSimilarity + 0.001 })).toEqual([["a", "b"]]);
    expect(group([at("a", 0), at("b", t)], { a: 1, b: burst.minSimilarity - 0.01 })).toEqual([]);
  });

  it("needs a closer match for a repeat minutes later than for a burst", () => {
    const [burst, repeat] = SIMILAR_RULES;
    const later = burst.withinMs / 1000 + 30;
    const between = (burst.minSimilarity + repeat.minSimilarity) / 2;
    expect(group([at("a", 0), at("b", later)], { a: 1, b: between })).toEqual([]);
    expect(group([at("a", 0), at("b", later)], { a: 1, b: repeat.minSimilarity + 0.001 })).toEqual([["a", "b"]]);
    expect(group([at("a", 0), at("b", repeat.withinMs / 1000 + 1)], { a: 1, b: 0.999 })).toEqual([]);
  });

  it("chains a drifting burst into one group and keeps a different scene apart", () => {
    // Each frame turns a little from the last; the first and last are far apart.
    const angles = [0, 0.3, 0.6, 0.9];
    const vectors = new Map(angles.map((a, i) => [`f${i}`, [Math.cos(a), Math.sin(a)]]));
    vectors.set("other", [Math.cos(2), Math.sin(2)]);
    const run = [at("f0", 0), at("f1", 1), at("f2", 2), at("other", 3), at("f3", 4)];
    expect(groupRun(run, vectors)).toEqual([["f0", "f1", "f2", "f3"]]);
  });

  it("leaves photos without a vector out of every group", () => {
    expect(group([at("a", 0), at("b", 1), at("c", 2)], { a: 1, c: 1 })).toEqual([["a", "c"]]);
  });

  it("handles a burst of thousands of frames in one pass", () => {
    const run = Array.from({ length: 5000 }, (_, i) => at(`f${i}`, i / 20));
    const vectors = new Map(run.map((c) => [c.id, [1, 0]]));
    const started = Date.now();
    expect(groupRun(run, vectors)).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("groupRun dismissals", () => {
  const vecs = new Map([
    ["a", unit(1)],
    ["b", unit(0.99)],
    ["c", unit(0.99)],
  ]);
  const run = [at("a", 0), at("b", 1), at("c", 2)];

  it("never links a dismissed pair directly, and a new photo can still join one of them", () => {
    expect(groupRun(run.slice(0, 2), vecs, new Set([pairKey("b", "a")]))).toEqual([]);
    expect(groupRun(run, vecs, new Set([pairKey("a", "b")]))).toEqual([["a", "b", "c"]]);
    expect(groupRun(run, vecs, new Set([pairKey("a", "b"), pairKey("a", "c")]))).toEqual([["b", "c"]]);
  });
});
