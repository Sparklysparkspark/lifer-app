// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegionSummary } from "@lifer/shared";
import type { PackStatusEntry } from "../../lib/packIndex";

let packs: PackStatusEntry[] | null = [];
let indexUnavailable = false;
let remote: "online" | "slow" | "offline" = "online";
vi.mock("../../lib/packIndex", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/packIndex")>()),
  usePackIndex: () => ({
    packs,
    freeBytes: null,
    indexUnavailable,
    remote,
    error: null,
    loading: false,
    refresh: vi.fn(),
  }),
  useConnection: () => remote,
}));
vi.mock("../../hooks/useRegionsWithPhotos", () => ({ useRegionsWithPhotos: () => new Set<string>() }));
// The menu measures its panel; jsdom has no ResizeObserver.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);

const { default: RegionBreadcrumb } = await import("./RegionBreadcrumb");
const { ToastContext } = await import("../../hooks/useToast");
const { regionCollapse } = await import("../../lib/regionCollapse");
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

const entry = (region: string, taxon: string, downloaded: boolean) =>
  ({ id: `${region}-${taxon}`, type: "region", region, taxon, downloaded, sizeBytes: 1_000_000 }) as PackStatusEntry;
const northAmerica = { id: "na", name: "North America", parentId: "world" } as RegionSummary;
const countries = [
  { id: "ca", name: "Canada" },
  { id: "us", name: "United States" },
];

function breadcrumb(groupCountries = countries, props: Partial<Parameters<typeof RegionBreadcrumb>[0]> = {}) {
  return (
    <MemoryRouter>
      <ToastContext.Provider value={toast}>
        <RegionBreadcrumb
          regionId="na"
          worldRegion={undefined}
          downloadedCountries={[]}
          breadcrumb={[northAmerica]}
          navigateToRegion={vi.fn()}
          regionMeta={null}
          regionStats={null}
          regionKnownHub
          hubStats={null}
          showEbirdLink={false}
          mapToggle={null}
          childRegions={[]}
          allChildren={[]}
          availableRegionIds={null}
          onDrilledDown={vi.fn()}
          onChecklistChanged={vi.fn()}
          selectedSeaZones={[]}
          includeLand
          groupCountries={groupCountries}
          namingStyles={[]}
          {...props}
        />
      </ToastContext.Provider>
    </MemoryRouter>
  );
}

function renderHub(groupCountries = countries) {
  const view = render(breadcrumb(groupCountries));
  fireEvent.click(screen.getByRole("button", { name: "+ Add species" }));
  return { rerender: () => view.rerender(breadcrumb(groupCountries)) };
}

const item = () => screen.getByRole("menuitem", { name: "Download animal groups" });
const downloadButton = () => screen.getByRole("button", { name: "Download" }) as HTMLButtonElement;
const both = () => [entry("Canada", "aves", true), entry("United States", "aves", true)];

beforeEach(() => {
  packs = [];
  indexUnavailable = false;
  remote = "online";
});

