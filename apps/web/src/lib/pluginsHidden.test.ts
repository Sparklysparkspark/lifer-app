import { describe, expect, it } from "vitest";
import { parseHidden } from "./plugins";

describe("parseHidden", () => {
  it("reads a stored list of app ids", () => {
    expect([...parseHidden('["a","b"]')]).toEqual(["a", "b"]);
  });

  it("treats nothing, damage and the wrong shape as an empty list, and drops non-text entries", () => {
    expect(parseHidden(null).size).toBe(0);
    expect(parseHidden("{oops").size).toBe(0);
    expect(parseHidden('{"a":1}').size).toBe(0);
    expect([...parseHidden('["a",3,null]')]).toEqual(["a"]);
  });
});
