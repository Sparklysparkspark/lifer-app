import { describe, expect, it } from "vitest";
import { parseInline, parseReleaseNotes } from "./releaseNotes";

describe("parseReleaseNotes", () => {
  it("reads a changelog section: headings, wrapped bullets and paragraphs", () => {
    const notes = [
      "### Fixed",
      "",
      "- Windows: the desktop app is available again. 0.10.0 shipped without a Windows installer",
      "  because its build failed; this release includes it.",
      "- Another fix.",
      "",
      "A closing paragraph",
      "over two lines.",
    ].join("\n");
    expect(parseReleaseNotes(notes)).toEqual([
      { type: "heading", level: 3, content: [{ type: "text", text: "Fixed" }] },
      {
        type: "list",
        items: [
          [
            {
              type: "text",
              text: "Windows: the desktop app is available again. 0.10.0 shipped without a Windows installer because its build failed; this release includes it.",
            },
          ],
          [{ type: "text", text: "Another fix." }],
        ],
      },
      { type: "paragraph", content: [{ type: "text", text: "A closing paragraph over two lines." }] },
    ]);
  });
});

describe("parseInline", () => {
  it("finds bold, code and https links, and leaves anything else as text", () => {
    expect(
      parseInline(
        "**Breaking:** set `TRUST_PROXY` ([guide](https://example.org/x)) <b>no</b> [bad](javascript:alert(1))",
      ),
    ).toEqual([
      { type: "bold", text: "Breaking:" },
      { type: "text", text: " set " },
      { type: "code", text: "TRUST_PROXY" },
      { type: "text", text: " (" },
      { type: "link", text: "guide", href: "https://example.org/x" },
      { type: "text", text: ") <b>no</b> [bad](javascript:alert(1))" },
    ]);
  });
});
