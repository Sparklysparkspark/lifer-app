import { describe, expect, it } from "vitest";
import { trimChars, trimEndChars } from "./trimChars.js";

describe("trimEndChars", () => {
  it("drops the given characters from the end only", () => {
    expect(trimEndChars("Sp. . ", ". ")).toBe("Sp");
    expect(trimEndChars("https://example.org///", "/")).toBe("https://example.org");
    expect(trimEndChars("a.b", ".")).toBe("a.b");
    expect(trimEndChars("...", ".")).toBe("");
  });

  it("stays fast on a long run of those characters that isn't at the end", () => {
    const hostile = `${" ".repeat(200_000)}x`;
    const started = performance.now();
    expect(trimEndChars(hostile, ". ")).toBe(hostile);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("trimChars", () => {
  it("drops the given characters from both ends", () => {
    expect(trimChars("'-red-tailed-'", "'-")).toBe("red-tailed");
    expect(trimChars("''", "'-")).toBe("");
  });
});
