import { describe, expect, it } from "vitest";
import { parsePoolMax } from "./config.js";

describe("parsePoolMax", () => {
  it("takes a positive whole number and falls back to 20 for anything else", () => {
    expect(parsePoolMax(undefined)).toBe(20);
    expect(parsePoolMax("")).toBe(20);
    expect(parsePoolMax("8")).toBe(8);
    for (const bad of ["0", "-3", "2.5", "lots"]) expect(parsePoolMax(bad)).toBe(20);
  });
});
