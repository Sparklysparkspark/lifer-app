import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import {
  friendlySeconds,
  initialTimeLeft,
  MAX_RISE_S,
  nextTimeLeft,
  timeLeftLabel,
  type TimeLeft,
  type TimeLeftState,
} from "./timeLeft";

const t = i18n.t.bind(i18n);

/** Feeds readings every `stepMs`, `rate(atMs)` units per second, and returns what each showed. */
function run(total: number, ms: number, rate: (at: number) => number, stepMs = 250) {
  let state: TimeLeftState = initialTimeLeft();
  let done = 0;
  const out: Array<{ at: number; value: TimeLeft; estimate: number | null }> = [];
  for (let at = 0; at <= ms; at += stepMs) {
    if (at > 0) done = Math.min(total, done + (rate(at) * stepMs) / 1000);
    const next = nextTimeLeft(state, at, done, total);
    state = next.state;
    out.push({ at, value: next.value, estimate: state.estimate });
  }
  return out;
}

const seconds = (v: TimeLeft) => (v.kind === "left" ? v.seconds : null);

describe("nextTimeLeft", () => {
  it("measures before promising anything", () => {
    const out = run(100, 1750, () => 5);
    expect(out.every((o) => o.value.kind === "measuring")).toBe(true);
  });

  it("waits for a few percent even after a couple of seconds", () => {
    const out = run(1000, 3000, () => 5); // 1.5% after 3 s
    expect(out.at(-1)!.value.kind).toBe("measuring");
  });

  it("estimates from the measured rate, rounded to 5 s under a minute", () => {
    // 100 units at 4/s: 25 s in all, so about 20 s left after 5 s.
    const out = run(100, 5000, () => 4);
    expect(seconds(out.at(-1)!.value)).toBe(20);
  });

  it("counts down and never goes up, even with a jittery rate", () => {
    const out = run(600, 60_000, (at) => (Math.floor(at / 1000) % 2 ? 8 : 12));
    const shown = out.map((o) => seconds(o.value)).filter((s): s is number => s != null);
    expect(shown.length).toBeGreaterThan(10);
    for (let i = 1; i < shown.length; i++) expect(shown[i]).toBeLessThanOrEqual(shown[i - 1]);
  });

  it("lets the estimate rise by at most a few seconds per update", () => {
    // Slows by a third partway: the raw estimate jumps, the shown one creeps.
    const out = run(1000, 40_000, (at) => (at < 20_000 ? 15 : 10));
    for (let i = 1; i < out.length; i++) {
      const [a, b] = [out[i - 1], out[i]];
      if (a.estimate == null || b.estimate == null) continue;
      const countdown = a.estimate - (b.at - a.at) / 1000;
      expect(b.estimate).toBeLessThanOrEqual(countdown + MAX_RISE_S + 1e-9);
    }
  });

  it("goes back to measuring when the work stalls", () => {
    const out = run(1000, 30_000, (at) => (at < 10_000 ? 20 : 0));
    expect(out.some((o) => o.value.kind === "left")).toBe(true);
    expect(out.at(-1)!.value.kind).toBe("measuring");
  });

  it("goes back to measuring when the rate collapses", () => {
    const out = run(2000, 20_000, (at) => (at < 8_000 ? 50 : 2));
    const after = out.filter((o) => o.at > 8_000);
    expect(after.some((o) => o.value.kind === "measuring")).toBe(true);
  });

  it("shows no time in the last few seconds", () => {
    const out = run(100, 24_000, () => 4);
    expect(out.at(-1)!.value.kind).toBe("almost");
  });

  it("starts over when the work goes backwards or its whole changes", () => {
    let state = initialTimeLeft();
    for (let at = 0; at <= 5000; at += 250) state = nextTimeLeft(state, at, (at / 1000) * 4, 100).state;
    expect(state.estimate).not.toBeNull();
    expect(nextTimeLeft(state, 5250, 1, 100).value.kind).toBe("measuring");
    expect(nextTimeLeft(state, 5250, 21, 200).value.kind).toBe("measuring");
  });

  it("knows nothing without a total", () => {
    expect(nextTimeLeft(initialTimeLeft(), 0, 5, 0).value.kind).toBe("measuring");
  });
});

describe("friendlySeconds and timeLeftLabel", () => {
  it("rounds the way people say it", () => {
    expect([3, 7, 13, 52, 58, 80, 100, 170, 3000, 5000].map(friendlySeconds)).toEqual([
      0, 5, 15, 50, 60, 60, 120, 180, 3000, 3600,
    ]);
  });

  it("words each unit, and says Loading until it knows", () => {
    expect(timeLeftLabel({ kind: "measuring" }, t)).toBe("Loading…");
    expect(timeLeftLabel({ kind: "measuring" }, t, false)).toBeNull();
    expect(timeLeftLabel({ kind: "almost" }, t)).toBeNull();
    expect(timeLeftLabel({ kind: "left", seconds: 15 }, t)).toBe("About 15 seconds left");
    expect(timeLeftLabel({ kind: "left", seconds: 60 }, t)).toBe("About 1 minute left");
    expect(timeLeftLabel({ kind: "left", seconds: 120 }, t)).toBe("About 2 minutes left");
    expect(timeLeftLabel({ kind: "left", seconds: 7200 }, t)).toBe("About 2 hours left");
  });
});
