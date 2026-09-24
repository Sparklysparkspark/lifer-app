import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAttempts, isRateLimited, recordAttempt, trackedKeyCount } from "./rateLimiter.js";

const WINDOW_MS = 15 * 60 * 1000;

describe("rate limiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is not rate limited before any attempts are recorded", () => {
    expect(isRateLimited("fresh-key")).toBe(false);
  });

  // Boundary: exactly 9 recorded attempts must not be limited (MAX_ATTEMPTS is 10).
  it("is not limited at 9 attempts, but is at exactly 10 (the MAX_ATTEMPTS boundary)", () => {
    const key = "boundary-key";
    for (let i = 0; i < 9; i++) recordAttempt(key);
    expect(isRateLimited(key)).toBe(false);
    recordAttempt(key);
    expect(isRateLimited(key)).toBe(true);
  });

  it("tracks separate keys independently", () => {
    const a = "user-a";
    const b = "user-b";
    for (let i = 0; i < 10; i++) recordAttempt(a);
    expect(isRateLimited(a)).toBe(true);
    expect(isRateLimited(b)).toBe(false);
  });

  it("drops attempts once they age out of the sliding window", () => {
    const key = "aging-key";
    for (let i = 0; i < 10; i++) recordAttempt(key);
    expect(isRateLimited(key)).toBe(true);

    // Boundary: exactly at the window edge, the old attempts should no longer count (the
    // filter is `now - t < WINDOW_MS`, a strict less-than).
    vi.setSystemTime(WINDOW_MS);
    expect(isRateLimited(key)).toBe(false);
  });

  it("keeps an attempt recorded 1ms inside the window, drops one 1ms past it", () => {
    const key = "precise-key";
    recordAttempt(key); // t=0
    for (let i = 0; i < 9; i++) recordAttempt(key); // fill to 10 total at t=0

    vi.setSystemTime(WINDOW_MS - 1);
    expect(isRateLimited(key)).toBe(true); // all 10 still within window

    vi.setSystemTime(WINDOW_MS + 1);
    expect(isRateLimited(key)).toBe(false); // all 10 have now aged out
  });
});

describe("rate limiter options and cleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10 * WINDOW_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("honors a per-call max", () => {
    const key = "custom-max";
    for (let i = 0; i < 3; i++) recordAttempt(key);
    expect(isRateLimited(key, 3)).toBe(true);
    expect(isRateLimited(key, 4)).toBe(false);
  });

  it("clearAttempts resets a key", () => {
    const key = "cleared";
    for (let i = 0; i < 10; i++) recordAttempt(key);
    clearAttempts(key);
    expect(isRateLimited(key)).toBe(false);
  });

  it("prunes keys whose attempts have all expired", () => {
    for (let i = 0; i < 20; i++) recordAttempt(`stale-${i}`);
    const before = trackedKeyCount();
    vi.setSystemTime(12 * WINDOW_MS);
    isRateLimited("trigger-sweep");
    expect(trackedKeyCount()).toBeLessThan(before);
    expect(trackedKeyCount()).toBe(0);
  });
});
