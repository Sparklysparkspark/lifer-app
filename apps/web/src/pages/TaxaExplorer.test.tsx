// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from "react-router-dom";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LightboxSlide } from "../components/Lightbox";

let treeData: unknown;
let treePath = "";
// What a region's tree request answers; by default it answers at once with treeData.
let regionAnswer: { data: unknown; error: unknown } | null = null;
const reload = vi.fn(async () => {});
vi.mock("../lib/resource", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/resource")>()),
  useApiResource: (path: string) => {
    treePath = path;
    const answer = regionAnswer && path.includes("regionId") ? regionAnswer : { data: treeData, error: null };
    return { ...answer, reload };
  },
}));
const world = { id: "r-world", name: "World" };
const canada = { id: "r-ca", name: "Canada" };
const bc = { id: "r-bc", name: "British Columbia" };
vi.mock("./collection/useRegionTree", () => ({
  useRegionTree: (regionId: string | null) => ({
    regionsLoaded: true,
    worldRegion: world,
    downloadedCountries: [canada],
    breadcrumb: regionId === bc.id ? [world, canada, bc] : regionId === canada.id ? [world, canada] : [],
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
const toast = { show: vi.fn(), error: vi.fn() };
vi.mock("../hooks/useToast", () => ({ useToast: () => toast }));
const confirm = vi.fn(async () => true);
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => confirm }));
const post = vi.fn(async (_path: string, body: { speciesIds: string[] }) => ({
  ok: true,
  changedIds: body.speciesIds,
}));
vi.mock("../api/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/client")>();
  return { ...real, api: { ...real.api, post: (path: string, body: never) => post(path, body) } };
});
vi.mock("../hooks/useScrollMemory", () => ({ useScrollMemory: () => {} }));

const { default: TaxaExplorer } = await import("./TaxaExplorer");
const { explorerMemory } = await import("./explorer/treeModel");

