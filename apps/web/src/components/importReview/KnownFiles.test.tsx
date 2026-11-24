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
    expect(screen.getByText("50 of 300 files are already in Lifer, 50 skipped before, 200 are new")).toBeTruthy();
    expect(screen.queryByText("IMG_0.jpg")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show them" }));
    expect(screen.getByText("IMG_0.jpg")).toBeTruthy();
    expect(screen.getAllByText("Skipped before, not in your library")).toHaveLength(50);
    fireEvent.click(screen.getAllByRole("button", { name: "Import anyway" })[0]);
    expect(onImportAnyway).toHaveBeenCalledWith([list[0]]);
    fireEvent.click(screen.getByRole("button", { name: "Import all anyway" }));
    expect(onImportAnyway).toHaveBeenLastCalledWith(list);
  });

  it("says when nothing is new, notes edited copies, and caps a huge list", () => {
    render(<KnownFiles known={known(4800)} fresh={0} edited={2} checking={null} onImportAnyway={() => {}} />);
    expect(
      screen.getByText("2,400 of 4,800 files are already in Lifer, 2,400 skipped before, none are new"),
    ).toBeTruthy();
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

  it("lists files already in Lifer with the photo each became, apart from the ones skipped before", () => {
    const list: KnownFile[] = [
      {
        name: "IMG_1.jpg",
        fingerprint: "1".repeat(40),
        status: "imported",
        file: null,
        path: "/a/IMG_1.jpg",
        match: { photoId: "ph-1", speciesId: "sp-1", commonName: "Great Blue Heron", scientificName: "Ardea herodias" },
      },
      { name: "IMG_2.jpg", fingerprint: "2".repeat(40), status: "skipped", file: null, path: null },
    ];
    const { container } = render(
      <KnownFiles
        known={list}
        fresh={8}
        edited={0}
        checking={null}
        onImportAnyway={() => {}}
        clear={<button type="button">Clear out the ones already in Lifer</button>}
      />,
    );
    expect(screen.getByText("1 of 10 files is already in Lifer, 1 skipped before, 8 are new")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear out the ones already in Lifer" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show them" }));
    expect(screen.getByRole("heading", { name: "Already in Lifer (1)" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Skipped before (1)" })).toBeTruthy();
    expect(screen.getByText("Already in Lifer as Great Blue Heron")).toBeTruthy();
    expect(container.querySelector('img[src="/api/photos/ph-1/thumb"]')).toBeTruthy();
  });
});
