import { describe, expect, it } from "vitest";
import { formatDate, toDate } from "./formatDate";

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
