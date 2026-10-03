import { describe, expect, it } from "vitest";
import { visibleSuggestions } from "./useImportReview";

const s = (score: number, confident?: boolean) => ({ score, confident });

describe("visibleSuggestions", () => {
  it("shows only a certain or confident top match", () => {
    expect(visibleSuggestions([s(1), s(0.7)])).toHaveLength(1);
    expect(visibleSuggestions([s(0.8, true), s(0.7)])).toHaveLength(1);
  });

  it("shows them all otherwise", () => {
    expect(visibleSuggestions([s(0.8), s(0.75), s(0.7)])).toHaveLength(3);
    expect(visibleSuggestions([])).toHaveLength(0);
  });
});
