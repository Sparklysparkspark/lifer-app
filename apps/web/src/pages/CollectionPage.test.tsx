// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionItem, RegionSummary } from "@lifer/shared";

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    put: (...a: unknown[]) => put(...a),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

// jsdom has neither; the card text sizing and the grid's lazy reveal only need them to exist.
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", NoopObserver);
vi.stubGlobal("IntersectionObserver", NoopObserver);

const { default: CollectionPage } = await import("./CollectionPage");
const { ConfirmContext } = await import("../hooks/useConfirm");
const { ToastContext } = await import("../hooks/useToast");
const { resetAccountCaches } = await import("../lib/resource");
const { AuthContext } = await import("../hooks/useAuth");
const { resetPackDownloadStore } = await import("../lib/packDownloadStore");
const { resetSpeciesNamePrefsCache } = await import("../lib/speciesName");
const { fluidSizeSteps } = await import("../components/speciesGridLayout");

const region: RegionSummary = {
  id: "r1",
  name: "Freedonia",
  parentId: null,
  ebirdRegionCode: null,
  boundaryGeoJson: null,
  hasChildren: false,
  hasScopedChecklist: true,
  sovereigntyGroup: "FRE",
  isSovereignDependency: false,
};

function species(speciesId: string, commonName: string, state: CollectionItem["state"]): CollectionItem {
  return {
    speciesId,
    commonName,
    scientificName: `${commonName} sci`,
    state,
    taxonClass: "aves",
    family: null,
    isTarget: false,
    tier: null,
    localTier: null,
  } as CollectionItem;
}

// Answers by path prefix, most specific first; anything unlisted never resolves.
function serve(deploymentMode: "desktop" | "server" = "server", downloadRunning = false, birdCodes = true) {
  const jay = species("b", "Ridge Jay", "seen");
  const answers: Array<[string, unknown]> = [
    ["/regions/r1/species/count", { total: 2, collected: 1 }],
    [
      "/regions/r1/species?",
      {
        items: [
          species("a", "Marsh Robin", "collected"),
          birdCodes ? { ...jay, abaCode: "RIJA", ebirdCode: "ridjay" } : jay,
        ],
        region: { id: "r1", name: "Freedonia", ebirdRegionCode: null, boundaryGeoJson: null, hasChildren: false },
        stats: null,
      },
    ],
    ["/regions", { regions: [region] }],
    ["/offline-packs/index", { packs: [] }],
    ["/offline-packs/download/status", { running: downloadRunning, finishedAt: null, error: null }],
    ["/settings", { deploymentMode, dataDir: "/library", libraryRoots: [] }],
  ];
  get.mockImplementation((path: string) => {
    const hit = answers.find(([prefix]) => path === prefix || path.startsWith(prefix));
    return hit ? Promise.resolve(hit[1]) : new Promise(() => {});
  });
}

// Shows the router's location so tests can read what the page wrote to the URL.
function LocationProbe() {
  const location = useLocation();
  return (
    <>
      <output data-testid="location-search">{location.search}</output>
      <output data-testid="location-path">{location.pathname}</output>
    </>
  );
}

const auth = { user: { id: "u1", email: "a@b.c" }, loading: false, login: vi.fn(), register: vi.fn(), logout: vi.fn() };
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

function renderAt(path: string) {
  return render(
    <AuthContext.Provider value={auth}>
      <ToastContext.Provider value={toast}>
        <ConfirmContext.Provider value={vi.fn().mockResolvedValue(false)}>
          <MemoryRouter initialEntries={[path]}>
            <CollectionPage />
            <LocationProbe />
          </MemoryRouter>
        </ConfirmContext.Provider>
      </ToastContext.Provider>
    </AuthContext.Provider>,
  );
}

function params() {
  return new URLSearchParams(screen.getByTestId("location-search").textContent ?? "");
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  put.mockReset().mockResolvedValue({});
  resetAccountCaches();
  resetPackDownloadStore();
  localStorage.clear();
  resetSpeciesNamePrefsCache();
  serve();
});

