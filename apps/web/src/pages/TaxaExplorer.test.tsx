// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LightboxSlide } from "../components/Lightbox";

let treeData: unknown;
vi.mock("../lib/resource", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/resource")>()),
  useApiResource: () => ({ data: treeData, error: null, reload: async () => {} }),
}));
// The real viewer's own behaviour is Lightbox.test.tsx's; here only what the tree hands it matters.
vi.mock("../components/Lightbox", () => ({
  default: (p: { slides: LightboxSlide[]; index: number; onClose: () => void }) => (
    <div data-testid="viewer" data-count={p.slides.length}>
      {p.slides[p.index].caption}
      <button onClick={p.onClose}>close viewer</button>
    </div>
  ),
}));
vi.mock("../hooks/useToast", () => ({ useToast: () => ({}) }));
vi.mock("../hooks/useScrollMemory", () => ({ useScrollMemory: () => {} }));

const { default: TaxaExplorer } = await import("./TaxaExplorer");
const { explorerMemory } = await import("./explorer/treeModel");

const species = (name: string, photoId: string | null, collected = 1) => ({
  rank: "species",
  name,
  commonName: `${name} common`,
  speciesId: `sp-${name}`,
  collected,
  total: 1,
  photos: collected,
  photoId,
  tier: name === "Gamma" ? "rare" : "common",
  referenceUrl: collected ? null : `/ref/${name}.jpg`,
  children: [],
});
const genus = {
  rank: "genus",
  name: "Genus",
  collected: 3,
  total: 4,
  photos: 3,
  photoId: "p-a",
  children: [species("Alpha", "p-a"), species("Beta", null), species("Gamma", "p-g"), species("Delta", null, 0)],
};
const tree = {
  collected: 3,
  tree: [{ rank: "class", name: "Testia", collected: 3, total: 4, photos: 3, photoId: "p-a", children: [genus] }],
};

const item = (name: RegExp | string) => screen.getByRole("treeitem", { name });
function renderPage() {
  return render(
    <MemoryRouter>
      <TaxaExplorer />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  treeData = tree;
  explorerMemory.expanded = new Set();
  explorerMemory.selected = null;
  explorerMemory.focus = null;
  localStorage.setItem("lifer:explorer.genus", "true");
  localStorage.removeItem("lifer:explorer.view");
});
afterEach(cleanup);

