// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { KnownFile } from "../../lib/knownFiles";
import KnownFiles from "./KnownFiles";

const known = (n: number): KnownFile[] =>
  Array.from({ length: n }, (_, i) => ({
    name: `IMG_${i}.jpg`,
    fingerprint: String(i).padStart(40, "0"),
    status: i % 2 ? "skipped" : "imported",
    file: null,
    path: null,
  }));

describe("KnownFiles", () => {
  it("is one quiet line until Show them lists the files with Import anyway", () => {
    const onImportAnyway = vi.fn();
    const list = known(100);
    render(<KnownFiles known={list} fresh={200} edited={0} checking={null} onImportAnyway={onImportAnyway} />);
    expect(screen.getByText("100 already imported or skipped before, 200 new")).toBeTruthy();
    expect(screen.queryByText("IMG_0.jpg")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show them" }));
    expect(screen.getByText("IMG_0.jpg")).toBeTruthy();
    expect(screen.getAllByText("Left out of an earlier import")).toHaveLength(50);
    fireEvent.click(screen.getAllByRole("button", { name: "Import anyway" })[0]);
    expect(onImportAnyway).toHaveBeenCalledWith([list[0]]);
    fireEvent.click(screen.getByRole("button", { name: "Import all anyway" }));
    expect(onImportAnyway).toHaveBeenLastCalledWith(list);
  });

  it("says when nothing is new, notes edited copies, and caps a huge list", () => {
    render(<KnownFiles known={known(4800)} fresh={0} edited={2} checking={null} onImportAnyway={() => {}} />);
    expect(screen.getByText("All 4,800 photos were already imported or skipped before")).toBeTruthy();
    expect(screen.getByText("2 look like edited copies of photos you imported")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show them" }));
    expect(screen.getByText("And 4,500 more")).toBeTruthy();
  });

  it("shows nothing when no picked file was known", () => {
    const { container } = render(
      <KnownFiles known={[]} fresh={5} edited={0} checking={null} onImportAnyway={() => {}} />,
    );
    expect(container.textContent).toBe("");
  });
});
