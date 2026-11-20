import { describe, expect, it } from "vitest";
import { chooseFiling, filingThreshold } from "./suggestedFiling.js";
import type { SpeciesSuggestion } from "./suggest.js";

const top = (over: Partial<SpeciesSuggestion> = {}): SpeciesSuggestion => ({
  id: "s1",
  common_name: "Heron",
  scientific_name: "Ardea",
  score: 0.9,
  source: "reference_photo",
  confident: true,
  matchPercent: 95,
  ...over,
});
const aves = () => "aves";

describe("chooseFiling", () => {
  it("files a confident match inside the checklist", () => {
    expect(chooseFiling([top()], aves, true)).toEqual({ speciesId: "s1", matchPercent: 95 });
  });
  it("leaves a photo unfiled with no region, no confidence or a weak match", () => {
    expect(chooseFiling([top()], aves, false)).toBeNull();
    expect(chooseFiling([top({ confident: false })], aves, true)).toBeNull();
    expect(chooseFiling([top({ matchPercent: 89 })], aves, true)).toBeNull();
    expect(chooseFiling([], aves, true)).toBeNull();
  });
  it("never files from a keyword tag, and asks more of groups without a threshold", () => {
    expect(chooseFiling([top({ source: "keyword_tag" })], aves, true)).toBeNull();
    expect(filingThreshold("insecta")).toBeGreaterThan(filingThreshold("aves"));
    expect(chooseFiling([top({ matchPercent: 95 })], () => "insecta", true)).toBeNull();
    expect(chooseFiling([top({ matchPercent: 97 })], () => null, true)).not.toBeNull();
  });
});
