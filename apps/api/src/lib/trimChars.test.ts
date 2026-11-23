import { describe, expect, it } from "vitest";
import { trimChars, trimEndChars } from "./trimChars.js";

describe("trimEndChars", () => {
  it("drops the given characters from the end only", () => {
    expect(trimEndChars("Sp. . ", ". ")).toBe("Sp");
    expect(trimEndChars("https://example.org///", "/")).toBe("https://example.org");
    expect(trimEndChars("a.b", ".")).toBe("a.b");
    expect(trimEndChars("...", ".")).toBe("");
  });
});

describe("trimChars", () => {
  it("drops the given characters from both ends", () => {
    expect(trimChars("'-red-tailed-'", "'-")).toBe("red-tailed");
    expect(trimChars("''", "'-")).toBe("");
  });
});
