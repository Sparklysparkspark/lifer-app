import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./concurrency.js";

describe("mapWithConcurrency", () => {
  it("returns results in input order regardless of completion order", async () => {
    const delays = [30, 10, 20, 0];
    const results = await mapWithConcurrency(delays, 4, (ms) => new Promise((r) => setTimeout(() => r(ms), ms)));
    expect(results).toEqual(delays);
  });

  it("never runs more than `limit` items concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async (i) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return i;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("processes every item exactly once", async () => {
    const seen: number[] = [];
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (i) => {
      seen.push(i);
      return i * 2;
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("handles a limit larger than the item count without extra iterations", async () => {
    const results = await mapWithConcurrency(["a", "b"], 10, async (s) => s.toUpperCase());
    expect(results).toEqual(["A", "B"]);
  });

  it("returns an empty array for an empty input, without invoking fn", async () => {
    let calls = 0;
    const results = await mapWithConcurrency([], 4, async () => {
      calls++;
      return null;
    });
    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });

  it("propagates a rejection from fn", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (i) => {
        if (i === 2) throw new Error("boom");
        return i;
      }),
    ).rejects.toThrow("boom");
  });
});
