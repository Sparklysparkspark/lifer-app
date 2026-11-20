// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SuggestionCard from "./SuggestionCard";
import type { SuggestedSpecies } from "./SpeciesPicker";

const heron = {
  id: "s1",
  common_name: "Great Blue Heron",
  scientific_name: "Ardea herodias",
  score: 0.9,
} as SuggestedSpecies;

function renderCard() {
  const onSelect = vi.fn();
  const onViewPhoto = vi.fn();
  render(<SuggestionCard suggestion={heron} matchPercent={90} onSelect={onSelect} onViewPhoto={onViewPhoto} />);
  return { onSelect, onViewPhoto };
}

describe("SuggestionCard", () => {
  it("assigns the species from its photo, the part people click first", () => {
    const { onSelect, onViewPhoto } = renderCard();
    fireEvent.click(screen.getByRole("img", { name: "Great Blue Heron" }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onViewPhoto).not.toHaveBeenCalled();
  });

  it("wraps both names to two lines instead of cutting them, reserving the room on every card", () => {
    renderCard();
    const sci = screen.getByText("Ardea herodias");
    const common = screen.getByText("Great Blue Heron", { selector: "p" });
    for (const el of [sci, common]) {
      expect(el.className).toContain("line-clamp-2");
      expect(el.className).toContain("min-h-[2lh]");
      expect(el.className).not.toContain("truncate");
    }
  });

  it("opens more photos only from the magnifier", () => {
    const { onSelect, onViewPhoto } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "More photos of Great Blue Heron" }));
    expect(onViewPhoto).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
