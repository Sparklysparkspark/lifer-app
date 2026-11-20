import { describe, expect, it } from "vitest";
import { mediaNoun } from "./mediaNoun";

describe("mediaNoun", () => {
  it("says photo for photos, and for nothing at all", () => {
    expect(mediaNoun(false, true)).toBe("photo");
    expect(mediaNoun(false, false)).toBe("photo");
  });

  it("says video for videos only", () => {
    expect(mediaNoun(true, false)).toBe("video");
  });

  it("says file for a mix", () => {
    expect(mediaNoun(true, true)).toBe("file");
  });

  it("says recording for recordings alone, and file when they sit with anything else", () => {
    expect(mediaNoun(false, false, false, true)).toBe("recording");
    expect(mediaNoun(false, true, false, true)).toBe("file");
    expect(mediaNoun(true, false, false, true)).toBe("file");
  });
});
