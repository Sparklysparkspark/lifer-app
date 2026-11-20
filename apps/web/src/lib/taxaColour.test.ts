import { describe, expect, it } from "vitest";
import { taxaColour, taxaGroup } from "./taxaColour";

describe("taxa colour", () => {
  it("groups classes and iconic taxa", () => {
    expect(taxaGroup("aves")).toBe("birds");
    expect(taxaGroup("aquatic_mammalia")).toBe("mammals");
    expect(taxaGroup("other", "Insecta")).toBe("insects");
    expect(taxaGroup("corals")).toBe("other");
    expect(taxaGroup(null)).toBe("other");
  });
  it("returns a token", () => {
    expect(taxaColour("fish")).toBe("var(--color-taxa-fish)");
  });
});
