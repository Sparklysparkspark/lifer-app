import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import { dateText, rangeText, timeText } from "./dates";

const t = (key: string) => key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], en) as string;

describe("dates", () => {
  it("writes a date in words", () => {
    expect(dateText(t, "2026-05-12T07:42:00Z")).toBe("12 May 2026");
    expect(dateText(t, "garbage")).toBe("garbage");
  });
  it("writes ranges the short way", () => {
    expect(rangeText(t, "2026-04-14", "2026-04-18")).toBe("14 to 18 April 2026");
    expect(rangeText(t, "2026-04-28", "2026-05-02")).toBe("28 April to 2 May 2026");
    expect(rangeText(t, "2025-12-30", "2026-01-02")).toBe("30 December 2025 to 2 January 2026");
    expect(rangeText(t, "2026-04-14", null)).toBe("14 April 2026");
    expect(rangeText(t, null, null)).toBe("");
  });
  it("writes the time of day", () => {
    expect(timeText("2026-05-12T07:42:00Z")).toBe("7:42 AM");
    expect(timeText("2026-05-12T19:05:00Z")).toBe("7:05 PM");
    expect(timeText("2026-05-12")).toBeNull();
  });
});
