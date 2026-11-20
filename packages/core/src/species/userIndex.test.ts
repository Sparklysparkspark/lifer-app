import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

// A 1 MB budget (262,144 floats) holds two of these vectors but not three.
vi.hoisted(() => {
  process.env.LIFER_VECTOR_CACHE_MB = "1";
});
const FLOATS = 100_000;

const { captureVectors, clearYourVectorCache, invalidateUserVectors, userIndex } = await import("./userIndex.js");

function vectorPool() {
  const query = vi.fn(async (_sql: string, params: unknown[]) => ({
    rows: (params[0] as string[]).map((id) => ({
      capture_id: id,
      embedding: new Array<number>(FLOATS).fill(0),
      computed_at: "t1",
    })),
  }));
  return { pool: { query } as unknown as Pool, query };
}

const row = (id: string) => ({ capture_id: id, computed_at: "t1" });

describe("captureVectors", () => {
  it("evicts the least recently used vector once over the float budget", async () => {
    clearYourVectorCache();
    const { pool, query } = vectorPool();
    await captureVectors(pool, "capture_embeddings", "v", [row("a")]);
    await captureVectors(pool, "capture_embeddings", "v", [row("b")]);
    await captureVectors(pool, "capture_embeddings", "v", [row("a")]); // a is now the newest
    expect(query).toHaveBeenCalledTimes(2);
    await captureVectors(pool, "capture_embeddings", "v", [row("c")]); // over budget: b goes
    query.mockClear();
    await captureVectors(pool, "capture_embeddings", "v", [row("a"), row("c")]);
    expect(query).not.toHaveBeenCalled();
    await captureVectors(pool, "capture_embeddings", "v", [row("b")]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("reads a vector again when its computed_at changed", async () => {
    clearYourVectorCache();
    const { pool, query } = vectorPool();
    await captureVectors(pool, "capture_embeddings", "v", [row("d")]);
    await captureVectors(pool, "capture_embeddings", "v", [{ capture_id: "d", computed_at: "t2" }]);
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe("userIndex", () => {
  const indexRows = [{ capture_id: "c1", species_id: "s1", computed_at: "t1" }];

  it("forgets a failed read so the next call retries", async () => {
    const query = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValue({ rows: indexRows });
    const pool = { query } as unknown as Pool;
    await expect(userIndex(pool, "u-fail", "capture_embeddings", "v")).rejects.toThrow("db down");
    await expect(userIndex(pool, "u-fail", "capture_embeddings", "v")).resolves.toEqual(indexRows);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("shares one read until invalidateUserVectors drops it", async () => {
    const query = vi.fn().mockResolvedValue({ rows: indexRows });
    const pool = { query } as unknown as Pool;
    await Promise.all([
      userIndex(pool, "u-inv", "capture_embeddings", "v"),
      userIndex(pool, "u-inv", "capture_embeddings", "v"),
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    invalidateUserVectors("u-inv");
    await userIndex(pool, "u-inv", "capture_embeddings", "v");
    expect(query).toHaveBeenCalledTimes(2);
  });
});
