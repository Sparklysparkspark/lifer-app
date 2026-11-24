import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SpeciesNotes } from "./SpeciesNotes";
import type { SpeciesDetail } from "./types";

const base = {
  description: "The emerald-chinned hummingbird is a species of hummingbird.",
  description_credit: "Wikipedia contributors (CC BY-SA)",
  description_source_url: "https://en.wikipedia.org/wiki/Emerald-chinned_hummingbird",
  habitat_description: "Montane forest.",
  identification_notes: null,
  habitat_notes: null,
} as unknown as SpeciesDetail["species"];

const notes = (heading: string, bullets: string[]) => ({
  sections: [{ heading, bullets }],
  source_url: "https://en.wikipedia.org/wiki/Emerald-chinned_hummingbird",
  revision_id: 1,
});

// No DOM here: the rendered markup is enough to see which text shows and how often the credit does.
const render = (species: SpeciesDetail["species"]) => renderToStaticMarkup(<SpeciesNotes species={species} />);

describe("SpeciesNotes", () => {
  it("shows the Wikipedia text when a species has no notes", () => {
    const html = render(base);
    expect(html).toContain("is a species of hummingbird");
    expect(html).toContain("Montane forest.");
    expect(html.match(/Wikipedia contributors/g)).toHaveLength(1);
  });

  it("shows the notes instead of the text they replace, with one credit line", () => {
    const html = render({
      ...base,
      identification_notes: notes("Identification", ["Small, 7-8.6 cm; short black bill."]),
      habitat_notes: notes("Habitat", ["Humid montane forest edges."]),
    });
    expect(html).toContain(">Identification<");
    expect(html).toContain("Small, 7-8.6 cm; short black bill.");
    expect(html).toContain("Humid montane forest edges.");
    expect(html).not.toContain("is a species of hummingbird");
    expect(html).not.toContain("Montane forest.");
    expect(html.match(/Wikipedia contributors/g)).toHaveLength(1);
  });

  it("replaces each text on its own: habitat notes leave the description in place", () => {
    const html = render({ ...base, habitat_notes: notes("Feeding", ["Hovers at tubular flowers."]) });
    expect(html).toContain("is a species of hummingbird");
    expect(html).toContain("Hovers at tubular flowers.");
    expect(html).not.toContain("Montane forest.");
  });

  it("skips a heading with no bullets under it, and shows a heading both sets share each time", () => {
    const id = {
      ...notes("Size", ["7-8.6 cm."]),
      sections: [
        { heading: "Size", bullets: ["7-8.6 cm."] },
        { heading: "Voice", bullets: [] },
      ],
    };
    const html = render({ ...base, identification_notes: id, habitat_notes: notes("Size", ["Large territories."]) });
    expect(html).not.toContain(">Voice<");
    expect(html.match(/>Size</g)).toHaveLength(2);
  });

  it("treats notes with no bullets as missing", () => {
    const html = render({ ...base, identification_notes: notes("Overview", []) });
    expect(html).toContain("is a species of hummingbird");
    expect(html).not.toContain(">Overview<");
  });

  it("credits every kind of Wikipedia text with the article and licence links", () => {
    const summary = render({ ...base, summary_notes: notes("Summary", ["A long article title."]) });
    for (const html of [summary, render(base), render({ ...base, habitat_notes: notes("Habitat", ["Forest."]) })]) {
      expect(html).toContain('href="https://en.wikipedia.org/wiki/Emerald-chinned_hummingbird"');
      expect(html).toContain('href="https://creativecommons.org/licenses/by-sa/4.0/"');
      expect(html).toContain("Wikipedia contributors");
      expect(html).toContain("CC BY-SA");
    }
  });

  it("links only the licence when the article is unknown, and shows no credit for other sources", () => {
    const html = render({ ...base, description_source_url: null });
    expect(html).toContain("Wikipedia contributors");
    expect(html).not.toContain("wikipedia.org");
    expect(render({ ...base, description_credit: "Someone else (CC BY)" })).not.toContain("Wikipedia contributors");
  });

  it("credits a summary from another source with its own page and licence", () => {
    const html = render({
      ...base,
      summary_notes: {
        sections: [{ heading: "Summary", bullets: ["Large cod of cold shelf waters."] }],
        credit: "FishBase",
        source_url: "https://www.fishbase.se/summary/Gadus-morhua.html",
        revision_id: null,
        licence: "CC BY-NC 4.0",
        licence_url: "https://creativecommons.org/licenses/by-nc/4.0/",
      },
    });
    expect(html).toContain('href="https://www.fishbase.se/summary/Gadus-morhua.html"');
    expect(html).toContain('href="https://creativecommons.org/licenses/by-nc/4.0/"');
    expect(html).toContain("Adapted from");
    expect(html).not.toContain("Wikipedia contributors");
  });
});
