// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GallerySummary } from "./GalleryHeader";
import { describeSearchReading, removeSearchPart, searchPartLabel, type SearchPart } from "./galleryHelpers";

const QUERY =
  "Predators stalking at blue hour with a tree in the background, making eye contact with the camera, uses the golden ratio, and is backlit";
const parts: SearchPart[] = [
  { kind: "group", label: "predators", text: "predators", exact: true },
  { kind: "description", label: "stalking", text: "stalking", exact: false },
  { kind: "light", label: "blue hour", text: "blue hour", exact: false },
  { kind: "background", label: "tree", text: "tree in the background", exact: false },
  { kind: "composition", label: "golden ratio", text: "golden ratio", exact: true },
];
const filters = { scopeTrip: null, scopeAlbum: null, clearScope: () => {} };

describe("search parts", () => {
  it("labels best guesses 'probably'", () => {
    expect(searchPartLabel(parts[0])).toBe("predators");
    expect(searchPartLabel(parts[3])).toBe("probably tree in the background");
  });

  it("takes a part's words out of the query, whatever the case or punctuation", () => {
    expect(removeSearchPart(QUERY, parts[0])).toBe(
      "stalking at blue hour with a tree in the background, making eye contact with the camera, uses the golden ratio, and is backlit",
    );
    expect(removeSearchPart(QUERY, parts[3])).toBe(
      "Predators stalking at blue hour with a, making eye contact with the camera, uses the golden ratio, and is backlit",
    );
    expect(removeSearchPart("red-tailed hawk at dusk", { text: "red tailed hawk" })).toBe("at dusk");
    // A word inside another isn't taken.
    expect(removeSearchPart("treehouse", { text: "tree" })).toBe("treehouse");
  });

  it("shows two or more parts as removable tokens", () => {
    const onRemove = vi.fn();
    const { rerender } = render(
      <GallerySummary countText="2 photos" filters={filters} searchParts={parts} onRemoveSearchPart={onRemove} />,
    );
    const group = screen.getByRole("group", { name: "How your search was read" });
    expect(group.textContent).toContain("probably stalking");
    expect(group.textContent).toContain("golden ratio");
    fireEvent.click(screen.getByRole("button", { name: "Remove filter: probably tree in the background" }));
    expect(onRemove).toHaveBeenCalledWith(parts[3]);

    // A one-part search needs no tokens.
    rerender(
      <GallerySummary countText="2 photos" filters={filters} searchParts={[parts[0]]} onRemoveSearchPart={onRemove} />,
    );
    expect(screen.queryByRole("group", { name: "How your search was read" })).toBeNull();
  });

  it("describes the new readings and backgrounds in the count line", () => {
    const reading = describeSearchReading({
      species: [],
      groups: ["predators"],
      scenes: [],
      places: [],
      dates: [],
      order: [],
      description: null,
      readings: ["blueHour", "goldenRatio"],
      backgrounds: ["tree"],
    });
    expect(reading).toBe("predators · tree in the background · blue hour · golden ratio");
  });
});
