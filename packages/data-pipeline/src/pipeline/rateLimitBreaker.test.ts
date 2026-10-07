import { describe, expect, it } from "vitest";
import { RateLimitBreaker } from "./rateLimitBreaker.js";

describe("RateLimitBreaker", () => {
  it("never trips before a full window, however many refusals", () => {
    const breaker = new RateLimitBreaker(10, 0.5);
    for (let i = 0; i < 9; i++) expect(breaker.record(true)).toBe(false);
  });

  it("trips once half of the last window was refused, even when refusals alternate with successes", () => {
    const breaker = new RateLimitBreaker(10, 0.5);
    const results = Array.from({ length: 10 }, (_, i) => breaker.record(i % 2 === 0));
    expect(results.slice(0, 9).every((r) => r === false)).toBe(true);
    expect(results[9]).toBe(true);
  });

  it("doesn't trip on occasional refusals", () => {
    const breaker = new RateLimitBreaker(10, 0.5);
    for (let i = 0; i < 100; i++) expect(breaker.record(i % 4 === 0)).toBe(false);
  });

  it("only counts the most recent attempts", () => {
    const breaker = new RateLimitBreaker(10, 0.5);
    for (let i = 0; i < 4; i++) breaker.record(true);
    for (let i = 0; i < 10; i++) expect(breaker.record(false)).toBe(false);
  });
});
