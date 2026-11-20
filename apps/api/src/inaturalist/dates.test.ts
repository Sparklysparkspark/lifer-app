import { describe, expect, it } from "vitest";
import { dateOnlyToTakenAt } from "@lifer/shared";
import { observedOnString, observedOnToTakenAt } from "./dates.js";

describe("observedOnToTakenAt", () => {
  it("stores the day as noon UTC, the same as a typed missing date", () => {
    expect(observedOnToTakenAt("2026-06-04")).toBe("2026-06-04T12:00:00.000Z");
    expect(observedOnToTakenAt("2026-06-04")).toBe(dateOnlyToTakenAt("2026-06-04"));
  });

  it("reads as the same calendar day anywhere from Honolulu to Sydney", () => {
    const stored = new Date(observedOnToTakenAt("2026-06-04")!);
    for (const timeZone of [
      "Pacific/Honolulu",
      "America/Vancouver",
      "America/Edmonton",
      "UTC",
      "Europe/Paris",
      "Australia/Sydney",
    ]) {
      const day = new Intl.DateTimeFormat("en-CA", { timeZone }).format(stored);
      expect(day, timeZone).toBe("2026-06-04");
    }
  });

  it("takes nothing that isn't a plain, real calendar day", () => {
    for (const value of [null, "", "2026-06", "2026-06-04T10:00:00Z", "June 4", "2026-02-31"])
      expect(observedOnToTakenAt(value)).toBeNull();
  });
});

describe("observedOnString", () => {
  it("sends a file's true instant when it named its zone", () => {
    expect(observedOnString("2026-09-14T12:25:00.000Z", true)).toBe("2026-09-14T12:25:00.000Z");
  });

  it("sends the camera's clock reading with no zone otherwise", () => {
    expect(observedOnString(new Date("2026-09-14T05:25:07.000Z"), false)).toBe("2026-09-14 05:25:07");
    expect(observedOnString("2026-09-14T05:25:07.000Z", null)).toBe("2026-09-14 05:25:07");
  });

  it("sends only the day for a date typed without a time", () => {
    expect(observedOnString(dateOnlyToTakenAt("2026-06-04"), false)).toBe("2026-06-04");
  });

  it("sends nothing without a date", () => {
    expect(observedOnString(null, false)).toBeNull();
    expect(observedOnString("not a date", false)).toBeNull();
  });
});
