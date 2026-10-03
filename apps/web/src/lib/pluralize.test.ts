import { describe, expect, it } from "vitest";
import { pluralize, pluralWord } from "./pluralize";

describe("pluralize", () => {
  it("uses the singular only for exactly one", () => {
    expect(pluralize(1, "photo")).toBe("1 photo");
    expect(pluralize(0, "photo")).toBe("0 photos");
    expect(pluralize(2, "photo")).toBe("2 photos");
  });

  it("takes an irregular plural", () => {
    expect(pluralize(3, "species", "species")).toBe("3 species");
    expect(pluralize(2, "taxon", "taxa")).toBe("2 taxa");
  });

  it("formats large counts with the locale's grouping", () => {
    expect(pluralize(1200, "photo")).toBe(`${(1200).toLocaleString()} photos`);
  });
});

describe("pluralWord", () => {
  it("returns only the word", () => {
    expect(pluralWord(1, "pack")).toBe("pack");
    expect(pluralWord(5, "pack")).toBe("packs");
    expect(pluralWord(5, "child", "children")).toBe("children");
  });
});
