// Regression coverage for real Catalogue of Life data: Corydoras panda's English vernacular
// name is literally "panda", all lowercase.
import { describe, expect, it } from "vitest";
import { toTitleCase } from "./fetch-gbif-vernacular.js";

describe("toTitleCase", () => {
  it("capitalizes each word", () => {
    expect(toTitleCase("panda")).toBe("Panda");
    expect(toTitleCase("dwarf corydoras")).toBe("Dwarf Corydoras");
    expect(toTitleCase("two spot synodontis")).toBe("Two Spot Synodontis");
  });

  it("capitalizes after a hyphen too", () => {
    expect(toTitleCase("white-edged moray")).toBe("White-Edged Moray");
  });

  it("does not capitalize after an apostrophe", () => {
    expect(toTitleCase("kirtland's warbler")).toBe("Kirtland's Warbler");
  });

  it("is a no-op on already-correct title case (the common bird-name path)", () => {
    expect(toTitleCase("Northern Goshawk")).toBe("Northern Goshawk");
  });
});
