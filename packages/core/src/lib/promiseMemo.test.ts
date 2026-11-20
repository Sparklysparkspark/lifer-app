import { afterEach, describe, expect, it, vi } from "vitest";
import { promiseMemo } from "./promiseMemo.js";

afterEach(() => vi.useRealTimers());

describe("promiseMemo", () => {
  it("shares one load between callers and keeps the resolved value", async () => {
    const memo = promiseMemo<string, number>(1000);
    const load = vi.fn(async () => 7);
    const [a, b] = await Promise.all([memo.get("k", load), memo.get("k", load)]);
    expect([a, b]).toEqual([7, 7]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(memo.entries.get("k")?.resolved).toBe(7);
  });

  it("forgets a rejected load so the next call retries", async () => {
    const memo = promiseMemo<string, number>(1000);
    await expect(memo.get("k", () => Promise.reject(new Error("down")))).rejects.toThrow("down");
    expect(memo.entries.has("k")).toBe(false);
    await expect(memo.get("k", async () => 2)).resolves.toBe(2);
  });

  it("loads again once an entry is older than the TTL", async () => {
    vi.useFakeTimers();
    const memo = promiseMemo<string, number>(1000);
    const load = vi.fn(async () => 1);
    await memo.get("k", load);
    vi.advanceTimersByTime(999);
    await memo.get("k", load);
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await memo.get("k", load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
