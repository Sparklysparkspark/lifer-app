import { afterEach, describe, expect, it } from "vitest";
import {
  formatBytes,
  formatDate,
  formatList,
  formatMonthName,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  getFormatLocale,
  setFormatLocale,
} from "./format";

afterEach(() => setFormatLocale(undefined));

describe("the active formatting locale", () => {
  it("drives dates, numbers and percentages once set", () => {
    const d = new Date(2024, 4, 1, 15, 4);
    setFormatLocale("de-DE");
    expect(getFormatLocale()).toBe("de-DE");
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

describe("formatRelativeTime", () => {
  const now = new Date(2024, 4, 10, 12, 0, 0);

  it("picks the largest whole unit", () => {
    expect(formatRelativeTime(new Date(2024, 4, 10, 11, 57), now, "en-US")).toBe("3 minutes ago");
    expect(formatRelativeTime(new Date(2024, 4, 10, 9, 0), now, "en-US")).toBe("3 hours ago");
    expect(formatRelativeTime(new Date(2024, 4, 7, 12, 0), now, "en-US")).toBe("3 days ago");
    expect(formatRelativeTime(new Date(2024, 4, 12, 12, 0), now, "en-US")).toBe("in 2 days");
    expect(formatRelativeTime(new Date(2022, 4, 10), now, "en-US")).toBe("2 years ago");
  });

  it("uses words for adjacent days and the present", () => {
    expect(formatRelativeTime(new Date(2024, 4, 9, 12, 0), now, "en-US")).toBe("yesterday");
    expect(formatRelativeTime(now, now, "en-US")).toBe("now");
  });

  it("follows the locale, and is empty for a bad date", () => {
    expect(formatRelativeTime(new Date(2024, 4, 7, 12, 0), now.getTime(), "de")).toBe("vor 3 Tagen");
    expect(formatRelativeTime("not a date", now, "en-US")).toBe("");
    expect(formatRelativeTime(null, now, "en-US")).toBe("");
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