describe("TaxaExplorer", () => {
  it("opens a photo without selecting, expanding or collapsing anything", () => {
    renderPage();
    const testia = item(/Testia/);
    expect(testia.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Open photo of Testia" }));
    expect(screen.getByTestId("viewer").textContent).toContain("Testia");
    expect(testia.getAttribute("aria-expanded")).toBe("false");
    expect(testia.getAttribute("aria-selected")).toBe("false");

    fireEvent.click(screen.getByText("close viewer"));
    expect(screen.queryByTestId("viewer")).toBeNull();
  });

  it("selects a species into the detail pane without leaving the page or changing the tree", () => {
    renderPage();
    fireEvent.click(item(/Testia/));
    fireEvent.click(item(/^Genus/));
    const rowsBefore = screen.getAllByRole("treeitem").length;

    fireEvent.click(item(/^Alpha common/));
    expect(item(/^Alpha common/).getAttribute("aria-selected")).toBe("true");
    expect(screen.getAllByRole("treeitem")).toHaveLength(rowsBefore);
    expect(item(/^Genus/).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("link", { name: "Open species page" }).getAttribute("href")).toBe("/species/sp-Alpha");

    // Arrows through the photos of the rows on show, in tree order.
    fireEvent.click(screen.getByRole("button", { name: "Open photo of Gamma common" }));
    expect(screen.getByTestId("viewer").dataset.count).toBe("4");
  });

  it("keeps expansion and selection after leaving and coming back", () => {
    renderPage();
    fireEvent.click(item(/Testia/));
    fireEvent.click(item(/^Genus/));
    fireEvent.click(item(/^Beta common/));
    cleanup();

    renderPage();
    expect(item(/^Genus/).getAttribute("aria-expanded")).toBe("true");
    expect(item(/^Beta common/).getAttribute("aria-selected")).toBe("true");
  });

  it("shows what is left to find, and each group's progress", () => {
    renderPage();
    expect(item(/Testia/).textContent).toContain("3 of 4");
    fireEvent.click(item(/Testia/));
    fireEvent.click(item(/^Genus/));
    // Photographed first, the rest after.
    expect(
      screen
        .getAllByRole("treeitem")
        .map((r) => r.dataset.id?.split("species:")[1])
        .filter(Boolean),
    ).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
    expect(item(/^Delta common/).textContent).toContain("Not photographed yet");
  });

  it("lists search matches with their rank and path, and Enter jumps to one", () => {
    renderPage();
    const field = screen.getByRole("combobox", { name: "Jump to a group or species" });
    fireEvent.change(field, { target: { value: "gamm" } });
    const option = screen.getByRole("option", { name: /Gamma common/ });
    expect(option.textContent).toContain("Species in Testia / Genus");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(item(/^Genus/).getAttribute("aria-expanded")).toBe("true");
    expect(item(/^Gamma common/).getAttribute("aria-selected")).toBe("true");
  });

  it("opens on your photographed branches on a first visit", () => {
    explorerMemory.expanded = null;
    renderPage();
    expect(item(/Testia/).getAttribute("aria-expanded")).toBe("true");
  });

  it("hides genera unless the View option shows them", () => {
    localStorage.setItem("lifer:explorer.genus", "false");
    renderPage();
    fireEvent.click(item(/Testia/));
    expect(screen.queryByRole("treeitem", { name: /^Genus/ })).toBeNull();
    expect(item(/^Alpha common/).getAttribute("aria-level")).toBe("2");
  });

  it("focuses on a group with a breadcrumb back out, and remembers it", () => {
    renderPage();
    fireEvent.click(item(/Testia/));
    fireEvent.click(item(/^Genus/));
    fireEvent.click(screen.getByRole("button", { name: "Focus on this group" }));
    const crumbs = screen.getByRole("navigation", { name: "Focused group" });
    expect(crumbs.textContent).toContain("Testia");
    expect(screen.queryByRole("treeitem", { name: /Testia/ })).toBeNull();
    expect(item(/^Alpha common/).getAttribute("aria-level")).toBe("1");
    cleanup();

    renderPage();
    expect(screen.getByRole("navigation", { name: "Focused group" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "All groups" }));
    expect(item(/Testia/)).toBeTruthy();
  });

  it("draws a circle whose groups zoom in on click and move with the arrow keys", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Circle" }));
    const testia = screen.getByRole("button", { name: "Testia, 3 of 4 species" });
    testia.focus();
    fireEvent.keyDown(testia, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Genus, 3 of 4 species" }));
    fireEvent.click(testia);
    expect(screen.getByRole("navigation", { name: "Focused group" }).textContent).toContain("Testia");
    fireEvent.click(screen.getByRole("button", { name: "Step back out" }));
    expect(screen.queryByRole("navigation", { name: "Focused group" })).toBeNull();
  });

  it("moves with the arrow keys, opens with Right, closes with Left and selects with Enter", () => {
    renderPage();
    const tree = screen.getByRole("tree");
    const key = (k: string) => fireEvent.keyDown(document.activeElement ?? tree, { key: k });
    item(/Testia/).focus();
    key("ArrowRight");
    expect(item(/Testia/).getAttribute("aria-expanded")).toBe("true");
    key("ArrowDown");
    expect(document.activeElement).toBe(item(/^Genus/));
    key("Enter");
    expect(item(/^Genus/).getAttribute("aria-selected")).toBe("true");
    key("ArrowLeft");
    expect(document.activeElement).toBe(item(/Testia/));
    key("ArrowLeft");
    expect(item(/Testia/).getAttribute("aria-expanded")).toBe("false");
  });
});

describe("TaxaExplorer detail and empty state", () => {
  it("opens an uncollected species' reference photo full size", () => {
    renderPage();
    fireEvent.click(item(/Testia/));
    fireEvent.click(item(/^Genus/));
    fireEvent.click(item(/^Delta common/));
    fireEvent.click(screen.getByRole("button", { name: "Open photo of Delta common" }));
    expect(screen.getByTestId("viewer").textContent).toContain("Delta common");
  });

  it("offers Import photos when nothing is photographed yet", () => {
    treeData = { collected: 0, tree: [] };
    renderPage();
    expect(screen.getByRole("button", { name: "Import photos" })).toBeTruthy();
  });
});
