// Text sizes come from the named styles in theme.css (text-body, text-caption...), so a screen's
// hierarchy reads the same everywhere. A raw pixel size bypasses them.
import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>(["../**/*.tsx", "../**/*.ts", "!../**/*.test.*"], {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("text sizes", () => {
  it("uses the named styles, never a raw pixel size", () => {
    const offenders = Object.entries(sources)
      .filter(([, text]) => /\btext-\[\d+(\.\d+)?px\]/.test(text))
      .map(([file]) => file);
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });
});
