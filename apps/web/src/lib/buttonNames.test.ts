// Every button a screen reader can reach has a name: visible text, an aria-label, or an image
// with alt text. An icon-only button without one is announced as just "button".
import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>(["../**/*.tsx", "!../**/*.test.*"], {
  query: "?raw",
  import: "default",
  eager: true,
});

function unnamedButtons(file: string, text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/<button\b((?:[^>{]|\{[^}]*\})*)>([\s\S]*?)<\/button>/g)) {
    const [, attrs, inner] = m;
    if (/aria-label|aria-labelledby|\{\.\.\./.test(attrs)) continue;
    // An image with real alt text names the button.
    if (/<img\b[^>]*\balt=(?:"[^"]+"|\{)/.test(inner)) continue;
    const textOnly = inner.replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/<[^>]*>/g, " ");
    if (textOnly.includes("{") || /[A-Za-z]/.test(textOnly)) continue;
    found.push(`${file}:${text.slice(0, m.index).split("\n").length}`);
  }
  return found;
}

describe("buttons", () => {
  it("all have an accessible name", () => {
    const offenders = Object.entries(sources).flatMap(([file, text]) => unnamedButtons(file, text));
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });
});