// Grouping, sort and card size live in the toolbar's View popover.
function openView() {
  fireEvent.click(screen.getByRole("button", { name: /^View/ }));
}

describe("CollectionPage", () => {
  it("starts onboarding on the desktop app's first run, with no pack downloaded", async () => {
    serve("desktop");
    renderAt("/collection");
    await waitFor(() => expect(screen.getByTestId("location-path").textContent).toBe("/onboarding"));
  });

  it("stays on the collection while a download is putting its first pack in", async () => {
    serve("desktop", true);
    renderAt("/collection");
    expect(await screen.findByText("Welcome to Lifer")).toBeTruthy();
    await waitFor(() => expect(get).toHaveBeenCalledWith("/offline-packs/download/status"));
    expect(screen.getByTestId("location-path").textContent).toBe("/collection");
  });

  it("offers a pack on a server's first visit instead", async () => {
    renderAt("/collection");
    expect(await screen.findByText("Welcome to Lifer")).toBeTruthy();
    expect(screen.getByTestId("location-path").textContent).toBe("/collection");
  });

  it("shows a region's checklist with the default sort selected", async () => {
    renderAt("/collection?region=r1");
    expect(await screen.findByText("Marsh Robin")).toBeTruthy();
    expect(screen.getByText("Ridge Jay")).toBeTruthy();
    openView();
    expect((screen.getByRole("combobox", { name: "Sort" }) as HTMLSelectElement).value).toBe("taxonomic");
  });

  it("applies filters and sort already in the URL", async () => {
    renderAt("/collection?region=r1&show=seen&sort=name");
    expect(await screen.findByText("Ridge Jay")).toBeTruthy();
    expect(screen.queryByText("Marsh Robin")).toBeNull();
    openView();
    expect((screen.getByRole("combobox", { name: "Sort" }) as HTMLSelectElement).value).toBe("name");
    expect(screen.getByText("Showing 1 of 2")).toBeTruthy();
  });

  it("keeps arranging in the View menu and links to the name settings that moved", async () => {
    renderAt("/collection?region=r1");
    await screen.findByText("Marsh Robin");
    expect(screen.getByText("Marsh Robin sci").className).toContain("italic");
    openView();
    expect(screen.getByText("Arrange")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Hide names" })).toBeTruthy();
    // No map downloaded, so no pins to offer.
    expect(screen.queryByRole("checkbox", { name: "Show map pins" })).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Main name" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Show card tags" })).toBeNull();
    expect(screen.getByRole("link", { name: "Name display settings" }).getAttribute("href")).toBe("/settings/general");
    // Freedonia's fixture names no country, so there's nothing to count by.
    expect(screen.queryByText("Counting")).toBeNull();
  });

  it("steps the Size slider by column count when cards stretch, and slides freely when grouped", async () => {
    renderAt("/collection?region=r1");
    await screen.findByText("Marsh Robin");
    openView();
    // jsdom has no layout, so the grid falls back to the window's width.
    const steps = fluidSizeSteps(window.innerWidth, 120, 320);
    const slider = screen.getByRole("slider", { name: "Species card size" }) as HTMLInputElement;
    expect(slider.max).toBe(String(steps.length - 1));
    fireEvent.change(slider, { target: { value: String(steps.length - 1) } });
    expect(localStorage.getItem("lifer:speciesCardMinWidth")).toBe(String(steps[steps.length - 1]));
    expect(slider.getAttribute("aria-valuetext")).toMatch(/^\d+ columns?$/);

    fireEvent.change(screen.getByRole("combobox", { name: "Group" }), { target: { value: "tier" } });
    await waitFor(() =>
      expect((screen.getByRole("slider", { name: "Species card size" }) as HTMLInputElement).max).toBe("320"),
    );
  });

  it("writes a new sort into the URL and drops it again for the default", async () => {
    renderAt("/collection?region=r1");
    await screen.findByText("Marsh Robin");
    openView();
    const sort = screen.getByRole("combobox", { name: "Sort" });

    fireEvent.change(sort, { target: { value: "rarity" } });
    await waitFor(() => expect(params().get("sort")).toBe("rarity"));
    expect(params().get("region")).toBe("r1");

    fireEvent.change(sort, { target: { value: "taxonomic" } });
    await waitFor(() => expect(params().has("sort")).toBe(false));
  });

  it("filters the list from the Filters panel and records it in the URL", async () => {
    renderAt("/collection?region=r1");
    await screen.findByText("Marsh Robin");

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Show" }), { target: { value: "collected" } });

    await waitFor(() => expect(params().get("show")).toBe("collected"));
    await waitFor(() => expect(screen.queryByText("Ridge Jay")).toBeNull());
    expect(screen.getByText("Marsh Robin")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Filters (1)" })).toBeTruthy();
  });
});

