import { afterEach, describe, expect, it } from "vitest";
import {
  formatBytes,
  formatDate,
  formatList,
  formatMonthName,
  formatNumber,
  formatPercent,
  toDate,
  setFormatLocale,
} from "./format";

afterEach(() => setFormatLocale(undefined));

describe("the active formatting locale", () => {
  it("drives dates, numbers and percentages once set", () => {
    const d = new Date(2024, 4, 1, 15, 4);
    setFormatLocale("de-DE");
    expect(formatDate(d, "short")).toBe("1.5.2024");
    expect(formatNumber(1234.5)).toBe("1.234,5");
    expect(formatPercent(0.45)).toMatch(/^45\s%$/);
    expect(formatBytes(47_300_000)).toBe("47,3 MB");

    setFormatLocale("en-US");
    expect(formatDate(d, "short")).toBe("5/1/2024");
    expect(formatNumber(1234.5)).toBe("1,234.5");
    expect(formatPercent(0.45)).toBe("45%");
  });

  it("lets a call override the locale", () => {
    setFormatLocale("de-DE");
    expect(formatNumber(1200, undefined, "en-US")).toBe("1,200");
    expect(formatDate(new Date(2024, 0, 2), "short", "en-GB")).toBe("02/01/2024");
  });
});

describe("formatNumber and formatPercent", () => {
  it("passes Intl options through", () => {
    expect(formatNumber(2.345, { maximumFractionDigits: 1 }, "en-US")).toBe("2.3");
    expect(formatPercent(0.123, { maximumFractionDigits: 1 }, "en-US")).toBe("12.3%");
    expect(formatPercent(1, undefined, "fr-FR")).toMatch(/^100\s%$/);
  });
});

describe("formatBytes", () => {
  it("keeps the English output and localises only the number", () => {
    expect(formatBytes(950, "en-US")).toBe("950 B");
    expect(formatBytes(1_100_000_000, "en-US")).toBe("1.1 GB");
    expect(formatBytes(2_000_000, "en-US")).toBe("2 MB");
    expect(formatBytes(1_234_000_000_000_000, "en-US")).toBe("1,234 TB");
    expect(formatBytes(-1, "en-US")).toBe("0 B");
    expect(formatBytes(Number.NaN, "en-US")).toBe("0 B");
  });
});

describe("formatMonthName and formatList", () => {
  it("names months in the locale", () => {
    expect(formatMonthName(0, "long", "en-US")).toBe("January");
    expect(formatMonthName(11, "short", "en-US")).toBe("Dec");
    expect(formatMonthName(2, "long", "fr")).toBe("mars");
  });

  it("joins lists in the locale", () => {
    expect(formatList(["a", "b", "c"], "conjunction", "en-US")).toBe("a, b, and c");
    expect(formatList(["a", "b"], "disjunction", "en-US")).toBe("a or b");
    expect(formatList(["a", "b"], "conjunction", "de")).toBe("a und b");
  });
});

describe("formatDate styles added for i18n", () => {
  it("formats times and month-day dates", () => {
    const d = new Date(2024, 4, 1, 15, 4);
    expect(formatDate(d, "time", "en-US")).toMatch(/^3:04\sPM$/);
    expect(formatDate(d, "monthDay", "en-US")).toBe("May 1");
    expect(formatDate(d, "month", "en-US")).toBe("May");
  });
});

describe("formatDate", () => {
  const d = new Date(2024, 4, 1, 15, 4);

  it("returns an empty string for missing or invalid input", () => {
    expect(formatDate(null)).toBe("");
    expect(formatDate(undefined)).toBe("");
    expect(formatDate("")).toBe("");
    expect(formatDate("not a date")).toBe("");
    expect(formatDate(new Date(NaN))).toBe("");
  });

  it("formats each named style", () => {
    expect(formatDate(d, "short", "en-US")).toBe("5/1/2024");
    expect(formatDate(d, "medium", "en-US")).toBe("May 1, 2024");
    expect(formatDate(d, "long", "en-US")).toBe("May 1, 2024");
    expect(formatDate(d, "monthYear", "en-US")).toBe("May 2024");
    expect(formatDate(d, "dateTime", "en-US")).toMatch(/^May 1, 2024,? 3:04\sPM$/);
  });

  it("uses the runtime's default locale when none is given, every call", () => {
    const expected = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(d);
    expect(formatDate(d)).toBe(expected);
    expect(formatDate(d, "medium")).toBe(expected);
  });

  it("follows the locale", () => {
    expect(formatDate(d, "short", "en-GB")).toBe("01/05/2024");
  });

  it("keeps a date-only string on its own calendar day", () => {
    const parsed = toDate("2024-05-01")!;
    expect([parsed.getFullYear(), parsed.getMonth(), parsed.getDate()]).toEqual([2024, 4, 1]);
    expect(formatDate("2024-05-01", "medium", "en-US")).toBe("May 1, 2024");
  });

  it("accepts ISO strings and epoch ms", () => {
    expect(formatDate(d.toISOString(), "medium", "en-US")).toBe("May 1, 2024");
    expect(formatDate(d.getTime(), "medium", "en-US")).toBe("May 1, 2024");
  });
});

describe("formatBytes across units", () => {
  it("formats across units", () => {
    expect(formatBytes(950)).toBe("950 B");
    expect(formatBytes(47_300_000)).toBe("47.3 MB");
    expect(formatBytes(312_000_000)).toBe("312 MB");
    expect(formatBytes(1_100_000_000)).toBe("1.1 GB");
    expect(formatBytes(2_000_000)).toBe("2 MB");
  });
});
