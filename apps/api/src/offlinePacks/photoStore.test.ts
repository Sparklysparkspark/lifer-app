import { describe, expect, it } from "vitest";
import { planRanges, type PhotoRef } from "./photoStore.js";

const item = (shard: number, offset: number, length: number) => ({ ref: [shard, offset, length, "x"] as PhotoRef });

describe("planRanges", () => {
  it("joins photos close together in a shard into one request", () => {
    const ranges = planRanges([item(0, 0, 100), item(0, 150, 100), item(0, 1000, 50)]);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ shard: 0, start: 0, end: 1050 });
    expect(ranges[0].items).toHaveLength(3);
  });

  it("splits at a big gap, at a new shard, and at the size cap", () => {
    const gap = planRanges([item(0, 0, 100), item(0, 10_000_000, 100)]);
    expect(gap).toHaveLength(2);
    const shards = planRanges([item(1, 0, 100), item(0, 0, 100)]);
    expect(shards.map((r) => r.shard)).toEqual([0, 1]);
    const big = planRanges([item(0, 0, 20_000_000), item(0, 20_000_000, 20_000_000)]);
    expect(big).toHaveLength(2);
  });
});