describe("Include photos from", () => {
  const province: RegionSummary = { ...region, id: "p1", name: "North Freedonia", parentId: "r1" };
  // Marsh Robin's only photo is from elsewhere in Freedonia, so at province level the server
  // returns it as not photographed.
  function serveScoped(countryName: string | null, provinceName: string | null) {
    get.mockImplementation((path: string) => {
      const atProvince = path.includes("photographedIn=province") && provinceName;
      if (path.startsWith("/regions/") && path.includes("/species/count")) {
        return Promise.resolve({ total: 2, collected: atProvince ? 0 : 1 });
      }
      if (path.startsWith("/regions/") && path.includes("/species?")) {
        return Promise.resolve({
          items: [species("a", "Marsh Robin", atProvince ? "unseen" : "collected"), species("b", "Ridge Jay", "seen")],
          region: {
            id: provinceName ? "p1" : "r1",
            name: provinceName ?? "Freedonia",
            ebirdRegionCode: null,
            boundaryGeoJson: null,
            hasChildren: false,
            canDrillDown: false,
            countryName,
            provinceName,
          },
          stats: { total: 2, collected: atProvince ? 0 : 1, seen: 1 },
        });
      }
      if (path === "/regions") return Promise.resolve({ regions: [region, province] });
      if (path === "/offline-packs/index") return Promise.resolve({ packs: [] });
      if (path === "/settings") return Promise.resolve({ deploymentMode: "server", dataDir: "/l", libraryRoots: [] });
      return new Promise(() => {});
    });
  }
  const speciesCalls = () => get.mock.calls.map(([p]) => String(p)).filter((p) => p.includes("/species"));
  const choices = () => screen.getByRole("radiogroup", { name: "Include photos from" });
  const radio = (name: string) => within(choices()).getByRole("radio", { name }) as HTMLInputElement;

  it("offers Anywhere, the country and the province on a province page, Anywhere by default", async () => {
    serveScoped("Freedonia", "North Freedonia");
    renderAt("/collection?region=p1");
    await screen.findByText("Marsh Robin");
    openView();
    expect(
      within(choices())
        .getAllByRole("radio")
        .map((r) => r.getAttribute("value")),
    ).toEqual(["anywhere", "country", "province"]);
    expect(screen.getByText("Counting")).toBeTruthy();
    expect(radio("Freedonia")).toBeTruthy();
    expect(radio("Anywhere").checked).toBe(true);
    expect(speciesCalls().some((p) => p.includes("photographedIn"))).toBe(false);
  });

  it("refetches scoped to the province, saves the choice, and the cards and filter follow", async () => {
    serveScoped("Freedonia", "North Freedonia");
    renderAt("/collection?region=p1&show=collected");
    await screen.findByText("Marsh Robin");
    openView();
    fireEvent.click(radio("North Freedonia"));
    expect(localStorage.getItem("lifer:photographedIn")).toBe(JSON.stringify("province"));
    await waitFor(() => expect(screen.queryByText("Marsh Robin")).toBeNull());
    expect(speciesCalls().some((p) => p.includes("/species/count") && p.includes("photographedIn=province"))).toBe(
      true,
    );
    expect(speciesCalls().some((p) => p.includes("/species?") && p.includes("photographedIn=province"))).toBe(true);
  });

  it("updates the header's count and progress when the choice changes, without a reload", async () => {
    serveScoped("Freedonia", "North Freedonia");
    renderAt("/collection?region=p1");
    await screen.findByText("50% found (1 of 2)");
    openView();
    fireEvent.click(radio("North Freedonia"));
    await screen.findByText("0% found (0 of 2)");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
    fireEvent.click(radio("Anywhere"));
    await screen.findByText("50% found (1 of 2)");
  });

  it("reads a saved province choice as the country on a country page", async () => {
    localStorage.setItem("lifer:photographedIn", JSON.stringify("province"));
    serveScoped("Freedonia", null);
    renderAt("/collection?region=r1");
    await screen.findByText("Marsh Robin");
    openView();
    expect(within(choices()).getAllByRole("radio")).toHaveLength(2);
    expect(radio("Freedonia").checked).toBe(true);
    // The server maps the saved level to this page's country.
    expect(speciesCalls().every((p) => p.includes("photographedIn=province"))).toBe(true);
  });

  it("isn't offered where the page has no country", async () => {
    serveScoped(null, null);
    renderAt("/collection?region=r1");
    await screen.findByText("Marsh Robin");
    openView();
    expect(screen.queryByRole("radiogroup", { name: "Include photos from" })).toBeNull();
  });
});

