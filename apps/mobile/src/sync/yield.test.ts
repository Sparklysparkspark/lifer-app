import { describe, expect, it } from "vitest";
import { inBatches, setIdleGate, settled, slicer, throttle, yieldNow } from "./yield";

describe("yield helpers", () => {
  it("runs batches in order and lets other work in between", async () => {
    const log: string[] = [];
    setTimeout(() => log.push("other"), 0);
    await inBatches([1, 2, 3, 4, 5], 2, async (b) => void log.push(b.join("")));
    expect(log).toEqual(["12", "other", "34", "5"]);
  });

  it("slicer yields only after its budget", async () => {
    let t = 0;
    const tick = slicer(8, () => t);
    const log: string[] = [];
    setTimeout(() => log.push("other"), 0);
    await tick();
    log.push("a");
    t = 9;
    await tick();
    log.push("b");
    expect(log).toEqual(["a", "other", "b"]);
  });

  it("throttle drops ticks inside the window and lets a forced one through", () => {
    let t = 0;
    const got: number[] = [];
    const f = throttle(
      (n: number) => got.push(n),
      500,
      () => t,
    );
    f(1);
    t = 100;
    f(2);
    t = 600;
    f(3);
    t = 610;
    f(4, true);
    expect(got).toEqual([1, 3, 4]);
  });

  it("settled waits on the gate", async () => {
    let open = false;
    setIdleGate(async () => {
      await yieldNow();
      open = true;
    });
    await settled();
    expect(open).toBe(true);
    setIdleGate(() => Promise.resolve());
  });
});
