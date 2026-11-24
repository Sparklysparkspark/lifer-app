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
});
afterEach(cleanup);

describe("TaxaExplorer", () => {
  it("opens a photo without selecting, expanding or collapsing anything", () => {
    renderPage();
    const testia = item(/^Testia/);
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
    fireEvent.click(item(/^Testia/));
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
    fireEvent.click(item(/^Testia/));
    fireEvent.click(item(/^Genus/));
    fireEvent.click(item(/^Beta common/));
    cleanup();

    renderPage();
    expect(item(/^Genus/).getAttribute("aria-expanded")).toBe("true");
    expect(item(/^Beta common/).getAttribute("aria-selected")).toBe("true");
  });

  it("shows what is left to find, and each group's progress", () => {
    renderPage();
    expect(item(/^Testia/).textContent).toContain("3 of 4");
    fireEvent.click(item(/^Testia/));
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

  it("jumps to a search match, opening only the groups above it", () => {
    renderPage();
    fireEvent.change(screen.getByPlaceholderText("Jump to a group or species"), { target: { value: "gamm" } });
    expect(item(/^Genus/).getAttribute("aria-expanded")).toBe("true");
    expect(item(/^Gamma common/).className).toContain("ring-accent");
    expect(screen.getByText("1 of 1")).toBeTruthy();
  });

  it("moves with the arrow keys, opens with Right, closes with Left and selects with Enter", () => {
    renderPage();
    const tree = screen.getByRole("tree");
    const key = (k: string) => fireEvent.keyDown(document.activeElement ?? tree, { key: k });
    item(/^Testia/).focus();
    key("ArrowRight");
    expect(item(/^Testia/).getAttribute("aria-expanded")).toBe("true");
    key("ArrowDown");
    expect(document.activeElement).toBe(item(/^Genus/));
    key("Enter");
    expect(item(/^Genus/).getAttribute("aria-selected")).toBe("true");
    key("ArrowLeft");
    expect(document.activeElement).toBe(item(/^Testia/));
    key("ArrowLeft");
    expect(item(/^Testia/).getAttribute("aria-expanded")).toBe("false");
  });
});

describe("TaxaExplorer detail and empty state", () => {
  it("opens an uncollected species' reference photo full size", () => {
    renderPage();
    fireEvent.click(item(/^Testia/));
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
