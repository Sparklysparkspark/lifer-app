// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const useStatsData = vi.fn();
const useStatsDownloads = vi.fn();
vi.mock("./stats/useStatsData", () => ({ useStatsData: (...a: unknown[]) => useStatsData(...a) }));
vi.mock("./stats/useStatsDownloads", () => ({ useStatsDownloads: (...a: unknown[]) => useStatsDownloads(...a) }));
vi.mock("../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useSettings")>()),
  useSettings: () => ({ settings: null }),
}));
vi.mock("../hooks/useScrollMemory", () => ({ useScrollMemory: () => {} }));
// The sections have their own tests; this one is about the page's choices.
const none = () => null;
const get = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a) },
}));
vi.mock("./stats/PhotoSetModal", () => ({
  default: (p: { title: string; photos: Array<{ photoId: string }> }) => (
    <div data-testid="photo-set" data-ids={p.photos.map((x) => x.photoId).join(",")}>
      {p.title}
    </div>
  ),
}));
vi.mock("../components/CollectionStats", () => ({ default: none }));
vi.mock("./stats/StatsHighlights", () => ({ default: none }));
vi.mock("./stats/CollectionIntelligence", () => ({ default: none }));
vi.mock("./stats/StatsCharts", () => ({
  CountriesCard: none,
  ExifChart: (p: { onOpenBucket: (i: number, row: object) => void }) => (
    <button onClick={() => p.onOpenBucket(4, { label: "400-500mm", count: 3, photoIds: ["a", "b"] })}>bar</button>
  ),
  GearChart: none,
  MonthlyChart: none,
  PhotoScatterChart: none,
  TimeOfDayChart: none,
}));

const { default: StatsPage } = await import("./StatsPage");

const stats = {
  totalKeepers: 1,
  insights: [],
  perMonth: [],
  gearUsage: { cameras: [], lenses: [], combos: [] },
  timeOfDay: [],
  exifDistributions: { focalLength: [], iso: [], aperture: [], shutter: [] },
  hitRateByFocalLength: [],
  scatter: [],
  countriesPhotographed: { count: 0, countries: [] },
  ghostSpecies: [],
  lostSpecies: [],
  rediscoveredSpecies: [],
};

function renderPage() {
  return render(
    <MemoryRouter>
      <StatsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  useStatsData.mockReturnValue({ stats, loadError: null, portfolio: null, years: {} });
  useStatsDownloads.mockReturnValue({});
});
afterEach(cleanup);

describe("StatsPage", () => {
  const rawSwitch = () => {
    fireEvent.click(screen.getByRole("button", { name: /^Photos: / }));
    return screen.getByRole("switch", { name: "Include RAW photos" });
  };

  it("counts RAW photos by default from one Photos control, and remembers turning them off", () => {
    renderPage();
    expect(screen.getByRole("button", { name: "Photos: All keepers" })).toBeTruthy();
    const toggle = rawSwitch();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Counting 1 photo, RAW included.")).toBeTruthy();
    expect(useStatsData).toHaveBeenLastCalledWith("all", true);

    fireEvent.click(toggle);
    expect(useStatsData).toHaveBeenLastCalledWith("all", false);
    expect(useStatsDownloads).toHaveBeenLastCalledWith("all", false);
    expect(screen.getByText("Counting 1 photo, edited only.")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "Top rated (5-star)" }));
    expect(useStatsData).toHaveBeenLastCalledWith("topRated", false);

    cleanup();
    renderPage();
    expect(rawSwitch().getAttribute("aria-checked")).toBe("false");
  });

  it("reads unreadable storage as on", () => {
    localStorage.setItem("lifer:stats.includeRaw", "{oops");
    renderPage();
    expect(rawSwitch().getAttribute("aria-checked")).toBe("true");
  });

  it("opens an EXIF bar's photos at once on its sample, then every one of them", async () => {
    get.mockResolvedValue({ photoIds: ["a", "b", "c"] });
    renderPage();
    fireEvent.click(screen.getByText("bar"));
    const set = screen.getByTestId("photo-set");
    expect([set.textContent, set.dataset.ids]).toEqual(["3 photos, 400-500mm", "a,b"]);
    expect(get).toHaveBeenCalledWith(expect.stringMatching(/^\/stats\/exif-bucket\?.*dim=focalLength.*bucket=5/));
    await waitFor(() => expect(screen.getByTestId("photo-set").dataset.ids).toBe("a,b,c"));
  });
});
