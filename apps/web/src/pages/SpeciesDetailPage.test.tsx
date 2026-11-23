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

  it("adds the species to targets from the header, with an Undo, and reloads it", async () => {
    serve(speciesDetail([]));
    patch.mockResolvedValue({});
    renderPage();
    await screen.findByRole("heading", { level: 1, name: "Great Blue Heron" });
    const target = screen.getByRole("button", { name: "Target" });
    expect(target.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(target);
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/species/sp1/target"));
    await waitFor(() => expect(get.mock.calls.filter((c) => c[0] === "/species/sp1")).toHaveLength(2));
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.show).toHaveBeenCalledWith(
      "Added to your targets",
      expect.objectContaining({ actions: [expect.objectContaining({ label: "Undo" })] }),
    );
  });

  it("keeps the catalog photo one step away once your own photo is the cover", async () => {
    const detail = speciesDetail([{ id: "cap0", photo_id: "ph0", photo_kind: "image" }], {
      state: "collected",
      is_target: false,
      cover_photo_id: "ph0",
      card_crop_x: null,
      card_crop_y: null,
      card_crop_size: null,
      best_quality: null,
    });
    detail.species.reference_photo_url = "/api/species/sp1/reference-photo/display";
    serve(detail);
    renderPage();
    await screen.findByRole("heading", { level: 1, name: "Great Blue Heron" });
    expect(await screen.findByText("1 / 2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next reference photo" })).toBeTruthy();
  });

  it("unmarks a species already seen from its pressed Seen toggle", async () => {
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
    await screen.findByRole("heading", { level: 1, name: "Great Blue Heron" });
    const seen = screen.getByRole("button", { name: "Seen" });
    expect(seen.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(seen);
    await waitFor(() => expect(del).toHaveBeenCalledWith("/species/sp1/seen"));
  });

  it("shows the needs-a-better-photo mark only when set, and clears it with an Undo", async () => {
    const mark = {
      state: "collected" as const,
      is_target: false,
      cover_photo_id: null,
      card_crop_x: null,
      card_crop_y: null,
      card_crop_size: null,
      best_quality: null,
    };
    serve(speciesDetail([], mark));
    renderPage();
    await screen.findByRole("heading", { level: 1, name: "Great Blue Heron" });
    expect(screen.queryByRole("button", { name: "Needs a better photo" })).toBeNull();
    cleanup();

    serve(speciesDetail([], { ...mark, needs_better_photo: true }));
    del.mockResolvedValue({});
    renderPage();
    const chip = await screen.findByRole("button", { name: "Needs a better photo" });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip);
    await waitFor(() => expect(del).toHaveBeenCalledWith("/userdata/v1/species/sp1/needs-better-photo"));
    await waitFor(() =>
      expect(toast.show).toHaveBeenCalledWith(
        'Cleared "Needs a better photo"',
        expect.objectContaining({ actions: [expect.objectContaining({ label: "Undo" })] }),
      ),
    );
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

  describe("opened from a trip", () => {
    // Each photo's caption is its place, named after its capture here.
    const tiles = () => screen.queryAllByTestId("photo-tile").map((tile) => tile.textContent?.match(/cap\d/)?.[0]);
    function renderFromTrip(captures: Partial<SpeciesCapture>[]) {
      localStorage.setItem("lifer:showPhotoLabels", "true");
      serve(speciesDetail(captures.map((c, i) => ({ location_label: `cap${i}`, ...c }))));
      return render(
        <MemoryRouter
          initialEntries={[{ pathname: "/species/sp1", search: "?trip=t1", state: { backLabel: "Yukon" } }]}
        >
          <Routes>
            <Route path="/species/:id" element={<SpeciesDetailPage />} />
          </Routes>
        </MemoryRouter>,
      );
    }

    it("shows the trip's photos first in their own section, then the rest", async () => {
      // Newest first from the server; only the middle one is from the trip.
      renderFromTrip([{ trip_id: null }, { trip_id: "t1" }, { trip_id: "t2" }]);
      const trip = await screen.findByRole("button", { name: "From Yukon (1)" });
      expect(trip.getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByRole("button", { name: "Other photos (2)" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Open trip" })).toBeTruthy();
      expect(tiles()).toEqual(["cap1", "cap0", "cap2"]);

      fireEvent.click(trip);
      expect(trip.getAttribute("aria-expanded")).toBe("false");
      expect(tiles()).toEqual(["cap0", "cap2"]);
    });

    it("is one plain grid when the trip has none of this species' photos", async () => {
      renderFromTrip([{ trip_id: null }, { trip_id: "t2" }]);
      await screen.findByRole("heading", { level: 1, name: "Great Blue Heron" });
      expect(screen.queryByRole("button", { name: /^From / })).toBeNull();
      expect(screen.queryByRole("button", { name: /^Other photos/ })).toBeNull();
      expect(tiles()).toEqual(["cap0", "cap1"]);
    });
  });
});
