// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAccountCaches } from "../lib/resource";
import type { SpeciesCapture, SpeciesDetail } from "./species/types";

const get = vi.fn();
const patch = vi.fn();
const del = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: {
    get: (...a: unknown[]) => get(...a),
    post: vi.fn(),
    put: vi.fn(),
    patch: (...a: unknown[]) => patch(...a),
    delete: (...a: unknown[]) => del(...a),
  },
}));
const toast = { error: vi.fn(), success: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };
vi.mock("../hooks/useToast", () => ({ useToast: () => toast }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn() }));
// maplibre-gl needs WebGL, which jsdom lacks.
vi.mock("../components/SpeciesHotspotMap", () => ({ default: () => null }));

const { default: SpeciesDetailPage } = await import("./SpeciesDetailPage");

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
vi.stubGlobal("ResizeObserver", NoopObserver);
vi.stubGlobal("IntersectionObserver", NoopObserver);

function speciesDetail(captures: Partial<SpeciesCapture>[], userSpecies: SpeciesDetail["userSpecies"] = null) {
  return {
    species: {
      id: "sp1",
      scientific_name: "Ardea herodias",
      common_name: "Great Blue Heron",
      is_other_taxa: false,
      reference_photo_url: null,
      description: null,
    },
    captures: captures.map((c, i) => ({ id: `cap${i}`, photo_id: `ph${i}`, tags: [], photo_kind: "image", ...c })),
    userSpecies,
    referencePhotos: [],
    seasonality: null,
    weeklyFrequency: null,
    weeklyRegionName: null,
    localTier: null,
    isVagrant: false,
    isInvasive: false,
    endemicCountryName: null,
    isArchived: false,
    regionBoundaryGeoJson: null,
    hotspotDistribution: null,
    hotspots: [],
  } as unknown as SpeciesDetail;
}

// The species' own requests answer; anything else (regions, settings, volumes) never does.
function serve(detail: SpeciesDetail) {
  get.mockImplementation((path: string) => {
    if (path === "/species/sp1") return Promise.resolve(detail);
    if (path === "/species/sp1/unmatched-raws") return Promise.resolve({ rawFiles: [] });
    return new Promise(() => {});
  });
}

function CollectionAt() {
  const { search } = useLocation();
  return <p>Collection {search}</p>;
}

function renderPage(entry: string = "/species/sp1") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/species/:id" element={<SpeciesDetailPage />} />
        <Route path="/" element={<CollectionAt />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetAccountCaches();
  get.mockReset();
  patch.mockReset();
  del.mockReset();
  toast.error.mockReset();
  window.scrollTo = vi.fn();
  localStorage.clear();
});
afterEach(cleanup);

// The species' action menu comes after the photos' menus on the page.
async function openSpeciesActions() {
  const menus = await screen.findAllByRole("button", { name: "More options" });
  fireEvent.click(menus.at(-1)!);
}

describe("SpeciesDetailPage", () => {
  it("shows the species and says when it has no photos yet", async () => {
    serve(speciesDetail([]));
    renderPage();
    expect(await screen.findByRole("heading", { level: 1, name: "Great Blue Heron" })).toBeTruthy();
    expect(screen.getByText("Ardea herodias")).toBeTruthy();
    expect(screen.getByText("Not photographed yet")).toBeTruthy();
  });

  it("shows the species' photos", async () => {
    serve(
      speciesDetail([
        { width: 600, height: 400 },
        { width: 400, height: 600 },
      ]),
    );
    renderPage();
    await screen.findByRole("heading", { level: 1, name: "Great Blue Heron" });
    // Species photo tiles are decorative (alt=""), so each one is found by its own menu button.
    // One menu per photo, plus the species' own actions.
    expect(screen.getAllByRole("button", { name: "More options" })).toHaveLength(3);
    expect(screen.queryByText("Not photographed yet")).toBeNull();
  });

  it("adds the species to targets and reloads it", async () => {
    serve(speciesDetail([]));
    patch.mockResolvedValue({});
    renderPage();
    await openSpeciesActions();
    fireEvent.click(screen.getByRole("button", { name: "Add to targets" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/species/sp1/target"));
    await waitFor(() => expect(get.mock.calls.filter((c) => c[0] === "/species/sp1")).toHaveLength(2));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("offers to unmark a species already seen", async () => {
    serve(
      speciesDetail([], {
        state: "seen",
        is_target: false,
        cover_photo_id: null,
        card_crop_x: null,
        card_crop_y: null,
        card_crop_size: null,
        best_quality: null,
      }),
    );
    del.mockResolvedValue({});
    renderPage();
    await openSpeciesActions();
    fireEvent.click(screen.getByRole("button", { name: "Mark as unseen" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/species/sp1/seen"));
  });

  it("shows the Collection's region when the link carries none", async () => {
    localStorage.setItem("lifer:lastRegionId", "bc");
    get.mockReturnValue(new Promise(() => {}));
    renderPage();
    await waitFor(() => expect(get).toHaveBeenCalledWith("/species/sp1?regionId=bc", expect.anything()));
    expect(get.mock.calls.some((c) => c[0] === "/species/sp1")).toBe(false);
  });

  it("keeps a region the link names over the Collection's", async () => {
    localStorage.setItem("lifer:lastRegionId", "bc");
    get.mockReturnValue(new Promise(() => {}));
    renderPage("/species/sp1?regionId=on");
    await waitFor(() => expect(get).toHaveBeenCalledWith("/species/sp1?regionId=on", expect.anything()));
    expect(get.mock.calls.some((c) => c[0] === "/species/sp1?regionId=bc")).toBe(false);
  });

  it("goes back to the Collection in its region when opened directly", async () => {
    localStorage.setItem("lifer:lastRegionId", "bc");
    get.mockReturnValue(new Promise(() => {}));
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "← Collection" }));
    expect(await screen.findByText("Collection ?region=bc")).toBeTruthy();
  });
});
