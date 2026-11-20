// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ImportSkipped from "./ImportSkipped";
import { skipKind } from "./compareQueue";
import type { ReviewRowBase } from "./useImportReview";

const base = (key: string, extra: Partial<ReviewRowBase>): ReviewRowBase => ({
  key,
  speciesId: null,
  speciesLabel: null,
  suggestions: [],
  ...extra,
});
const dup = base("dup", {
  possibleDuplicate: {
    captureId: "c",
    photoId: null,
    speciesId: "s",
    commonName: "Red-lored Parrot",
    scientificName: "Amazona autumnalis",
    takenAt: "2026-11-09T10:00:00Z",
    exact: true,
  } as never,
});
const landscape = base("land", { notWildlife: { looksLike: "a mountain landscape" } });
const marked = base("mark", { notWildlife: { looksLike: "", marked: true } });
const rows = [dup, landscape, marked];

function setup() {
  const onRemove = vi.fn();
  const onImportAnyway = vi.fn();
  render(
    <ImportSkipped
      rows={rows}
      nameOf={(r) => `${r.key}.CR3`}
      thumb={() => null}
      onRemove={onRemove}
      onImportAnyway={onImportAnyway}
    />,
  );
  return { onRemove, onImportAnyway };
}

describe("skipKind", () => {
  it("tells apart the photos an import leaves out from the ones to review", () => {
    expect(rows.map(skipKind)).toEqual(["duplicate", "notWildlife", "marked"]);
    expect(skipKind(base("ok", {}))).toBeNull();
  });
});

describe("ImportSkipped", () => {
  it("starts folded with the total, and opens into one headed list per reason", () => {
    setup();
    const heading = screen.getByRole("button", { name: /Left out of this import \(3\)/ });
    expect(heading.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("land.CR3")).toBeNull();
    fireEvent.click(heading);
    const kinds = [...document.querySelectorAll("[data-skip-kind] h3")].map((h) => h.textContent);
    expect(kinds).toEqual(["Not wildlife (1)", "Marked not wildlife (1)", "Already in your library (1)"]);
    expect(screen.getByText("Doesn't look like wildlife: it looks like a mountain landscape")).toBeTruthy();
    expect(screen.getByText("You marked it as not wildlife")).toBeTruthy();
    expect(screen.getByText(/Imported as Red-lored Parrot/)).toBeTruthy();
  });

  it("removes or imports one photo, or all of them", () => {
    const { onRemove, onImportAnyway } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Left out of this import/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "Remove from this import" })[0]);
    expect(onRemove).toHaveBeenLastCalledWith(["land"]);
    fireEvent.click(screen.getAllByRole("button", { name: "Import anyway" })[2]);
    expect(onImportAnyway).toHaveBeenLastCalledWith(["dup"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove all" }));
    expect(onRemove).toHaveBeenLastCalledWith(["dup", "land", "mark"]);
    fireEvent.click(screen.getByRole("button", { name: "Import all anyway" }));
    expect(onImportAnyway).toHaveBeenLastCalledWith(["dup", "land", "mark"]);
  });
});