describe("RegionBreadcrumb Add species menu", () => {
  it("on a continent, offers its downloaded countries' missing groups, and no by-hand add", () => {
    packs = [...both(), entry("Canada", "squamata", false)];
    renderHub();
    expect(screen.queryByRole("menuitem", { name: /by hand/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Download more countries" }).getAttribute("href")).toBe(
      "/settings/species/downloads",
    );
    fireEvent.click(item());
    expect(screen.getByRole("dialog", { name: "Add animal groups for Canada and United States" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Reptiles" })).toBeTruthy();
  });

  it("everything downloaded: still opens, and says so in the menu and the dialog", () => {
    packs = both();
    renderHub();
    expect(screen.getByText("Every animal group here is downloaded")).toBeTruthy();
    fireEvent.click(item());
    expect(within(screen.getByRole("dialog")).getByText("Every animal group here is downloaded")).toBeTruthy();
    expect(downloadButton().disabled).toBe(true);
  });

  it("while the pack list is loading, opens at once and says it's getting the list", () => {
    packs = null;
    renderHub();
    fireEvent.click(item());
    expect(screen.getByText("Getting the list of animal groups…")).toBeTruthy();
    expect(downloadButton().disabled).toBe(true);
  });

  it("slow with no list yet: shows what's downloaded, gets the rest, never says offline", () => {
    packs = both();
    indexUnavailable = true;
    remote = "slow";
    renderHub();
    expect(screen.queryByText("Every animal group here is downloaded")).toBeNull();
    fireEvent.click(item());
    expect((screen.getByRole("checkbox", { name: "Birds" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("Getting the list of animal groups…")).toBeTruthy();
    expect(screen.queryByText(/offline/i)).toBeNull();
    expect(downloadButton().disabled).toBe(true);
  });

  it("offline with no list: says so in the dialog, and only then", () => {
    packs = both();
    indexUnavailable = true;
    remote = "offline";
    renderHub();
    fireEvent.click(item());
    expect(screen.getByText(/You're offline, showing what's on this computer/)).toBeTruthy();
    expect(screen.queryByText("Getting the list of animal groups…")).toBeNull();
    expect(downloadButton().disabled).toBe(true);
  });

  it("fills in live when the list lands, and Download turns on for a pick", () => {
    packs = both();
    indexUnavailable = true;
    remote = "slow";
    const { rerender } = renderHub();
    fireEvent.click(item());
    expect(screen.queryByRole("checkbox", { name: "Reptiles" })).toBeNull();
    packs = [...both(), entry("Canada", "squamata", false)];
    indexUnavailable = false;
    remote = "online";
    rerender();
    fireEvent.click(screen.getByRole("checkbox", { name: "Reptiles" }));
    expect(downloadButton().disabled).toBe(false);
  });

  it("with no downloaded country in view, leads to Species downloads instead of going dead", () => {
    renderHub([]);
    expect(item().getAttribute("href")).toBe("/settings/species/downloads");
    expect(screen.getByText("No downloaded country here yet")).toBeTruthy();
  });
});

describe("RegionBreadcrumb with a group holding one province", () => {
  const region = (id: string, name: string, parentId: string | null, scoped = true) =>
    ({ id, name, parentId, hasScopedChecklist: scoped }) as RegionSummary;
  const regions = [
    region("world", "World", null, false),
    region("af", "Africa", "world", false),
    region("eg", "Egypt", "af"),
    region("coast", "The Red Sea Coast", "eg"),
    region("bahr", "Al Bahr al Ahmar", "coast"),
    region("delta", "The Nile Delta", "eg"),
    region("giza", "Giza", "delta"),
    region("cairo", "Cairo", "delta"),
  ];
  const collapse = regionCollapse(regions, null);

  it("lists the group by its familiar name and opens the province", () => {
    const navigateToRegion = vi.fn();
    render(
      breadcrumb(countries, {
        regionId: "eg",
        regionKnownHub: false,
        breadcrumb: collapse.trail("eg"),
        childRegions: collapse.areasOf("eg"),
        navigateToRegion,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "The Red Sea Coast" }));
    expect(navigateToRegion).toHaveBeenCalledWith("bahr");
    expect(screen.queryByRole("button", { name: "Al Bahr al Ahmar" })).toBeNull();
  });

  it("titles the province's page with the group's name, once, and no one-pill row", () => {
    render(
      breadcrumb(countries, {
        regionId: "bahr",
        regionKnownHub: false,
        regionMeta: { id: "bahr", name: "Al Bahr al Ahmar" } as Parameters<typeof RegionBreadcrumb>[0]["regionMeta"],
        breadcrumb: collapse.trail("bahr"),
        childRegions: collapse.areasOf("bahr"),
      }),
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("The Red Sea Coast");
    const nav = within(screen.getByRole("navigation"));
    expect(nav.queryByText("The Red Sea Coast")).toBeNull();
    expect(nav.getByRole("button", { name: "Egypt" })).toBeTruthy();
    expect(screen.queryByText("Al Bahr al Ahmar")).toBeNull();
    expect(screen.queryByText(/^Areas in/)).toBeNull();
  });
});
