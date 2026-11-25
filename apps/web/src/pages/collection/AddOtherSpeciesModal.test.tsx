// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let anyTaxa = true;
vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => ({ settings: { anyTaxaSearchEnabled: anyTaxa }, error: null }),
}));
vi.mock("../../components/AddSpeciesListModal", () => ({ AddSpeciesListBody: () => <p>group body</p> }));
vi.mock("../../components/AddOtherTaxaModal", () => ({ BulkNamesBody: () => <p>paste body</p> }));
vi.mock("./AddSpeciesToChecklistBody", () => ({ default: () => <p>search body</p> }));

const { default: AddOtherSpeciesModal } = await import("./AddOtherSpeciesModal");
const targets = [{ kind: "region" as const, id: "ca", name: "Canada" }];

function open(props: Partial<Parameters<typeof AddOtherSpeciesModal>[0]> = {}) {
  render(
    <AddOtherSpeciesModal
      targets={targets}
      region={{ id: "ca", name: "Canada" }}
      onClose={vi.fn()}
      onAdded={vi.fn()}
      {...props}
    />,
  );
}

beforeEach(() => {
  anyTaxa = true;
  localStorage.clear();
});
afterEach(cleanup);

describe("AddOtherSpeciesModal", () => {
  it("has the title and three tabs, starting on the search", () => {
    open();
    expect(screen.getByRole("dialog", { name: "Add other species" })).toBeTruthy();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(
      expect.arrayContaining(["Search for a species", "A group from iNaturalist", "Paste a list of names"]),
    );
    expect(screen.getByText("search body")).toBeTruthy();
  });

  it("switches tabs and remembers the last one for next time", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "A group from iNaturalist" }));
    expect(screen.getByText("group body")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Paste a list of names" }));
    expect(screen.getByText("paste body")).toBeTruthy();
    expect(screen.queryByText("group body")).toBeNull();
    cleanup();
    open();
    expect(screen.getByText("paste body")).toBeTruthy();
  });

  it("opens on the tab an empty state asks for, without overwriting the remembered one", () => {
    open({ initialTab: "group" });
    expect(screen.getByText("group body")).toBeTruthy();
    cleanup();
    open();
    expect(screen.getByText("search body")).toBeTruthy();
  });

  it("hides the iNaturalist tabs when the setting is off, and the tab bar with one tab left", () => {
    anyTaxa = false;
    open();
    expect(screen.queryByRole("button", { name: "A group from iNaturalist" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Paste a list of names" })).toBeNull();
    expect(screen.getByText("search body")).toBeTruthy();
  });

  it("without a region checklist, drops the search tab and falls back from a remembered one", () => {
    localStorage.setItem("lifer:addOtherSpeciesTab", JSON.stringify("search"));
    open({ targets: null });
    expect(screen.queryByRole("button", { name: "Search for a species" })).toBeNull();
    expect(screen.getByText("group body")).toBeTruthy();
  });
});