// Beta is on your targets though photographed; Delta is seen, not photographed.
const species = (name: string, photoId: string | null, collected = 1) => ({
  rank: "species",
  name,
  commonName: `${name} common`,
  speciesId: `sp-${name}`,
  collected,
  total: 1,
  photos: collected,
  targetCount: name === "Beta" ? 1 : 0,
  seenCount: name === "Delta" ? 1 : 0,
  tiers: { [name === "Gamma" ? "rare" : "common"]: 1 },
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
  targetCount: 1,
  seenCount: 1,
  tiers: { common: 3, rare: 1 },
  photoId: "p-a",
  children: [species("Alpha", "p-a"), species("Beta", null), species("Gamma", "p-g"), species("Delta", null, 0)],
};
const tree = {
  collected: 3,
  tree: [
    {
      rank: "class",
      name: "Testia",
      collected: 3,
      total: 4,
      photos: 3,
      targetCount: 1,
      seenCount: 1,
      tiers: { common: 3, rare: 1 },
      photoId: "p-a",
      children: [genus],
    },
  ],
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
  regionAnswer = null;
  reload.mockClear();
  post.mockClear();
  confirm.mockClear();
  toast.show.mockClear();
  localStorage.removeItem("lifer:explorer.targetsOnly");
  localStorage.removeItem("lifer:explorer.rarity");
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
    const testia = screen.getByRole("button", { name: /^Testia, 3 of 4 species/ });
    testia.focus();
    fireEvent.keyDown(testia, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Genus, 3 of 4 species/ }));
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
    fireEvent.click(screen.getByRole("button", { name: /^Testia, 3 of 4 species/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Genus, 3 of 4 species/ }));
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

  it("treats World as all regions, without a region filter", () => {
    render(
      <MemoryRouter initialEntries={["/explore?region=r-world"]}>
        <TaxaExplorer />
      </MemoryRouter>,
    );
    expect(treePath).not.toContain("regionId");
    expect(screen.getByRole("navigation", { name: "Region" }).textContent).toBe("All regions");
    expect(screen.getByRole("button", { name: "Canada" })).toBeTruthy();
  });

  it("shows a region that fails to load as failed with Retry, keeping the region pills usable", () => {
    renderPage();
    regionAnswer = { data: null, error: new Error("500") };
    fireEvent.click(screen.getByRole("button", { name: "Canada" }));
    expect(screen.getByText("Couldn't load your species tree.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "British Columbia" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(reload).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "All regions" }));
    expect(screen.queryByText("Couldn't load your species tree.")).toBeNull();
  });

  it("stops dimming a region that never answers and offers Retry", () => {
    vi.useFakeTimers();
    try {
      renderPage();
      regionAnswer = { data: null, error: null };
      fireEvent.click(screen.getByRole("button", { name: "Canada" }));
      expect(document.querySelector("[aria-busy=true]")).toBeTruthy();
      act(() => vi.advanceTimersByTime(30_000));
      expect(document.querySelector("[aria-busy=true]")).toBeNull();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
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

const detailEmpty = () => screen.queryByText("Pick a group or species to see your photos of it.");

describe("TaxaExplorer stepping back out", () => {
  it("leaves nothing selected after the circle's middle or the focus trail steps out", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Circle" }));
    fireEvent.click(screen.getByRole("button", { name: /^Testia, 3 of 4 species/ }));
    expect(screen.getByRole("heading", { name: "Testia" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Step back out" }));
    expect(detailEmpty()).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Testia, 3 of 4 species/ }).getAttribute("stroke-width")).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: /^Testia, 3 of 4 species/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Genus, 3 of 4 species/ }));
    fireEvent.click(screen.getByRole("button", { name: "All groups" }));
    expect(focused()).toBeNull();
    expect(detailEmpty()).toBeTruthy();
  });

  it("puts back each layer's own selection on Back and Forward", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Circle" }));
    fireEvent.click(screen.getByRole("button", { name: /^Testia, 3 of 4 species/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Genus, 3 of 4 species/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Alpha common, 1 of 1/ }));
    expect(screen.getByRole("heading", { name: "Alpha common" })).toBeTruthy();
    const heading = () => screen.queryByRole("heading", { level: 2 })?.textContent ?? null;
    const steps: [number, string | null, string | null][] = [
      [-1, "Testia", "Testia"],
      [-1, null, null],
      [1, "Testia", "Testia"],
      [1, "Genus", "Alpha common"],
      [-1, "Testia", "Testia"],
      [1, "Genus", "Alpha common"],
    ];
    for (const [delta, focus, shown] of steps) {
      act(() => navigate(delta));
      if (focus) expect(focused()).toContain(focus);
      else expect(focused()).toBeNull();
      expect(heading()).toBe(shown);
    }
  });

  it("puts back each region's own open rows and selection on Back and Forward, without new entries", () => {
    renderPage();
    fireEvent.click(item(/Testia/));
    expect(item(/^Genus/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Canada" }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.queryByRole("treeitem", { name: /^Genus/ })).toBeNull();
    act(() => navigate(-1));
    expect(screen.getByTestId("url").textContent).toBe("");
    expect(item(/^Genus/)).toBeTruthy();
    expect(item(/Testia/).getAttribute("aria-selected")).toBe("true");
    act(() => navigate(1));
    expect(screen.getByTestId("url").textContent).toContain("region=r-ca");
    expect(screen.queryByRole("treeitem", { name: /^Genus/ })).toBeNull();
    // Opening rows and selecting rewrote the entries in place: one more Back is Stats.
    act(() => navigate(-2));
    expect(screen.getByText("Stats page")).toBeTruthy();
  });

  it("clears the list's selection when its focus trail steps out", () => {
    renderPage();
    fireEvent.click(item(/Testia/));
    fireEvent.click(item(/^Genus/));
    fireEvent.click(screen.getByRole("button", { name: "Focus on this group" }));
    fireEvent.click(item(/^Alpha common/));
    const trail = screen.getByRole("navigation", { name: "Focused group" });
    fireEvent.click(within(trail).getByRole("button", { name: "Testia" }));
    expect(detailEmpty()).toBeTruthy();
    expect(item(/^Genus/).getAttribute("aria-selected")).toBe("false");
  });
});

describe("TaxaExplorer targets and seen", () => {
  it("marks targeted and seen species and counts them on groups", () => {
    renderPage();
    expect(item(/Testia/).textContent).toContain("1 target");
    expect(item(/Testia/).textContent).toContain("1 seen");
    fireEvent.click(item(/Testia/));
    fireEvent.click(item(/^Genus/));
    expect(screen.getByRole("img", { name: "On your targets" }).closest("[role=treeitem]")).toBe(item(/^Beta/));
    expect(screen.getByRole("img", { name: "Seen, not yet photographed" }).closest("[role=treeitem]")).toBe(
      item(/^Delta/),
    );
    expect(screen.getByRole("link", { name: "1 target" }).getAttribute("href")).toBe("/collection?show=target");
  });

  it("targets a group's species you haven't photographed at once, with Undo", async () => {
    renderPage();
    fireEvent.click(item(/Testia/));
    fireEvent.click(item(/^Genus/));
    // Delta is the only one not photographed; already seen, so no Mark as seen for the group.
    expect(screen.queryByRole("button", { name: /as seen/ })).toBeNull();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Target 1 species you haven't photographed" })),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith("/collection/bulk", { action: "target", speciesIds: ["sp-Delta"] });
    expect(reload).toHaveBeenCalled();
    const [message, options] = toast.show.mock.calls[0];
    expect(message).toBe("Added 1 species to your targets.");
    await act(async () => options.actions[0].onClick());
    expect(post).toHaveBeenLastCalledWith("/collection/bulk", { action: "untarget", speciesIds: ["sp-Delta"] });
  });

  it("asks first with the exact count for a big group, and does nothing when declined", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...species(`S${i}`, null, 0), seenCount: 0 }));
    treeData = {
      collected: 1,
      tree: [{ ...tree.tree[0], children: [{ ...genus, total: 16, children: [...genus.children, ...many] }] }],
    };
    confirm.mockResolvedValueOnce(false);
    renderPage();
    fireEvent.click(item(/Testia/));
    fireEvent.click(item(/^Genus/));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Mark 12 species as seen" })));
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Mark 12 species in Genus as seen?", confirmLabel: "Mark 12 species as seen" }),
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("offers the same actions on a right-click, and a species' own marks in the detail", async () => {
    renderPage();
    fireEvent.click(item(/Testia/));
    fireEvent.click(item(/^Genus/));
    fireEvent.contextMenu(item(/^Beta/));
    expect(screen.getByRole("menuitem", { name: "Remove from targets" })).toBeTruthy();
    // Photographed, so not offered as seen.
    expect(screen.queryByRole("menuitem", { name: "Mark as seen" })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Remove from targets" })));
    expect(post).toHaveBeenCalledWith("/collection/bulk", { action: "untarget", speciesIds: ["sp-Beta"] });

    fireEvent.click(item(/^Delta/));
    expect(screen.getByRole("button", { name: "Mark as unseen" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add to targets" })).toBeTruthy();
  });

  it("shows only the branches holding targets when the remembered View option is on", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(screen.getByRole("switch", { name: "Show only my targets" }));
    // Remembered state (docs/docs/contributing/remembered-state.md): Show only my targets.
    expect(localStorage.getItem("lifer:explorer.targetsOnly")).toBe("true");
    cleanup();
    renderPage();
    fireEvent.click(item(/Testia/));
    fireEvent.click(item(/^Genus/));
    expect(screen.getAllByRole("treeitem").map((r) => r.textContent?.split(" ")[0])).toEqual([
      expect.stringContaining("Class"),
      expect.stringContaining("Genus"),
      expect.stringContaining("Beta"),
    ]);
  });

  it("says when no targets are in view, with a way back to every species", () => {
    localStorage.setItem("lifer:explorer.targetsOnly", "true");
    treeData = {
      ...tree,
      tree: [{ ...tree.tree[0], targetCount: 0, children: [{ ...genus, targetCount: 0, children: [] }] }],
    };
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Show every species" }));
    expect(item(/Testia/)).toBeTruthy();
  });

  it("marks circle segments holding targets, named and explained by a legend", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Circle" }));
    expect(screen.getByRole("button", { name: "Testia, 3 of 4 species, 1 target" })).toBeTruthy();
    expect(screen.getByText("Holds species on your targets")).toBeTruthy();
  });
});

describe("TaxaExplorer rarity, photos and Random", () => {
  it("shades the circle by rarity once a region is picked, with a legend, and remembers turning it off", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Circle" }));
    expect(screen.queryByRole("list", { name: "Rarity, commonest to rarest" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Canada" }));
    // (0 + 0 + 0 + 3) / 4 rounds to occasional; Gamma is the one rare.
    expect(
      screen.getByRole("button", { name: /^Testia, 3 of 4 species.*Mostly Occasional, 1 of 4 rare or rarer$/ }),
    ).toBeTruthy();
    expect(screen.getByRole("list", { name: "Rarity, commonest to rarest" }).textContent).toBe(
      "CommonOccasionalUncommonRareLegendary",
    );
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(screen.getByRole("switch", { name: "Show rarity" }));
    // Remembered state (docs/docs/contributing/remembered-state.md): Show rarity.
    expect(localStorage.getItem("lifer:explorer.rarity")).toBe("false");
    expect(screen.queryByRole("list", { name: "Rarity, commonest to rarest" })).toBeNull();
  });

  it("keeps the green photographed fill with rarity on, and puts rarity in its own band", () => {
    const { container } = renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Circle" }));
    const paths = (cls: string) => container.querySelectorAll(`svg path[class*="${cls}"]`).length;
    expect(screen.getByRole("list", { name: "What the green fill shows" }).textContent).toBe("PhotographedNot yet");
    expect(paths("fill-accent")).toBeGreaterThan(0);
    expect(paths("fill-rarity-")).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Canada" }));
    expect(paths("fill-accent")).toBeGreaterThan(0);
    // Testia averages Occasional; its species Alpha is Common.
    expect(paths("fill-rarity-occasional")).toBeGreaterThan(0);
    expect(paths("fill-rarity-common")).toBeGreaterThan(0);
  });

  it("names a species' local and worldwide rarity apart in the pane", () => {
    const gamma = { ...species("Gamma", "p-g"), tiers: { legendary: 1 } };
    treeData = {
      ...tree,
      tree: [{ ...tree.tree[0], children: [{ ...genus, children: [species("Alpha", "p-a"), gamma] }] }],
    };
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Canada" }));
    fireEvent.click(item(/Testia/));
    fireEvent.click(item(/^Genus/));
    fireEvent.click(item(/^Gamma/));
    const pane = screen.getByRole("complementary");
    expect(within(pane).getByText("Legendary in Canada")).toBeTruthy();
    expect(within(pane).getByText("Rare worldwide")).toBeTruthy();
  });

  it("labels list rows with their rarity when the option is on", () => {
    localStorage.setItem("lifer:explorer.rarity", "true");
    renderPage();
    fireEvent.click(item(/Testia/));
    fireEvent.click(item(/^Genus/));
    expect(item(/^Gamma/).textContent).toContain("Rare");
    expect(item(/^Genus/).textContent).toContain("Mostly Occasional");
  });

  it("has one Random species button, which picks from the selected group", () => {
    renderPage();
    expect(screen.getAllByRole("button", { name: "Random species" })).toHaveLength(1);
    fireEvent.click(item(/Testia/));
    expect(screen.getAllByRole("button", { name: "Random species" })).toHaveLength(1);
  });

  it("pages through every photographed species of a group in the pane", () => {
    const many = Array.from({ length: 40 }, (_, i) => species(`P${i}`, `p-${i}`));
    treeData = {
      collected: 40,
      tree: [
        {
          ...tree.tree[0],
          collected: 40,
          total: 40,
          children: [{ ...genus, collected: 40, total: 40, children: many }],
        },
      ],
    };
    renderPage();
    fireEvent.click(item(/Testia/));
    const pane = () => screen.getByRole("complementary");
    expect(within(pane()).getAllByRole("button", { name: /^Open photo of/ })).toHaveLength(30);
    fireEvent.click(within(pane()).getByRole("button", { name: "Show 10 more species" }));
    expect(within(pane()).getAllByRole("button", { name: /^Open photo of/ })).toHaveLength(40);
  });
});

// One huge order and three single-species orders: the small ones are too thin to draw in the circle.
const group = (rank: string, name: string, total: number, children: unknown[]) => ({
  rank,
  name,
  collected: 0,
  total,
  photos: 0,
  targetCount: 0,
  seenCount: 0,
  tiers: { common: total },
  photoId: null,
  children,
});
const thinTree = (orders: string[]) => ({
  collected: 1,
  tree: [
    group(
      "class",
      "Big",
      2003,
      orders.map((o) => group("order", o, o === "Huge" ? 2000 : 1, [species(`S${o}`, null, 0)])),
    ),
  ],
});

describe("TaxaExplorer more-groups arcs", () => {
  const more = () => screen.getByRole("button", { name: /^3 more groups, \d+ of 3 species/ });
  const openBig = () => {
    treeData = thinTree(["Huge", "T1", "T2", "T3"]);
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Circle" }));
    fireEvent.click(screen.getByRole("button", { name: /^Big, / }));
  };

  it("zooms into the merged groups on click, steps out with the middle and Back", () => {
    openBig();
    fireEvent.click(more());
    expect(screen.getByTestId("url").textContent).toContain("rest=");
    expect(focused()).toContain("3 more groups");
    expect(screen.getByRole("button", { name: /^T1, 1 of 1|^T1, 0 of 1/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Huge/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Step back out" }));
    expect(focused()).not.toContain("more groups");
    fireEvent.click(more());
    act(() => navigate(-1));
    expect(focused()).not.toContain("more groups");
    expect(screen.getByRole("button", { name: /^Huge/ })).toBeTruthy();
  });

  it("opens from the keyboard and the trail steps out", () => {
    openBig();
    const arc = more();
    act(() => arc.focus());
    fireEvent.keyDown(arc, { key: "Enter" });
    expect(focused()).toContain("3 more groups");
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Focused group" })).getByRole("button", { name: "Big" }),
    );
    expect(focused()).not.toContain("more groups");
  });

  it("restores a more view from the link", () => {
    treeData = thinTree(["Huge", "T1", "T2", "T3"]);
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Circle" }));
    act(() => navigate("/explore?focus=class%3ABig&rest=1"));
    expect(focused()).toContain("3 more groups");
  });
});

describe("TaxaExplorer region change while focused", () => {
  const swap = (inCanada: string[], view: "circle" | "list") => {
    treeData = thinTree(["Huge", "T1", "T2", "T3"]);
    regionAnswer = { data: thinTree(inCanada), error: null };
    explorerMemory.selected = "class:Big/order:Huge/species:SHuge";
    if (view === "circle") localStorage.setItem("lifer:explorer.view", JSON.stringify("circle"));
    renderPage();
    act(() => navigate("/explore?focus=class%3ABig%2Forder%3AHuge"));
    if (view === "circle") fireEvent.mouseEnter(screen.getByRole("button", { name: /^SHuge common|^SHuge/ }));
    fireEvent.click(screen.getByRole("button", { name: "Canada" }));
  };

  it("steps up with a note when the focused group is missing there, in the circle", () => {
    swap(["T1"], "circle");
    expect(screen.getByText("No Huge recorded in Canada, so this shows Big.")).toBeTruthy();
    expect(focused()).toContain("Big");
    expect(detailEmpty()).toBeTruthy();
  });

  it("steps up with a note in the list too, and keeps the group when it is still there", () => {
    swap(["T1"], "list");
    expect(screen.getByText(/No Huge recorded in Canada/)).toBeTruthy();
    cleanup();
    swap(["Huge"], "circle");
    expect(screen.queryByText(/recorded in Canada/)).toBeNull();
    expect(focused()).toContain("Huge");
  });
});

describe("TaxaExplorer selection and history", () => {
  const testia = () => screen.getByRole("button", { name: /^Testia, 3 of 4 species/ });
  const selectedArcs = () =>
    screen.getAllByRole("button").filter((b) => b.tagName === "path" && b.getAttribute("stroke-width") === "3");

  it("leaves no wedge selected after a swipe back out, a Forward and a reload", () => {
    localStorage.setItem("lifer:explorer.view", JSON.stringify("circle"));
    renderPage();
    act(() => testia().focus());
    fireEvent.click(testia());
    const genus = screen.getByRole("button", { name: /^Genus, 3 of 4 species/ });
    act(() => genus.focus());
    fireEvent.click(genus);
    expect(focused()).toContain("Genus");
    // Back swipe to the wider view: the clicked wedge is no longer selected, its middle is.
    act(() => navigate(-1));
    expect(focused()).not.toContain("Genus");
    expect(screen.queryByRole("heading", { name: "Genus" })).toBeNull();
    expect(selectedArcs()).toEqual([]);
    expect(explorerMemory.selected).not.toBe("class:Testia/genus:Genus");
    // Forward re-enters the zoomed view; stepping out again leaves nothing selected.
    act(() => navigate(1));
    expect(screen.getByRole("heading", { name: "Genus" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Step back out" }));
    expect(selectedArcs()).toEqual([]);
    // A reload on the wider view restores no selection.
    cleanup();
    renderPage();
    expect(selectedArcs()).toEqual([]);
    expect(detailEmpty()).toBeTruthy();
  });
});
