// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ReviewRowBase } from "./useImportReview";

// The picker's own search is out of scope: Escape on it is its onCancel.
vi.mock("../SpeciesPicker", () => ({
  default: ({ onCancel }: { onCancel?: () => void }) => (
    <input aria-label="Species" autoFocus onKeyDown={(e) => e.key === "Escape" && onCancel?.()} />
  ),
}));
vi.mock("../../lib/speciesName", () => ({
  useSpeciesName: () => (s: { commonName?: string | null }) => s.commonName ?? "",
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

function Row({ row }: { row: ReviewRowBase }) {
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
      onPick={() => {}}
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
});
