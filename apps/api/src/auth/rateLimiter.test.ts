import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAttempts, ipRateLimitKey, isRateLimited, recordAttempt, trackedKeyCount } from "./rateLimiter.js";

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

    // A full sweep runs here and drops them; "an attempt exactly one window old stops counting"
    // below checks the key's own filter at the edge, between sweeps.
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
  // The limiter is module state, so each test starts in a fresh window after a full sweep has
  // dropped everything earlier tests left behind.
  let t0 = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    t0 += 100 * WINDOW_MS;
    vi.setSystemTime(t0);
    isRateLimited("start-fresh");
    expect(trackedKeyCount()).toBe(0);
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

  it("an attempt exactly one window old stops counting, even between full sweeps", () => {
    const key = "edge-between-sweeps";
    for (let i = 0; i < 10; i++) recordAttempt(key);
    // A sweep runs here, so the next check (under a minute later) relies on the key's own filter.
    vi.setSystemTime(t0 + WINDOW_MS - 1);
    expect(isRateLimited(key)).toBe(true);
    vi.setSystemTime(t0 + WINDOW_MS);
    expect(isRateLimited(key)).toBe(false);
  });

  it("forgets a key whose attempts expired when it's checked between sweeps", () => {
    recordAttempt("checked");
    vi.setSystemTime(t0 + WINDOW_MS - 1);
    isRateLimited("sweep-now");
    const tracked = trackedKeyCount();
    vi.setSystemTime(t0 + WINDOW_MS);
    isRateLimited("checked");
    expect(trackedKeyCount()).toBe(tracked - 1);
  });

  it("sweeps other keys at most once a minute", () => {
    recordAttempt("idle");
    vi.setSystemTime(t0 + WINDOW_MS - 1);
    isRateLimited("sweep-now");
    // "idle" has expired now, but the last sweep was under a minute ago.
    vi.setSystemTime(t0 + WINDOW_MS + 30_000);
    isRateLimited("other");
    expect(trackedKeyCount()).toBe(1);
    vi.setSystemTime(t0 + WINDOW_MS - 1 + 60_000); // exactly a minute after the last sweep
    isRateLimited("other");
    expect(trackedKeyCount()).toBe(0);
  });

  it("prunes keys whose attempts have all expired", () => {
    for (let i = 0; i < 20; i++) recordAttempt(`stale-${i}`);
    const before = trackedKeyCount();
    // Exactly one window later: a sweep drops attempts at the edge too.
    vi.setSystemTime(t0 + WINDOW_MS);
    isRateLimited("trigger-sweep");
    expect(trackedKeyCount()).toBeLessThan(before);
    expect(trackedKeyCount()).toBe(0);
  });
});

describe("ipRateLimitKey", () => {
  it("keeps IPv4 addresses as they are", () => {
    expect(ipRateLimitKey("203.0.113.9")).toBe("203.0.113.9");
    expect(ipRateLimitKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
  });

  it("ignores spaces around the address (from a forwarded header list)", () => {
    expect(ipRateLimitKey(" 203.0.113.9 ")).toBe("203.0.113.9");
    expect(ipRateLimitKey(" 2001:DB8:1:2::9 ")).toBe("2001:db8:1:2::/64");
  });

  it("treats an IPv4-mapped address written in hex, or a NAT64 address, as IPv6", () => {
    expect(ipRateLimitKey("::ffff:cb00:7109")).toBe("0:0:0:0::/64");
    expect(ipRateLimitKey("64:ff9b::203.0.113.9")).toBe("64:ff9b:0:0::/64");
  });

  it("drops a zone id", () => {
    expect(ipRateLimitKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it("groups IPv6 addresses by /64", () => {
    const a = ipRateLimitKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    expect(a).toBe("2001:db8:1:2::/64");
    expect(ipRateLimitKey("2001:0db8:0001:0002::1")).toBe(a);
    expect(ipRateLimitKey("2001:db8:1:3::1")).not.toBe(a);
  });

  it("expands a compressed prefix", () => {
    expect(ipRateLimitKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipRateLimitKey("::1")).toBe("0:0:0:0::/64");
  });

  it("expands a gap in the middle when the tail reaches into the first four groups", () => {
    expect(ipRateLimitKey("2001::3:4:5:6:7:8")).toBe("2001:0:3:4::/64");
    expect(ipRateLimitKey("::2:3:4:5:6:7:8")).toBe("0:2:3:4::/64");
  });
});
