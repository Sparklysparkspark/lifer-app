import { describe, expect, it } from "vitest";
import { articleUrlFromTitle, MAX_BULLETS, toStoredNotes } from "./speciesNotes.js";

describe("toStoredNotes", () => {
  it("keeps headings and bullet text, drops citations, and links the article", () => {
    expect(
      toStoredNotes({
        sections: [
          { heading: "Habitat", bullets: [{ text: "Montane forest edges, 1,000-2,500 m.", sources: [2, 3] }] },
          { heading: "Feeding", bullets: [{ text: "Hovers at tubular flowers.", sources: [7] }] },
        ],
        title: "Emerald-chinned hummingbird",
        revid: 1351091127,
      }),
    ).toEqual({
      sections: [
        { heading: "Habitat", bullets: ["Montane forest edges, 1,000-2,500 m."] },
        { heading: "Feeding", bullets: ["Hovers at tubular flowers."] },
      ],
      source_url: "https://en.wikipedia.org/wiki/Emerald-chinned_hummingbird",
      revision_id: 1351091127,
    });
  });

  it("caps the bullets across all sections", () => {
    const bullets = Array.from({ length: 5 }, (_, i) => ({ text: `Fact ${i}.` }));
    const stored = toStoredNotes({
      sections: [
        { heading: "Habitat", bullets },
        { heading: "Feeding", bullets },
      ],
      title: null,
      revid: null,
    });
    expect(stored?.sections.flatMap((s) => s.bullets)).toHaveLength(MAX_BULLETS);
    expect(stored?.sections[1].bullets).toEqual(["Fact 0."]);
  });

  it("drops blank and over-long bullets and empty sections", () => {
    expect(
      toStoredNotes({
        sections: [
          { heading: "Habitat", bullets: [{ text: "  " }, { text: "x".repeat(301) }] },
          { heading: " ", bullets: [{ text: "Orphan bullet." }] },
          { heading: "Feeding", bullets: [{ text: " Grazes algae. " }] },
        ],
        title: null,
        revid: null,
      }),
    ).toEqual({ sections: [{ heading: "Feeding", bullets: ["Grazes algae."] }], source_url: null, revision_id: null });
  });

  it("returns null when nothing usable is left", () => {
    expect(toStoredNotes({ sections: [], title: "Human", revid: 1 })).toBeNull();
  });
});

describe("articleUrlFromTitle", () => {
  it("encodes the title the way Wikipedia links it", () => {
    expect(articleUrlFromTitle("Grey's mudsnake")).toBe("https://en.wikipedia.org/wiki/Grey's_mudsnake");
    expect(articleUrlFromTitle("Vicuña")).toBe("https://en.wikipedia.org/wiki/Vicu%C3%B1a");
  });
});
