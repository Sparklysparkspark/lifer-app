import { describe, expect, it } from "vitest";
import { NO_TRIP, defaultTripChoice } from "./tripChoice";

const trip = (
  id: string,
  startDate: string | null,
  endDate: string | null = null,
  activeOverride: boolean | null = null,
) => ({
  id,
  startDate,
  endDate,
  activeOverride,
});
const today = "2026-05-05";

describe("defaultTripChoice", () => {
  it("picks the one active trip, open-ended or within its dates", () => {
    expect(defaultTripChoice([trip("a", "2026-05-01"), trip("b", "2026-04-01", "2026-04-10")], today, "b")).toBe("a");
    expect(defaultTripChoice([trip("a", "2026-05-01", "2026-05-05")], today, null)).toBe("a");
  });

  it("goes by the user's own choice over the dates", () => {
    expect(
      defaultTripChoice(
        [trip("a", "2026-05-01", null, false), trip("b", "2020-01-01", "2020-01-02", true)],
        today,
        null,
      ),
    ).toBe("b");
  });

  it("with several active, offers the last pick and otherwise asks", () => {
    const both = [trip("a", "2026-05-01"), trip("b", "2026-05-04")];
    expect(defaultTripChoice(both, today, "b")).toBe("b");
    expect(defaultTripChoice(both, today, NO_TRIP)).toBe(NO_TRIP);
    expect(defaultTripChoice(both, today, "gone")).toBeNull();
    expect(defaultTripChoice(both, today, null)).toBeNull();
  });

  it("is no trip when none is active", () => {
    expect(defaultTripChoice([trip("a", "2026-06-01"), trip("b", null)], today, "a")).toBe(NO_TRIP);
  });
});
