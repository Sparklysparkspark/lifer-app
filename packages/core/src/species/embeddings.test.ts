// cosineSimilarity/l2Normalize underpin suggestion ranking and every threshold, so edge
// behavior matters.
import { beforeEach, describe, expect, it } from "vitest";
import {
  CLIP_SPACE,
  computeEmbedding,
  cosineSimilarity,
  ID_SPACE,
  invalidateSuggestionCache,
  invalidateUserVectors,
  l2Normalize,
  matchTargets,
  rankSpeciesByEmbedding,
} from "./embeddings.js";
import { TEXT_MODEL_VERSION } from "./textEmbedding.js";

describe("l2Normalize", () => {
  it("scales a vector to unit length", () => {
    const normalized = l2Normalize(new Float32Array([3, 4]));
    const magnitude = Math.sqrt(normalized[0] ** 2 + normalized[1] ** 2);
    expect(magnitude).toBeCloseTo(1, 5);
    expect(normalized[0]).toBeCloseTo(0.6, 5);
    expect(normalized[1]).toBeCloseTo(0.8, 5);
  });

  // Boundary value: an all-zero vector has zero magnitude; the `|| 1` fallback avoids NaN.
  it("boundary value: an all-zero vector doesn't produce NaN (divide-by-zero guard)", () => {
    const normalized = l2Normalize(new Float32Array([0, 0, 0]));
    expect(normalized).toBeInstanceOf(Float32Array);
    expect(Array.from(normalized)).toEqual([0, 0, 0]);
    expect(normalized.every((v) => Number.isFinite(v))).toBe(true);
  });

  it("a single-element vector normalizes to exactly 1 (or -1)", () => {
    expect(Array.from(l2Normalize(new Float32Array([5])))).toEqual([1]);
    expect(Array.from(l2Normalize(new Float32Array([-5])))).toEqual([-1]);
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

  // Boundary value: the near-duplicate threshold is a strict >= 0.95 comparison, so behavior
  // right at that line matters.
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
  // A rejected getSession must not surface as an unhandled rejection through the separate
  // promise work.finally() returns, which would crash the process.
  it("never leaves an unhandled rejection when the model isn't downloaded, single call", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      // Whatever the reason, it must reject cleanly, not crash the process.
      await expect(computeEmbedding(Buffer.from("not a real image"))).rejects.toThrow();
      // The leaked promise would settle on a later tick, so wait one.
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

describe("matchTargets", () => {
  it("keeps the reference gallery when the user has their own photos of a species", () => {
    const targets = matchTargets({ your_embeddings: [[1, 0]], ref_embedding: [0, 1], gallery_embeddings: [[0.5, 0.5]] });
    expect(targets.map((t) => t.source)).toEqual(["your_photos", "reference_photo", "reference_photo"]);
    expect(targets[0].factor).toBeLessThan(1);
    expect(targets[1].factor).toBe(1);
  });

  it("uses every one of the user's photos, not just the latest", () => {
    const targets = matchTargets({ your_embeddings: [[1, 0], [0, 1]], ref_embedding: null, gallery_embeddings: null });
    expect(targets).toHaveLength(2);
  });

  it("returns nothing when there's nothing to match against", () => {
    expect(matchTargets({ your_embeddings: null, ref_embedding: null, gallery_embeddings: null })).toEqual([]);
  });
});

describe("rankSpeciesByEmbedding", () => {
  beforeEach(() => {
    invalidateSuggestionCache();
    invalidateUserVectors("u1");
  });

  // Answers the three queries a regional ranking makes: the region's cached catalog, which of
  // your own photos have vectors, and those vectors themselves.
  function fakePool(catalog: object[], yours: Array<{ capture_id: string; species_id: string; embedding: number[] }> = []) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const query = async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes("FROM region_species")) return { rows: catalog };
      if (sql.includes("JOIN captures c ON c.id = ce.capture_id")) return { rows: yours.map((y) => ({ capture_id: y.capture_id, species_id: y.species_id, computed_at: "t1" })) };
      if (sql.includes("capture_id = ANY")) return { rows: yours.map((y) => ({ capture_id: y.capture_id, embedding: y.embedding, computed_at: "t1" })) };
      return { rows: [] };
    };
    return { calls, pool: { query } as never };
  }
  const base = { is_vagrant: null, local_tier: null, seasonality: null, common_name: null };

  it("reads only the identification model's tables in ID_SPACE", async () => {
    const { pool, calls } = fakePool([]);
    await rankSpeciesByEmbedding(pool, "u1", [1, 0], "r1", 5, null, ID_SPACE);
    const all = calls.map((c) => c.sql).join("\n");
    expect(all).toContain("id_model_capture_embeddings");
    expect(all).toContain("id_model_gallery_embeddings");
    expect(all).toContain("id_model_text_embeddings");
    expect(all).not.toContain("species_reference_gallery_embeddings");
    expect(calls.find((c) => c.sql.includes("FROM region_species"))!.params).toEqual([ID_SPACE.modelVersion, ID_SPACE.textModelVersion, ["r1"]]);
    expect(calls.find((c) => c.sql.includes("JOIN captures c ON c.id = ce.capture_id"))!.params).toEqual(["u1", ID_SPACE.modelVersion]);
  });

  it("blends text at the space's weight and still uses the gallery when the user has photos", async () => {
    const { pool } = fakePool(
      [
        // Gallery matches perfectly; the user's own photo of it doesn't.
        { ...base, species_id: "a", scientific_name: "A a", ref_embedding: null, gallery_embeddings: [[1, 0]], text_embedding: [1, 0] },
        { ...base, species_id: "b", scientific_name: "B b", ref_embedding: [0, 1], gallery_embeddings: null, text_embedding: [0, 1] },
      ],
      [{ capture_id: "cap-a", species_id: "a", embedding: [0, 1] }],
    );
    const [top] = await rankSpeciesByEmbedding(pool, "u1", [1, 0], "r1", 5, null, CLIP_SPACE);
    expect(top.id).toBe("a");
    expect(top.source).toBe("reference_photo");
    expect(top.score).toBeCloseTo((1 - CLIP_SPACE.textWeight) * 1 + CLIP_SPACE.textWeight * 1);
  });

  // Rows of an older text model (a catalog asset not yet republished after a bump) are filtered
  // out in SQL and come back as no text vector, so they're never scored against.
  it("reads only the current text model's rows and ranks a species without one on its image", async () => {
    expect(CLIP_SPACE.textModelVersion).toBe(TEXT_MODEL_VERSION);
    const { pool, calls } = fakePool([{ ...base, species_id: "a", scientific_name: "A a", ref_embedding: [0.6, 0.8], gallery_embeddings: null, text_embedding: null }]);
    const [top] = await rankSpeciesByEmbedding(pool, "u1", [1, 0], "r3", 5, null, CLIP_SPACE);
    expect(calls.find((c) => c.sql.includes("FROM region_species"))!.params).toEqual([CLIP_SPACE.modelVersion, TEXT_MODEL_VERSION, ["r3"]]);
    expect(top.score).toBeCloseTo(0.6);
  });

  it("reads the region's reference vectors once, then serves them from memory", async () => {
    const { pool, calls } = fakePool([{ ...base, species_id: "a", scientific_name: "A a", ref_embedding: [1, 0], gallery_embeddings: null, text_embedding: null }]);
    await rankSpeciesByEmbedding(pool, "u1", [1, 0], "r2", 5, null, CLIP_SPACE);
    await rankSpeciesByEmbedding(pool, "u1", [1, 0], "r2", 5, null, CLIP_SPACE);
    expect(calls.filter((c) => c.sql.includes("FROM region_species"))).toHaveLength(1);
    invalidateSuggestionCache();
    await rankSpeciesByEmbedding(pool, "u1", [1, 0], "r2", 5, null, CLIP_SPACE);
    expect(calls.filter((c) => c.sql.includes("FROM region_species"))).toHaveLength(2);
  });
});
