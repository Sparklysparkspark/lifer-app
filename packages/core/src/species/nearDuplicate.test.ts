import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { findNearDuplicate } from "./nearDuplicate.js";
import { clearUserVectorCaches } from "./userIndex.js";

// Unit vectors: "same" matches the probe exactly, "close" at 0.96, "far" at 0.
const VECTORS: Record<string, number[]> = { same: [1, 0], close: [0.96, 0.28], far: [0, 1] };

function fakePool(live: Set<string>) {
  const confirmed: string[] = [];
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes("JOIN captures c ON c.id = ce.capture_id"))
      return { rows: Object.keys(VECTORS).map((id) => ({ capture_id: id, species_id: `s-${id}`, computed_at: "t" })) };
    if (sql.includes("SELECT capture_id, embedding"))
      return {
        rows: (params[0] as string[]).map((id) => ({ capture_id: id, embedding: VECTORS[id], computed_at: "t" })),
      };
    const id = params[0] as string;
    confirmed.push(id);
    return { rows: live.has(id) ? [{ capture_id: id }] : [] };
  });
  return { pool: { query } as unknown as Pool, confirmed };
}

beforeEach(() => clearUserVectorCaches());

describe("findNearDuplicate", () => {
  it("returns the closest photo above the threshold", async () => {
    const { pool, confirmed } = fakePool(new Set(["same", "close"]));
    expect(await findNearDuplicate(pool, "u1", [1, 0])).toEqual({ capture_id: "same" });
    expect(confirmed).toEqual(["same"]);
  });

  it("skips a match the database no longer has (trashed since the cache was read)", async () => {
    const { pool, confirmed } = fakePool(new Set(["close"]));
    expect(await findNearDuplicate(pool, "u2", [1, 0])).toEqual({ capture_id: "close" });
    expect(confirmed).toEqual(["same", "close"]);
  });

  it("finds nothing when the only close photo is gone", async () => {
    const { pool, confirmed } = fakePool(new Set(["far"]));
    expect(await findNearDuplicate(pool, "u3", [1, 0], 0.99)).toBeNull();
    expect(confirmed).toEqual(["same"]);
  });
});
