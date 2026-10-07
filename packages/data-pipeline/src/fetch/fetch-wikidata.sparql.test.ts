import { describe, expect, it } from "vitest";
import { sparqlString } from "./fetch-wikidata.js";

describe("sparqlString", () => {
  it("escapes backslashes before quotes, so neither can end the string early", () => {
    expect(sparqlString('Genus "sp." \\ x')).toBe('Genus \\"sp.\\" \\\\ x');
    expect(sparqlString('a\\"b')).toBe('a\\\\\\"b');
  });

  it("escapes line breaks", () => {
    expect(sparqlString("a\nb\rc")).toBe("a\\nb\\rc");
  });
});
