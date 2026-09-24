// cosineSimilarity/l2Normalize are the actual math behind species auto-suggest's ranking —
// every threshold this session tuned by hand (the 0.95 near-duplicate cutoff in
// uploads/routes.ts, the same-vs-cross-species gap used to compare CLIP model sizes) rests on
// these two functions behaving exactly as expected at the edges, not just on "normal" inputs.
import { describe, expect, it } from "vitest";
import { computeEmbedding, cosineSimilarity, l2Normalize } from "./embeddings.js";

describe("l2Normalize", () => {
  it("scales a vector to unit length", () => {
    const normalized = l2Normalize(new Float32Array([3, 4]));
    const magnitude = Math.sqrt(normalized[0] ** 2 + normalized[1] ** 2);
    expect(magnitude).toBeCloseTo(1, 5);
    expect(normalized[0]).toBeCloseTo(0.6, 5);
    expect(normalized[1]).toBeCloseTo(0.8, 5);
  });

  // Boundary value: an all-zero vector has zero magnitude — dividing by it would be
  // divide-by-zero/NaN without the `|| 1` fallback this function's implementation uses.
  it("boundary value: an all-zero vector doesn't produce NaN (divide-by-zero guard)", () => {
    const normalized = l2Normalize(new Float32Array([0, 0, 0]));
    expect(normalized).toEqual([0, 0, 0]);
    expect(normalized.every((v) => Number.isFinite(v))).toBe(true);
  });

  it("a single-element vector normalizes to exactly 1 (or -1)", () => {
    expect(l2Normalize(new Float32Array([5]))).toEqual([1]);
    expect(l2Normalize(new Float32Array([-5]))).toEqual([-1]);
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for identical (already-normalized) vectors", () => {
    const v = l2Normalize(new Float32Array([1, 2, 3]));
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("is -1 for exactly opposite vectors", () => {
    const v = l2Normalize(new Float32Array([1, 2, 3]));
    const opposite = v.map((x) => -x);
    expect(cosineSimilarity(v, opposite)).toBeCloseTo(-1, 5);
  });

  // Boundary value: the near-duplicate-photo threshold in uploads/routes.ts is a strict
  // >= 0.95 comparison — off-by-one-ULP behavior right at that line matters in practice.
  it("boundary value: scores exactly at a threshold-relevant value behave as plain arithmetic (no rounding surprises)", () => {
    expect(cosineSimilarity([0.95, 0], [1, 0])).toBeCloseTo(0.95, 10);
  });

  it("uses only the overlapping length when vectors differ in size, rather than throwing", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0])).toBe(1);
  });

  it("boundary value: empty vectors produce 0, not NaN or a thrown error", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("computeEmbedding", () => {
  // Regression test for a real crash: getSession's failure (no model downloaded) propagated
  // through a *separate* promise that work.finally() returns (distinct from `work` itself),
  // which nothing ever attached a handler to - Node flagged it as unhandled a tick later and
  // crashed the whole API process on every upload, even with the model genuinely missing and
  // the call site itself properly wrapped in try/catch. Confirmed live in production.
  it("never leaves an unhandled rejection when the model isn't downloaded, single call", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      // Whatever the reason (model missing, or a genuinely bad image once a model happens to
      // already be present in this environment), it must reject cleanly, not crash the process.
      await expect(computeEmbedding(Buffer.from("not a real image"))).rejects.toThrow();
      // The leaked promise settles on a later microtask/macrotask than the awaited call above,
      // so this needs a real tick to pass, not just a synchronous check.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it("never leaves an unhandled rejection when the model isn't downloaded, concurrent calls", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const results = await Promise.allSettled([
        computeEmbedding(Buffer.from("a")),
        computeEmbedding(Buffer.from("b")),
        computeEmbedding(Buffer.from("c")),
      ]);
      expect(results.every((r) => r.status === "rejected")).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});
