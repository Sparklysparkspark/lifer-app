import { describe, expect, it } from "vitest";
import { modKey, primaryButtonFirst, revealPlace } from "./platform";

describe("platform conventions", () => {
  it("picks words per OS", () => {
    expect(revealPlace("mac")).toBe("Finder");
    expect(revealPlace("windows")).toBe("Explorer");
    expect(revealPlace("other")).toBe("file manager");
    expect(modKey("mac")).toBe("⌘");
    expect(modKey("windows")).toBe("Ctrl");
  });
  it("puts the primary button first only on Windows", () => {
    expect(primaryButtonFirst("windows")).toBe(true);
    expect(primaryButtonFirst("mac")).toBe(false);
    expect(primaryButtonFirst("other")).toBe(false);
  });
});
