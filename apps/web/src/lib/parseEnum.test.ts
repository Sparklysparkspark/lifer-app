import { describe, expect, it } from "vitest";
import { parseEnum } from "./parseEnum";

describe("parseEnum", () => {
  const SIZES = ["s", "m", "l"] as const;
  it("passes allowed values through and falls back otherwise", () => {
    expect(parseEnum("m", SIZES, "s")).toBe("m");
    expect(parseEnum("xl", SIZES, "s")).toBe("s");
    expect(parseEnum(null, SIZES, "l")).toBe("l");
    expect(parseEnum("", SIZES, "l")).toBe("l");
  });
});
