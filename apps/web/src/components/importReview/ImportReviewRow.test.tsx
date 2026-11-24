// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ReviewRowBase } from "./useImportReview";
import type { SpeciesResult } from "../SpeciesPicker";

// The picker's own search is out of scope: Escape on it is its onCancel.
vi.mock("../SpeciesPicker", () => ({
  default: ({ onCancel }: { onCancel?: () => void }) => (
    <input aria-label="Species" autoFocus onKeyDown={(e) => e.key === "Escape" && onCancel?.()} />
  ),
}));
vi.mock("../../lib/speciesName", () => ({
  useSpeciesName: () => (s: { commonName?: string | null; common_name?: string | null }) =>
    s.commonName ?? s.common_name ?? "",
}));

const openViewer = vi.fn();
vi.mock("../Lightbox", () => ({ useLightbox: () => ({ open: openViewer, node: null }) }));

const { default: ImportReviewRow } = await import("./ImportReviewRow");

const base: ReviewRowBase = {
  key: "r1",
  speciesId: "s1",
  speciesLabel: "Osprey",
  suggestions: [{ id: "s1", commonName: "Osprey", scientificName: "Pandion haliaetus", score: 0.6 } as never],
};

function Row({
  row,
  onPick = () => {},
  presetSpecies,
}: {
  row: ReviewRowBase;
  onPick?: (s: SpeciesResult) => void;
  presetSpecies?: SpeciesResult;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <ImportReviewRow
      row={row}
      name="osprey.jpg"
      preview={null}
      removable={false}
      onRemove={() => {}}
      removeLabel="Remove"
      selected
      onToggleSelected={() => {}}
      focused={focused}
      onFocus={() => setFocused(true)}
      onCancelPick={() => setFocused(false)}
      regionId={null}
      onPick={onPick}
      presetSpecies={presetSpecies}
      isActive={false}
      highlightIndex={0}
      onDismissWarning={() => {}}
      onCompare={() => {}}
      onNoAnimal={() => {}}
    />
  );
}

describe("ImportReviewRow", () => {
  it("an imported photo shows its species as text, with no tick, Compare or species change", () => {
    render(<Row row={{ ...base, locked: true }} />);
    expect(screen.getByText("Osprey")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Osprey" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Compare" })).toBeNull();
  });

  it("Escape in the species box puts the link back, with focus on it", () => {
    render(<Row row={base} />);
    fireEvent.click(screen.getByRole("button", { name: "Osprey" }));
    const box = screen.getByRole("textbox", { name: "Species" });
    act(() => {
      fireEvent.keyDown(box, { key: "Escape" });
      box.blur();
    });
    expect(screen.queryByRole("textbox", { name: "Species" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Osprey" }));
  });

  it("the earlier photo of a possible duplicate opens full size", () => {
    render(
      <Row
        row={{
          ...base,
          speciesId: null,
          possibleDuplicate: {
            photoId: "p9",
            speciesId: "s1",
            commonName: "Osprey",
            scientificName: "Pandion haliaetus",
            takenAt: null,
            exact: true,
          } as never,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Your earlier photo of Osprey" }));
    expect(openViewer).toHaveBeenCalledWith([expect.objectContaining({ url: "/api/photos/p9/display" })]);
  });

  describe("started from a species page", () => {
    const kingfisher = { id: "ak", common_name: "Amazon Kingfisher", scientific_name: "Chloroceryle amazona" };
    const hawk = { id: "bch", commonName: "Black-collared Hawk", scientificName: "Busarellus nigricollis" };
    const fromPage = { ...base, speciesId: "ak", speciesLabel: "Amazon Kingfisher" };

    it("keeps the page's species and offers a disagreeing match in one click", () => {
      const onPick = vi.fn();
      render(
        <Row
          row={{ ...fromPage, suggestions: [{ ...hawk, score: 0.9, confident: true } as never] }}
          presetSpecies={kingfisher}
          onPick={onPick}
        />,
      );
      expect(screen.getByRole("button", { name: "Amazon Kingfisher" })).toBeTruthy();
      expect(screen.getByText("Looks like Black-collared Hawk")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Use Black-collared Hawk" }));
      expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "bch" }));
    });

    it("says nothing when the match agrees with the page", () => {
      render(
        <Row
          row={{ ...fromPage, suggestions: [{ id: "ak", commonName: "Amazon Kingfisher", score: 0.9 } as never] }}
          presetSpecies={kingfisher}
        />,
      );
      expect(screen.queryByText(/Looks like/)).toBeNull();
      expect(screen.queryByRole("button", { name: /^Use / })).toBeNull();
    });

    it("offers the page's species for a RAW that joined a photo filed as another", () => {
      const onPick = vi.fn();
      render(
        <Row
          row={{
            ...base,
            speciesId: "bch",
            speciesLabel: "Black-collared Hawk",
            suggestions: [],
            rawMatch: { captureId: "c1", speciesId: "bch", speciesName: "Black-collared Hawk" },
          }}
          presetSpecies={kingfisher}
          onPick={onPick}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Use Amazon Kingfisher" }));
      expect(onPick).toHaveBeenCalledWith(kingfisher);
    });
  });
});