describe("empty lists and stale filters", () => {
  function serveList(items: CollectionItem[], zones: Array<{ id: string; name: string; addedByYou: number }> = []) {
    get.mockImplementation((path: string) => {
      if (path.startsWith("/regions/r1/sea-zones")) return Promise.resolve({ zones });
      if (path.startsWith("/regions/r1/species/count")) return Promise.resolve({ total: items.length, collected: 0 });
      if (path.startsWith("/regions/r1/species?"))
        return Promise.resolve({
          items,
          region: { id: "r1", name: "Freedonia", ebirdRegionCode: null, boundaryGeoJson: null, hasChildren: false },
          stats: null,
        });
      if (path === "/regions") return Promise.resolve({ regions: [region] });
      if (path === "/offline-packs/index") return Promise.resolve({ packs: [] });
      if (path === "/settings") return Promise.resolve({ deploymentMode: "server", dataDir: "/l", libraryRoots: [] });
      return new Promise(() => {});
    });
  }

  it("says a list with nothing on it is empty, not filtered", async () => {
    serveList([]);
    renderAt("/collection?region=r1&show=collected");
    expect(await screen.findByText("Nothing on this list yet")).toBeTruthy();
    expect(screen.queryByText(/match these filters/)).toBeNull();
  });

  it("clears Animals and sea zones too when an Animals filter emptied the list", async () => {
    serveList([]);
    renderAt("/collection?region=r1&taxon=mammalia&show=collected");
    expect(await screen.findByText("No species here match these filters")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(params().has("taxon")).toBe(false));
    expect(params().has("show")).toBe(false);
    expect(params().get("region")).toBe("r1");
  });

  it("drops sea zone ids the region doesn't offer, and Include land with the last one", async () => {
    serveList([species("a", "Marsh Robin", "collected")], [{ id: "z1", name: "Strait", addedByYou: 1 }]);
    renderAt("/collection?region=r1&seaZones=gone,z1&includeLand=0");
    await waitFor(() => expect(params().get("seaZones")).toBe("z1"));
    expect(params().get("includeLand")).toBe("0");
  });

  it("clears Include land when none of the ticked zones is offered", async () => {
    serveList([species("a", "Marsh Robin", "collected")], [{ id: "z1", name: "Strait", addedByYou: 1 }]);
    renderAt("/collection?region=r1&seaZones=gone&includeLand=0");
    await waitFor(() => expect(params().has("seaZones")).toBe(false));
    expect(params().has("includeLand")).toBe(false);
  });
});
