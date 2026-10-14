import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SpeciesNotes } from "./SpeciesNotes";
import type { SpeciesDetail } from "./types";

const base = {
  description: "The emerald-chinned hummingbird is a species of hummingbird.",
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
    expect(html).not.toContain("Summarised from");
  });

  it("shows the notes instead of the text they replace, crediting Wikipedia on the credits page, not here", () => {
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
    expect(html).not.toContain("Summarised from");
  });

  it("replaces each text on its own: habitat notes leave the description in place", () => {
    const html = render({ ...base, habitat_notes: notes("Feeding", ["Hovers at tubular flowers."]) });
    expect(html).toContain("is a species of hummingbird");
    expect(html).toContain("Hovers at tubular flowers.");
    expect(html).not.toContain("Montane forest.");
  });

  it("treats notes with no bullets as missing", () => {
    const html = render({ ...base, identification_notes: notes("Overview", []) });
    expect(html).toContain("is a species of hummingbird");
    expect(html).not.toContain(">Overview<");
  });
});
