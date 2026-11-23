import { describe, expect, it } from "vitest";
import { trimEndChars } from "./trimChars.js";

describe("trimEndChars", () => {
  it("stays fast on a long run of those characters that isn't at the end", () => {
    const hostile = `${" ".repeat(200_000)}x`;
    const started = performance.now();
    expect(trimEndChars(hostile, ". ")).toBe(hostile);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
