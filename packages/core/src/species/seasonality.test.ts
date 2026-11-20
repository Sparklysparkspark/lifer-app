import { describe, expect, it } from "vitest";
import { monthlyFromWeekly } from "./seasonality.js";

const weeks = (fill: (week: number) => number) => Array.from({ length: 52 }, (_, w) => fill(w));

describe("monthlyFromWeekly", () => {
  it("has nothing to say without weekly values", () => {
    expect(monthlyFromWeekly(null)).toBeNull();
    expect(monthlyFromWeekly(undefined)).toBeNull();
    expect(monthlyFromWeekly([])).toBeNull();
  });

  it("gives twelve months, with a northern summer peak in the summer months", () => {
    const months = monthlyFromWeekly(weeks((w) => (w >= 22 && w <= 34 ? 100 : 0)))!;
    expect(months).toHaveLength(12);
    expect(months[6]).toBe(100);
    expect(months[0]).toBe(0);
    expect(months[11]).toBe(0);
  });

  it("puts a southern summer peak in December to February", () => {
    const months = monthlyFromWeekly(weeks((w) => (w <= 7 || w >= 48 ? 40 : 0)))!;
    expect(months[0]).toBe(40);
    expect(months[11]).toBe(40);
    expect(months[6]).toBe(0);
  });

  it("copes with sparse weeks: a single week lifts only its month, and short arrays still fold", () => {
    const one = monthlyFromWeekly(weeks((w) => (w === 10 ? 52 : 0)))!;
    expect(one.filter((m) => m > 0)).toHaveLength(1);
    const short = monthlyFromWeekly([5, 5, 5])!;
    expect(short).toHaveLength(12);
    expect(short[0]).toBe(5);
    expect(short[5]).toBe(0);
  });
});
