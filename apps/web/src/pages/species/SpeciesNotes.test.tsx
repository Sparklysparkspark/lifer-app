// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SpeciesNotes } from "./SpeciesNotes";
import type { SpeciesDetail } from "./types";

afterEach(cleanup);

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

describe("SpeciesNotes", () => {
  it("shows the Wikipedia text when a species has no notes", () => {
    render(<SpeciesNotes species={base} />);
    expect(screen.getByText(/is a species of hummingbird/)).toBeTruthy();
    expect(screen.getByText("Montane forest.")).toBeTruthy();
    expect(screen.queryByText(/Summarised from/)).toBeNull();
  });

  it("shows the notes instead of the text they replace, with one credit", () => {
    render(
      <SpeciesNotes
        species={{
          ...base,
          identification_notes: notes("Identification", ["Small, 7-8.6 cm; short black bill."]),
          habitat_notes: notes("Habitat", ["Humid montane forest edges."]),
        }}
      />,
    );
    expect(screen.getByText("Identification")).toBeTruthy();
    expect(screen.getByText("Small, 7-8.6 cm; short black bill.")).toBeTruthy();
    expect(screen.getByText("Humid montane forest edges.")).toBeTruthy();
    expect(screen.queryByText(/is a species of hummingbird/)).toBeNull();
    expect(screen.queryByText("Montane forest.")).toBeNull();
    const credit = screen.getByRole("link", { name: "Wikipedia" });
    expect(credit.getAttribute("href")).toBe("https://en.wikipedia.org/wiki/Emerald-chinned_hummingbird");
    expect(screen.getAllByText(/Summarised from/)).toHaveLength(1);
  });

  it("replaces each text on its own: habitat notes leave the description in place", () => {
    render(<SpeciesNotes species={{ ...base, habitat_notes: notes("Feeding", ["Hovers at tubular flowers."]) }} />);
    expect(screen.getByText(/is a species of hummingbird/)).toBeTruthy();
    expect(screen.getByText("Hovers at tubular flowers.")).toBeTruthy();
    expect(screen.queryByText("Montane forest.")).toBeNull();
  });

  it("treats notes with no bullets as missing", () => {
    render(<SpeciesNotes species={{ ...base, identification_notes: notes("Overview", []) }} />);
    expect(screen.getByText(/is a species of hummingbird/)).toBeTruthy();
    expect(screen.queryByText("Overview")).toBeNull();
  });
});
