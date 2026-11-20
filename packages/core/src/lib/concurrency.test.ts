import { describe, expect, it } from "vitest";
import { createLimiter } from "./concurrency.js";

describe("createLimiter", () => {
  it("never runs more than max tasks at once and runs them all", async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        limit(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
          return i;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(results).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("never exceeds max when new callers arrive while slots are being handed over", async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const tick = () => Promise.resolve();
    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      for (let i = 0; i < Math.floor(Math.random() * 3); i++) await tick();
      active--;
    };
    const calls: Promise<void>[] = [];
    for (let i = 0; i < 200; i++) {
      calls.push(limit(task));
      for (let j = 0; j < Math.floor(Math.random() * 4); j++) await tick();
    }
    await Promise.all(calls);
    expect(peak).toBe(2);
  });

  it("releases the slot when a task throws", async () => {
    const limit = createLimiter(1);
    await expect(
      limit(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(limit(async () => 7)).resolves.toBe(7);
  });
});
