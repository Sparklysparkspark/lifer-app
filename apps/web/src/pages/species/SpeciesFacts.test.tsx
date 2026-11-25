// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EncounterSummary, SpeciesOverview } from "./SpeciesFacts";
import type { EncountersResponse, SpeciesDetail } from "./types";

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
  hotspotRegionName: null,
  hotspotAlternatives: [],
  captures: [],
} as unknown as SpeciesDetail;

describe("SpeciesOverview", () => {
  it("shows the summary as one paragraph, without size facts or a credit line", () => {
    render(<SpeciesOverview detail={detail} encounters={null} />);
    expect(screen.getByText("Tiny, dark brown wren. Hops through coniferous forest.")).toBeTruthy();
    expect(screen.queryByText(/small wren/)).toBeNull();
    expect(screen.queryByText("9 g")).toBeNull();
    expect(screen.queryByText(/Summarised from/)).toBeNull();
  });

  it("names the requested region when it has no hotspots and links to regions that do", () => {
    const d = {
      ...detail,
      hotspotRegionName: "Canada",
      hotspotAlternatives: [{ id: "bz", name: "Belize" }],
      captures: [{ region_id: "ab", region_name: "Alberta" }] as unknown as SpeciesDetail["captures"],
    };
    render(
      <MemoryRouter>
        <SpeciesOverview detail={d} encounters={null} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/No hotspot data for Troglodytes pacificus in Canada/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Alberta" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Belize" }).getAttribute("href")).toBe("/?regionId=bz");
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

describe("EncounterSummary gear lists", () => {
  const long = "Extremely Long Lens Name ".repeat(12).trim();
  const encounters = {
    totalPhotos: 30,
    videoCount: 0,
    encounterCount: 3,
    locationCount: 1,
    cameraCount: 1,
    lensCount: 25,
    locations: [{ name: "Pigeon Lake", count: 30 }],
    cameras: [{ name: "Canon EOS R5", count: 30 }],
    lenses: [{ name: long, count: 9 }, ...Array.from({ length: 19 }, (_, i) => ({ name: `Lens ${i}`, count: 1 }))],
    firstPhotographedAt: null,
    lastPhotographedAt: null,
  } as unknown as EncountersResponse;

  it("opens on click, lists names with counts, and closes on Escape returning focus", () => {
    render(<EncounterSummary encounters={encounters} />);
    expect(screen.queryByText("Canon EOS R5")).toBeNull();
    const trigger = screen.getByRole("button", { name: /1 camera/ });
    fireEvent.click(trigger);
    expect(screen.getByText("Canon EOS R5")).toBeTruthy();
    expect(screen.getByText("30 photos", { selector: "span.tabular-nums" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Canon EOS R5")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("opens from the keyboard (Enter on a button clicks it)", () => {
    render(<EncounterSummary encounters={encounters} />);
    const trigger = screen.getByRole("button", { name: /1 location/ });
    trigger.focus();
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Pigeon Lake")).toBeTruthy();
  });

  it("shows a very long name in full and says how many more there are past the cap", () => {
    render(<EncounterSummary encounters={encounters} />);
    fireEvent.click(screen.getByRole("button", { name: /25 lenses/ }));
    expect(screen.getByText(long).className).toContain("break-words");
    expect(screen.getByText("and 5 more")).toBeTruthy();
  });

  it("closes on an outside click", () => {
    render(<EncounterSummary encounters={encounters} />);
    fireEvent.click(screen.getByRole("button", { name: /1 camera/ }));
    fireEvent.click(document.body);
    expect(screen.queryByText("Canon EOS R5")).toBeNull();
  });

  it("is plain text when the list is empty", () => {
    render(<EncounterSummary encounters={{ ...encounters, cameras: [] }} />);
    expect(screen.queryByRole("button", { name: /camera/ })).toBeNull();
  });
});
