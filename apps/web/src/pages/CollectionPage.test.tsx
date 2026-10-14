// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionItem, RegionSummary } from "@lifer/shared";

const get = vi.fn();
const post = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    put: vi.fn(),
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
function serve() {
  const answers: Array<[string, unknown]> = [
    ["/regions/r1/species/count", { total: 2, collected: 1 }],
    [
      "/regions/r1/species?",
      {
        items: [species("a", "Marsh Robin", "collected"), species("b", "Ridge Jay", "seen")],
        region: { id: "r1", name: "Freedonia", ebirdRegionCode: null, boundaryGeoJson: null, hasChildren: false },
        stats: null,
      },
    ],
    ["/regions", { regions: [region] }],
    ["/offline-packs/index", { packs: [] }],
  ];
  get.mockImplementation((path: string) => {
    const hit = answers.find(([prefix]) => path === prefix || path.startsWith(prefix));
    return hit ? Promise.resolve(hit[1]) : new Promise(() => {});
  });
}

// Shows the router's query string so tests can read what the page wrote to the URL.
function LocationProbe() {
  return <output data-testid="location-search">{useLocation().search}</output>;
}

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

function renderAt(path: string) {
  return render(
    <ToastContext.Provider value={toast}>
      <ConfirmContext.Provider value={vi.fn().mockResolvedValue(false)}>
        <MemoryRouter initialEntries={[path]}>
          <CollectionPage />
          <LocationProbe />
        </MemoryRouter>
      </ConfirmContext.Provider>
    </ToastContext.Provider>,
  );
}

function params() {
  return new URLSearchParams(screen.getByTestId("location-search").textContent ?? "");
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  resetAccountCaches();
  localStorage.clear();
  serve();
});

describe("CollectionPage", () => {
  it("shows a region's checklist with the default sort selected", async () => {
    renderAt("/collection?region=r1");
    expect(await screen.findByText("Marsh Robin")).toBeTruthy();
    expect(screen.getByText("Ridge Jay")).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Sort" }) as HTMLSelectElement).value).toBe("taxonomic");
  });

  it("applies filters and sort already in the URL", async () => {
    renderAt("/collection?region=r1&show=seen&sort=name");
    expect(await screen.findByText("Ridge Jay")).toBeTruthy();
    expect(screen.queryByText("Marsh Robin")).toBeNull();
    expect((screen.getByRole("combobox", { name: "Sort" }) as HTMLSelectElement).value).toBe("name");
    expect(screen.getByText("Showing 1 of 2")).toBeTruthy();
  });

  it("writes a new sort into the URL and drops it again for the default", async () => {
    renderAt("/collection?region=r1");
    await screen.findByText("Marsh Robin");
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
