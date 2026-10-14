// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpeciesOverview } from "./SpeciesFacts";
import type { SpeciesDetail } from "./types";

vi.mock("../../components/SpeciesHotspotMap", () => ({ default: () => null }));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const detail = {
  species: {
    scientific_name: "Troglodytes pacificus",
    taxon_class: "aves",
    is_other_taxa: false,
    mass_g: "9",
    trophic_niche: "Invertivore",
    iucn_status: "LC",
    inat_taxon_id: 145212,
    ebird_code: "pacwre1",
    description: "A small wren of the Pacific Northwest.",
    identification_notes: null,
    habitat_notes: null,
    summary_notes: {
      sections: [{ heading: "Summary", bullets: ["Tiny, dark brown wren", "Hops through coniferous forest."] }],
      source_url: null,
      revision_id: null,
    },
  },
  seasonality: null,
  weeklyFrequency: null,
  hotspots: [],
} as unknown as SpeciesDetail;

describe("SpeciesOverview", () => {
  it("shows the summary as one paragraph, without size facts or a credit line", () => {
    render(<SpeciesOverview detail={detail} encounters={null} />);
    expect(screen.getByText("Tiny, dark brown wren. Hops through coniferous forest.")).toBeTruthy();
    expect(screen.queryByText(/small wren/)).toBeNull();
    expect(screen.queryByText("9 g")).toBeNull();
    expect(screen.queryByText(/Summarised from/)).toBeNull();
  });

  it("links to iNaturalist once, beside eBird", () => {
    render(<SpeciesOverview detail={detail} encounters={null} />);
    expect(screen.getAllByRole("link", { name: /iNaturalist/ })).toHaveLength(1);
    expect(screen.getByRole("link", { name: /eBird/ })).toBeTruthy();
  });

  it("shows the status as short tags", () => {
    render(<SpeciesOverview detail={detail} encounters={null} />);
    expect(screen.getByText("Status")).toBeTruthy();
    expect(screen.getByText("IUCN Least Concern")).toBeTruthy();
  });

  it("collapses the whole section, sightings included", () => {
    render(<SpeciesOverview detail={detail} encounters={null} />);
    fireEvent.click(screen.getByRole("button", { name: /About/ }));
    expect(screen.queryByText(/coniferous forest/)).toBeNull();
    expect(screen.queryByRole("link", { name: /eBird/ })).toBeNull();
    expect(screen.getByRole("button", { name: /About/ }).getAttribute("aria-expanded")).toBe("false");
  });
});
