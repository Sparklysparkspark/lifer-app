// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// WebGL isn't in jsdom.
// Every map call is a no-op stand-in; the header and list are what's tested.
const stub = (): unknown => new Proxy(function () {}, { get: () => stub(), apply: () => stub() });
vi.mock("maplibre-gl", () => ({
  Map: vi.fn(function () {
    return stub();
  }),
  LngLatBounds: vi.fn(function () {
    return stub();
  }),
  Popup: vi.fn(function () {
    return stub();
  }),
}));
vi.mock("maplibre-gl/dist/maplibre-gl.css", () => ({}));
vi.mock("../hooks/useMapAvailable", () => ({ useMapAvailable: () => true }));
vi.mock("../lib/pmtiles", () => ({ ensurePmtilesProtocol: vi.fn(), pmtilesStyle: vi.fn(() => ({})) }));
vi.mock("./map/MapCredits", () => ({ addMapCredits: vi.fn() }));
vi.mock("../lib/mapRegionLayers", () => ({ showRegionOutline: vi.fn() }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ theme: "light" }) }));

const { default: SpeciesHotspotMap } = await import("./SpeciesHotspotMap");

const spot = (lat: number, lastSeenYear: number) => ({
  centroidLat: lat,
  centroidLon: -123.1,
  recordShare: 0.5,
  pointCount: 10,
  bboxDiagonalKm: 2,
  lastSeenYear,
  distinctYears: 1,
  isReliable: false,
  isSensitive: false,
});

describe("SpeciesHotspotMap", () => {
  it("counts the locations a filter leaves, out of all of them", () => {
    const hotspots = [spot(49.28, 2020), spot(50.5, 2021)];
    render(
      <SpeciesHotspotMap
        boundaryGeoJson={{ type: "Feature" }}
        hotspots={hotspots as never}
        scientificName="Ardea herodias"
      />,
    );
    expect(screen.getByText("(2 locations, last seen 2021)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Locality map/ }));
    fireEvent.change(screen.getByPlaceholderText(/Filter by coordinates/), { target: { value: "49.28" } });
    expect(screen.getByText("(1 of 2 locations)")).toBeTruthy();
  });
});
