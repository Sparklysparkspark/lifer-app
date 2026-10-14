import { describe, expect, it, vi } from "vitest";

vi.mock("@lifer/core/db.js", () => ({ pool: {} }));

const { inatPlaceQueryNames } = await import("./inatChecklist.js");

describe("inatPlaceQueryNames", () => {
  it("tries a known alias first, then the name with abbreviations spelled out, then the name as is", () => {
    expect(inatPlaceQueryNames("U.S. Virgin Is.")).toEqual([
      "US Virgin Islands",
      "United States Virgin Islands",
      "U.S. Virgin Is.",
    ]);
  });

  it("spells out U.S. before the single-letter abbreviations", () => {
    expect(inatPlaceQueryNames("Bosnia and Herz.")).toEqual(["Bosnia and Herzegovina", "Bosnia and Herz."]);
    expect(inatPlaceQueryNames("U.S. Pacific")[0]).toBe("United States Pacific");
  });

  it("asks once for a name with nothing to expand", () => {
    expect(inatPlaceQueryNames("Kenya")).toEqual(["Kenya"]);
  });
});
