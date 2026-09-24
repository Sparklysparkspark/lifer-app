import { describe, expect, it } from "vitest";
import { contentDisposition, parseRange } from "./httpFile.js";

describe("parseRange", () => {
  const size = 1000;
  it("no header means the full file", () => {
    expect(parseRange(undefined, size)).toEqual({ kind: "full" });
  });
  it("a normal range", () => {
    expect(parseRange("bytes=0-99", size)).toEqual({ kind: "partial", start: 0, end: 99 });
  });
  it("an open-ended range", () => {
    expect(parseRange("bytes=900-", size)).toEqual({ kind: "partial", start: 900, end: 999 });
  });
  it("a suffix range means the last N bytes", () => {
    expect(parseRange("bytes=-100", size)).toEqual({ kind: "partial", start: 900, end: 999 });
    expect(parseRange("bytes=-5000", size)).toEqual({ kind: "partial", start: 0, end: 999 });
  });
  it("clamps an end past EOF instead of 416", () => {
    expect(parseRange("bytes=500-5000", size)).toEqual({ kind: "partial", start: 500, end: 999 });
  });
  it("a start past EOF is unsatisfiable", () => {
    expect(parseRange("bytes=1000-", size)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=-0", size)).toEqual({ kind: "unsatisfiable" });
  });
  it("multi-range, malformed and inverted ranges fall back to the full file", () => {
    expect(parseRange("bytes=0-1,5-9", size)).toEqual({ kind: "full" });
    expect(parseRange("items=0-1", size)).toEqual({ kind: "full" });
    expect(parseRange("bytes=-", size)).toEqual({ kind: "full" });
    expect(parseRange("bytes=50-10", size)).toEqual({ kind: "full" });
  });
});

describe("contentDisposition", () => {
  it("keeps a plain ASCII name", () => {
    expect(contentDisposition("IMG_0001.jpg")).toBe(`attachment; filename="IMG_0001.jpg"; filename*=UTF-8''IMG_0001.jpg`);
  });
  it("encodes non-Latin names and gives an ASCII-only fallback", () => {
    const header = contentDisposition("Ästhetik 鳥.jpg");
    expect(header).toContain(`filename="_sthetik _.jpg"`);
    expect(header).toContain(`filename*=UTF-8''%C3%84sthetik%20%E9%B3%A5.jpg`);
    expect(/^[\x20-\x7e]*$/.test(header)).toBe(true);
  });
  it("neutralises quotes in the fallback", () => {
    expect(contentDisposition(`a"b.jpg`)).toContain(`filename="a_b.jpg"`);
  });
});
