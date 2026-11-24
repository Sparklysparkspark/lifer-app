// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from "react-router-dom";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LightboxSlide } from "../components/Lightbox";

let treeData: unknown;
let treePath = "";
vi.mock("../lib/resource", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/resource")>()),
  useApiResource: (path: string) => {
    treePath = path;
    return { data: treeData, error: null, reload: async () => {} };
  },
}));
const canada = { id: "r-ca", name: "Canada" };
const bc = { id: "r-bc", name: "British Columbia" };
vi.mock("./collection/useRegionTree", () => ({
  useRegionTree: (regionId: string | null) => ({
    downloadedCountries: [canada],
    breadcrumb: regionId === bc.id ? [canada, bc] : regionId ? [canada] : [],
    children: regionId === canada.id ? [bc] : [],
  }),
}));
vi.mock("../hooks/useRegionsWithPhotos", () => ({ useRegionsWithPhotos: () => null }));
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);
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
let navigate: NavigateFunction;
function Probe() {
  const nav = useNavigate();
  useEffect(() => void (navigate = nav), [nav]);
  return <output data-testid="url">{useLocation().search}</output>;
}
function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/stats", "/explore"]} initialIndex={1}>
      <Routes>
        <Route path="/stats" element={<p>Stats page</p>} />
        <Route
          path="/explore"
          element={
            <>
              <TaxaExplorer />
              <Probe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}
const focused = () => screen.queryByRole("navigation", { name: "Focused group" })?.textContent ?? null;

beforeEach(() => {
  treeData = tree;
  explorerMemory.expanded = new Set();
  explorerMemory.selected = null;
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

  it("names a class from another taxa group in words, not its raw lowercase name", () => {
    treeData = { ...tree, tree: [{ ...tree.tree[0], name: "insecta" }] };
    renderPage();
    expect(item(/Insects/)).toBeTruthy();
    expect(screen.queryByText("insecta")).toBeNull();
  });

  it("hides genera unless the View option shows them", () => {
    localStorage.setItem("lifer:explorer.genus", "false");
    renderPage();
    fireEvent.click(item(/Testia/));
    expect(screen.queryByRole("treeitem", { name: /^Genus/ })).toBeNull();
    expect(item(/^Alpha common/).getAttribute("aria-level")).toBe("2");
  });

  it("focuses on a group with a breadcrumb back out, kept in the URL", () => {
    renderPage();
    fireEvent.click(item(/Testia/));
    fireEvent.click(item(/^Genus/));
    fireEvent.click(screen.getByRole("button", { name: "Focus on this group" }));
    const crumbs = screen.getByRole("navigation", { name: "Focused group" });
    expect(crumbs.textContent).toContain("Testia");
    expect(screen.queryByRole("treeitem", { name: /Testia/ })).toBeNull();
    expect(item(/^Alpha common/).getAttribute("aria-level")).toBe("1");
    expect(screen.getByTestId("url").textContent).toBe("?focus=class%3ATestia%2Fgenus%3AGenus");
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

describe("TaxaExplorer layers, regions and genera", () => {
  it("starts each row, and so its highlight, at its own indent", () => {
    renderPage();
    fireEvent.click(item(/Testia/));
    expect(item(/Testia/).style.left).toBe("0px");
    expect(item(/^Genus/).style.left).toBe("24px");
    fireEvent.click(item(/^Genus/));
    expect(item(/^Alpha common/).style.left).toBe("48px");
  });

  it("steps back out of the circle one layer at a time, forward re-enters, and the header Back leaves", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Circle" }));
    fireEvent.click(screen.getByRole("button", { name: "Testia, 3 of 4 species" }));
    fireEvent.click(screen.getByRole("button", { name: "Genus, 3 of 4 species" }));
    expect(focused()).toContain("Genus");

    act(() => navigate(-1));
    expect(focused()).toContain("Testia");
    expect(focused()).not.toContain("Genus");
    act(() => navigate(-1));
    expect(focused()).toBeNull();
    act(() => navigate(1));
    expect(focused()).toContain("Testia");
    act(() => navigate(1));
    expect(focused()).toContain("Genus");

    // Two layers in, the header's Back still returns to Stats in one press.
    window.history.replaceState({ idx: 3 }, "");
    fireEvent.click(screen.getByRole("button", { name: "← Stats" }));
    expect(screen.getByText("Stats page")).toBeTruthy();
  });

  it("filters to a region from the same pills as Collection, in the URL, keeping the focus", () => {
    renderPage();
    expect(treePath).not.toContain("regionId");
    fireEvent.click(item(/Testia/));
    fireEvent.click(screen.getByRole("button", { name: "Focus on this group" }));
    fireEvent.click(screen.getByRole("button", { name: "Canada" }));
    expect(treePath).toContain("regionId=r-ca");
    expect(screen.getByTestId("url").textContent).toContain("region=r-ca");
    expect(focused()).toContain("Testia");
    fireEvent.click(screen.getByRole("button", { name: "British Columbia" }));
    const trail = screen.getByRole("navigation", { name: "Region" });
    expect(trail.textContent).toBe("All regions›Canada›British Columbia");

    act(() => navigate(-1));
    expect(treePath).toContain("regionId=r-ca");
    fireEvent.click(screen.getByRole("button", { name: "All regions" }));
    expect(treePath).not.toContain("regionId");
  });

  it("shows a region with nothing in it as empty, not as no photos at all", () => {
    treeData = { collected: 0, tree: [] };
    render(
      <MemoryRouter initialEntries={["/explore?region=r-ca"]}>
        <TaxaExplorer />
      </MemoryRouter>,
    );
    expect(screen.getByText("No species from here in your downloaded regions")).toBeTruthy();
    expect(screen.queryByText("No species photographed yet")).toBeNull();
  });

  it("explains genera in a tooltip when its switch takes keyboard focus", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    const toggle = screen.getByRole("switch", { name: "Show genera" });
    vi.spyOn(toggle, "matches").mockReturnValue(true);
    fireEvent.focus(toggle);
    expect(await screen.findByText(/Most American orioles are in the genus Icterus/)).toBeTruthy();
  });

  it("shares the Collection's colour switch for species you have not photographed", () => {
    const { container } = renderPage();
    const root = () => container.querySelector("[data-uncollected-colour]");
    expect(root()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(screen.getByRole("switch", { name: "Show uncollected species in colour" }));
    expect(root()).not.toBeNull();
    expect(localStorage.getItem("lifer:uncollectedColour")).not.toBeNull();
  });
});
