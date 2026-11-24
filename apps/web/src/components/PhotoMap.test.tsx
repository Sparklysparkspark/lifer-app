// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

// maplibre-gl needs WebGL, which jsdom lacks: a stand-in that keeps its handlers so a test can click.
const maps: FakeMap[] = [];
// The house Menu measures its panel; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
class FakeMap {
  handlers: Record<string, Array<(e?: unknown) => void>> = {};
  rendered: unknown[] = [];
  // The canvas's own listeners (pointerdown), so a test can start a drag.
  canvasHandlers: Record<string, (e: unknown) => void> = {};
  canvas = {
    style: { cursor: "" },
    addEventListener: (type: string, fn: (e: unknown) => void) => (this.canvasHandlers[type] = fn),
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  moving = false;
  isMoving() {
    return this.moving;
  }
  zoom = 1;
  pitch = 0;
  // Screen position of a point; by default right under the pointer clickMap uses, so a mark in
  // `rendered` is hit. A test can place marks (flat or tilted) to check the nearest one wins.
  // The saved spot's own point stays clear of the photo marks unless a test moves it.
  project = vi.fn(([lon, lat]: [number, number]) =>
    Math.abs((lon + 123.2) % 360) < 1e-6 && lat === 49.1 ? { x: 200, y: 200 } : { x: 1, y: 1 },
  );
  // An 800 x 600 map whose screen points read back as themselves, for the zoom-onto maths.
  getContainer() {
    return {
      clientWidth: 800,
      clientHeight: 600,
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      // The real container, so the map's controls (credits, layers) can mark it for hover reveal.
      classList: (this.options?.container ?? document.createElement("div")).classList,
    };
  }
  unproject([x, y]: [number, number]) {
    return { lng: x, lat: y };
  }
  getMaxBounds() {
    return null;
  }
  touchZoomRotate = { disableRotation: () => {} };
  keyboard = { disableRotation: () => {} };
  sources = new Map<
    string,
    {
      setData: ReturnType<typeof vi.fn>;
      getClusterLeaves?: ReturnType<typeof vi.fn>;
      getClusterExpansionZoom?: ReturnType<typeof vi.fn>;
    }
  >();
  fitBounds = vi.fn();
  flyTo = vi.fn();
  constructor(public options?: { attributionControl?: unknown; container?: HTMLElement }) {
    maps.push(this);
    queueMicrotask(() => this.fire("load"));
  }
  getZoom() {
    return this.zoom;
  }
  getPitch() {
    return this.pitch;
  }
  off() {
    return this;
  }
  on(event: string, a: unknown, b?: unknown) {
    const key = b ? `${event}:${String(a)}` : event;
    (this.handlers[key] ??= []).push((b ?? a) as (e?: unknown) => void);
    return this;
  }
  once(event: string, fn: () => void) {
    return this.on(event, fn);
  }
  fire(event: string, arg?: unknown) {
    for (const fn of this.handlers[event] ?? []) fn(arg);
  }
  // Every source spec, so a test can check that nothing online is asked for.
  sourceSpecs = new Map<string, unknown>();
  addSource(id: string, spec?: unknown) {
    this.sources.set(id, { setData: vi.fn() });
    this.sourceSpecs.set(id, spec);
  }
  getSource(id: string) {
    return this.sources.get(id);
  }
  layers: Array<{ id: string; type: string; filter?: unknown; layout?: Record<string, unknown> }> = [];
  addLayer(layer: { id: string; type: string }) {
    this.layers.push(layer);
  }
  setFeatureState() {}
  jumpTo() {}
  easeTo = vi.fn();
  resize() {}
  // Like MapLibre: a control's element goes into the map's container.
  addControl(control: { onAdd: (map: unknown) => HTMLElement }) {
    this.options?.container?.appendChild(control.onAdd(this));
  }
  getLayer() {
    return true;
  }
  getCenter() {
    return { lat: 10, lng: 20 };
  }
  getBounds() {
    return { contains: () => true };
  }
  // Like MapLibre, only features of the asked-for layers.
  queryRenderedFeatures(_point?: unknown, options?: { layers?: string[] }) {
    return this.rendered.filter(
      (f) => !options?.layers || options.layers.includes((f as { layer: { id: string } }).layer.id),
    );
  }
  getCanvas() {
    return this.canvas;
  }
  remove() {}
}
class FakeMarker {
  setLngLat() {
    return this;
  }
  addTo() {
    return this;
  }
  on() {
    return this;
  }
  remove() {}
}
class FakeBounds {
  empty = true;
  pts: number[][] = [];
  constructor(sw?: number[], ne?: number[]) {
    if (sw && ne) {
      this.empty = false;
      this.pts = [sw, ne];
    }
  }
  extend(p?: number[]) {
    this.empty = false;
    if (p) this.pts.push(p);
  }
  getWest() {
    return Math.min(...this.pts.map((p) => p[0]));
  }
  getEast() {
    return Math.max(...this.pts.map((p) => p[0]));
  }
  getSouth() {
    return Math.min(...this.pts.map((p) => p[1]));
  }
  getNorth() {
    return Math.max(...this.pts.map((p) => p[1]));
  }
  isEmpty() {
    return this.empty;
  }
}
vi.mock("maplibre-gl", () => ({ Map: FakeMap, Marker: FakeMarker, LngLatBounds: FakeBounds }));
vi.mock("maplibre-gl/dist/maplibre-gl.css", () => ({}));
vi.mock("../lib/pmtiles", () => ({
  ensurePmtilesProtocol: () => {},
  pmtilesStyle: () => ({}),
  tiltTerrain: () => () => {},
}));
const env = vi.hoisted(() => ({ basemap: false, relief: false }));
vi.mock("../lib/pmtilesAvailable", () => ({ reliefAvailable: () => env.relief }));
vi.mock("../hooks/useMapAvailable", () => ({ useMapAvailable: () => env.basemap }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ theme: "light" }) }));
const CANADA_OUTLINE = { type: "Feature", geometry: { type: "Polygon", coordinates: [] } };
vi.mock("../lib/countryBoundaries", () => ({
  countryBoundariesResource: {
    use: () => ({ data: [{ id: "c1", name: "Canada", parentId: "na", boundaryGeoJson: CANADA_OUTLINE }] }),
  },
}));
// The region camera drives MapLibre's camera, which the stand-in map doesn't have; its behaviour
// has its own tests (useRegionCamera.test.ts), so here it only records what PhotoMap asks of it.
const camera = vi.hoisted(() => ({
  enter: vi.fn(),
  leave: vi.fn(),
  reset: vi.fn(),
  // The zoom a framed region landed at (null in the world view).
  zoom: null as number | null,
  overshoot: 0,
  onRelease: undefined as undefined | (() => void),
}));
vi.mock("../hooks/useRegionCamera", () => ({
  useRegionCamera: (_map: unknown, opts: { onRelease?: () => void }) => ({
    ...((camera.onRelease = opts.onRelease), {}),
    overshoot: camera.overshoot,
    framing: null,
    enter: camera.enter,
    leave: camera.leave,
    reset: camera.reset,
    framedZoom: () => camera.zoom,
  }),
}));
vi.mock("../lib/mapRegionLayers", () => ({ REGION_MASK_LAYER: "region-view-mask" }));

const get = vi.fn();
const post = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    patch: vi.fn(),
  },
}));
const toast = { show: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() };
vi.mock("../hooks/useToast", () => ({ useToast: () => toast }));

const { default: PhotoMap } = await import("./PhotoMap");
const { zoomAnchor } = await import("../lib/mapCamera");
// The stand-in's unproject reads a screen point back as itself.
const anchorAt = (from: [number, number], dz: number) => {
  const [x, y] = zoomAnchor(from, [400, 300], dz)!;
  return { lng: x, lat: y };
};

const SPOT = {
  id: "s1",
  name: "Reifel pond",
  lat: 49.1,
  lon: -123.2,
  regionId: null,
  regionName: null,
  geoprivacy: "open",
  photoCount: 4,
};
const PROVINCE = { id: "r1", name: "British Columbia", parentId: "c1", kind: "province", lat: 54, lon: -125 };
const BC_OUTLINE = { type: "Feature", geometry: { type: "Polygon", coordinates: [] } };
const NORWAY_OUTLINE = { type: "Feature", geometry: { type: "Polygon", coordinates: [] } };

function serve({ withoutCoordinates = 12, regionOnly = 8 } = {}) {
  get.mockImplementation((path: string) => {
    if (path.startsWith("/gallery/map/unplaced/photos"))
      return Promise.resolve({ captureIds: ["g1", "g2"], photoIds: ["gp1", "gp2"] });
    if (path.startsWith("/gallery/map/unplaced"))
      return Promise.resolve({
        groups: [
          {
            key: "k1",
            tripId: null,
            tripName: null,
            tripCount: 2,
            regionId: "r1",
            regionName: "British Columbia",
            count: 2,
            coverPhotoIds: ["gp1", "gp2"],
            from: "2026-09-14T07:10:00.000Z",
            to: "2026-09-14T08:02:00.000Z",
          },
        ],
        nextCursor: null,
      });
    if (path.startsWith("/gallery/map"))
      return Promise.resolve({
        total: 30,
        withoutCoordinates,
        regionOnly,
        withoutRegion: 0,
        regions: [
          {
            id: "c1",
            name: "Canada",
            parentId: null,
            kind: "country",
            lat: 60,
            lon: -100,
            count: 25,
            ownCount: 0,
            regionOnlyCount: 0,
          },
          { ...PROVINCE, count: 20, ownCount: 20, regionOnlyCount: regionOnly },
          { ...PROVINCE, id: "r2", name: "Alberta", count: 5, ownCount: 5, regionOnlyCount: 0 },
        ],
        cells: [
          { lat: 49, lon: -123, count: 30 - withoutCoordinates, photoId: "p1", taxonClass: "aves", iconicTaxon: null },
        ],
        gridDegrees: 0.001,
        truncated: false,
      });
    if (path === "/saved-spots") return Promise.resolve({ spots: [SPOT] });
    if (path === "/regions")
      return Promise.resolve({
        regions: [
          { id: "na", name: "North America", parentId: null, ebirdRegionCode: null, hasScopedChecklist: false },
          { id: "c1", name: "Canada", parentId: "na", ebirdRegionCode: "CA", hasScopedChecklist: true },
          { id: "r1", name: "British Columbia", parentId: "c1", ebirdRegionCode: "CA-BC", hasScopedChecklist: true },
          { id: "no", name: "Norway", parentId: "eu", ebirdRegionCode: "NO", hasScopedChecklist: true },
        ],
      });
    if (path.startsWith("/regions/boundaries?parentId=c1"))
      return Promise.resolve({ regions: [{ id: "r1", name: "British Columbia", boundaryGeoJson: BC_OUTLINE }] });
    if (path.startsWith("/regions/boundaries?parentId=")) return Promise.resolve({ regions: [] });
    if (path.startsWith("/regions/boundaries?id=no"))
      return Promise.resolve({ regions: [{ id: "no", name: "Norway", boundaryGeoJson: NORWAY_OUTLINE }] });
    if (path.startsWith("/regions/boundaries?id=r1"))
      return Promise.resolve({ regions: [{ id: "r1", name: "British Columbia", boundaryGeoJson: BC_OUTLINE }] });
    if (path.endsWith("/ebird")) return Promise.resolve({ checklists: [] });
    // A cluster's panel list: a placed photo and one with only a region.
    if (path.startsWith("/gallery?") && path.includes("orRegionOnly=") && !/limit=6(&|$)/.test(path))
      return Promise.resolve({
        items: [
          {
            captureId: "c-p",
            photoId: "ph-p",
            kind: "image",
            commonName: "Osprey",
            scientificName: "Pandion haliaetus",
            lat: 49,
            lon: -123,
          },
          {
            captureId: "c-r",
            photoId: "ph-r",
            kind: "image",
            commonName: "Osprey",
            scientificName: "Pandion haliaetus",
            lat: null,
            lon: null,
          },
        ],
        nextCursor: null,
        total: 2,
      });
    // The hover card's sample: the best photos at a mark.
    if (path.startsWith("/gallery?") && /limit=6(&|$)/.test(path))
      return Promise.resolve({
        items: [
          {
            captureId: "c-a",
            photoId: "ph-a",
            kind: "image",
            commonName: "Bald Eagle",
            scientificName: "Haliaeetus leucocephalus",
            takenAt: "2026-04-02T10:00:00Z",
            qualityRating: 5,
            originalRef: "/p/a.jpg",
            rawRef: null,
          },
          {
            captureId: "c-b",
            photoId: "ph-b",
            kind: "image",
            commonName: "Osprey",
            scientificName: "Pandion haliaetus",
            takenAt: "2026-04-03T10:00:00Z",
            qualityRating: 4,
            originalRef: "/p/b.jpg",
            rawRef: null,
          },
        ],
        nextCursor: null,
        total: 18,
      });
    if (path.startsWith("/gallery?") || path.startsWith("/gallery/ids"))
      return Promise.resolve({ items: [], nextCursor: null, total: 3, captureIds: [], locatedCaptureIds: [] });
    return Promise.resolve({ running: false, canUndo: false });
  });
}

afterEach(() => {
  vi.clearAllMocks();
  camera.zoom = null;
  camera.overshoot = 0;
  Object.assign(env, { basemap: false, relief: false });
  vi.useRealTimers();
  maps.length = 0;
});

const seen = { search: "" };
const history = { back: () => {} };
function Where() {
  const { search } = useLocation();
  const navigate = useNavigate();
  useEffect(() => void (seen.search = search), [search]);
  useEffect(() => void (history.back = () => navigate(-1)), [navigate]);
  return null;
}

function renderMap(props: Partial<Parameters<typeof PhotoMap>[0]> = {}, url = "/gallery?view=map") {
  const handlers = {
    onOpenRegion: vi.fn(),
    onOpenArea: vi.fn(),
    onOpenPlace: vi.fn(),
    onShowUnlocated: vi.fn(),
    onPlacingChange: vi.fn(),
    onChanged: vi.fn(),
  };
  render(
    <MemoryRouter initialEntries={[url]}>
      <PhotoMap queryString="taxa=aves" {...handlers} {...props} />
      <Where />
    </MemoryRouter>,
  );
  return handlers;
}

async function spotsShown() {
  await waitFor(() =>
    expect(maps[0]?.sources.get("photo-map-spots")?.setData.mock.lastCall?.[0].features).toHaveLength(1),
  );
}

// A click on the map, on whatever `rendered` says is under the pointer.
async function clickMap(rendered: unknown[] = []) {
  await waitFor(() => expect(maps[0]?.handlers.click).toBeTruthy());
  maps[0].rendered = rendered;
  act(() => maps[0].fire("click", { point: { x: 1, y: 1 }, lngLat: { wrap: () => ({ lat: 48.5, lng: -122.25 }) } }));
}

const POINT_HIT = {
  layer: { id: "photo-map-points" },
  properties: { count: 18, photoId: "p1" },
  geometry: { coordinates: [-123, 49] },
};

describe("PhotoMap", () => {
  it("draws saved spots under every photo mark and its count", async () => {
    serve();
    renderMap();
    await spotsShown();
    const ids = maps[0].layers.map((l) => l.id);
    const spot = ids.indexOf("photo-map-spot-markers");
    expect(spot).toBeGreaterThan(-1);
    for (const id of ids.filter((i) => /clusters|points|bubbles|counts/.test(i)))
      expect(ids.indexOf(id), id).toBeGreaterThan(spot);
  });

  it("counts only photos with coordinates as placed, and opens the Needs placing list", async () => {
    serve();
    const handlers = renderMap();
    expect(await screen.findByText("18 of 30 photos placed.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show photos without a location" }));
    expect(handlers.onShowUnlocated).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "12 need placing" }));
    expect(seen.search).toContain("at=tray");
    expect(await screen.findByText("2 photos, Sep 14, 2026")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Region only/ })).toBeTruthy();
    expect(String(get.mock.calls.find((c) => String(c[0]).startsWith("/gallery/map/unplaced"))?.[0])).toContain(
      "taxa=aves",
    );
  });

  it("says when all or none are placed, and hides the button when nothing needs placing", async () => {
    serve({ withoutCoordinates: 0, regionOnly: 0 });
    renderMap();
    expect(await screen.findByText("All 30 photos placed.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /need placing/ })).toBeNull();
  });

  it("rings only the photos with no coordinates, so a placed photo is never drawn twice", async () => {
    serve();
    renderMap();
    // Rings share the clustered source with the dots, so they merge as you zoom out.
    await waitFor(() =>
      expect(
        maps[0]?.sources
          .get("photo-map-photos")
          ?.setData.mock.lastCall?.[0].features.filter((f: { properties: { ring: boolean } }) => f.properties.ring),
      ).toEqual([
        expect.objectContaining({
          properties: { id: "r1", name: "British Columbia", count: 8, placed: 0, regionOnly: 8, ring: true },
        }),
      ]),
    );
    const dots = maps[0].sources
      .get("photo-map-photos")!
      .setData.mock.lastCall![0].features.filter((f: { properties: { ring: boolean } }) => !f.properties.ring);
    expect(dots.map((f: { properties: { regionOnly: number } }) => f.properties.regionOnly)).toEqual([0]);
    // Every ring and hollow cluster shows its count.
    expect(maps[0].layers.find((l) => l.id === "photo-map-ring-counts")?.layout?.["text-field"]).toBeTruthy();
  });

  it("breaks a mixed cluster down in its card, and lists its rings in the panel with Place these", async () => {
    serve();
    const handlers = renderMap();
    await screen.findByText("18 of 30 photos placed.");
    const cluster = {
      layer: { id: "photo-map-clusters" },
      properties: { cluster_id: 9, total: 26, placed: 18, regionOnly: 8 },
      geometry: { coordinates: [-124, 52] },
    };
    maps[0].sources.get("photo-map-photos")!.getClusterExpansionZoom = vi.fn(async () => 6);
    maps[0].sources.get("photo-map-photos")!.getClusterLeaves = vi.fn(async () => [
      { geometry: { coordinates: [-123, 49] }, properties: { count: 18, photoId: "p1" } },
      { geometry: { coordinates: [-125, 54] }, properties: { count: 8, ring: true, id: "r1" } },
    ]);
    maps[0].rendered = [cluster];
    act(() => maps[0].fire("mousemove", { point: { x: 1, y: 1 } }));
    expect((await screen.findByRole("group", { name: "This area" })).textContent).toContain(
      "18 placed, 8 with no exact location",
    );
    await clickMap([cluster]);
    // One list: the cluster's placed photos and its ring's, the ring's tagged.
    expect(await screen.findByText("No exact location")).toBeTruthy();
    const listed = String(get.mock.calls.find((c) => String(c[0]).includes("orRegionOnly="))?.[0]);
    expect(listed).toContain("orRegionOnly=r1");
    expect(listed).toContain("bbox=");
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Place the ones in British Columbia" }));
    await waitFor(() => expect(handlers.onPlacingChange).toHaveBeenCalled());
    expect(String(get.mock.calls.find((c) => String(c[0]).startsWith("/gallery/ids"))?.[0])).toContain(
      "missingCoordinates=1",
    );
  });

  it("opens a clicked dot's photos beside the map instead of the Gallery", async () => {
    serve();
    const handlers = renderMap();
    await clickMap([POINT_HIT]);
    expect(await screen.findByTestId("map-photo-panel")).toBeTruthy();
    expect(handlers.onOpenArea).not.toHaveBeenCalled();
    expect(seen.search).toContain("at=point");
    await waitFor(() => expect(get.mock.calls.some((c) => String(c[0]).startsWith("/gallery?"))).toBe(true));
    const listed = String(get.mock.calls.find((c) => String(c[0]).startsWith("/gallery?"))![0]);
    expect(listed).toContain("bbox=");
    expect(listed).toContain("sort=ratingHigh");
    fireEvent.click(screen.getByRole("button", { name: "Open in Gallery" }));
    expect(handlers.onOpenArea).toHaveBeenCalledWith("-123.0005,48.9995,-122.9995,49.0005");
  });

  it("previews a dot after a short hover and hides it when the pointer leaves", async () => {
    serve();
    renderMap();
    await waitFor(() => expect(maps[0]?.handlers.mousemove).toBeTruthy());
    vi.useFakeTimers();
    maps[0].rendered = [POINT_HIT];
    act(() => maps[0].fire("mousemove", { point: { x: 1, y: 1 } }));
    expect(screen.queryByTestId("map-hover-preview")).toBeNull();
    expect(maps[0].canvas.style.cursor).toBe("pointer");
    await act(async () => vi.advanceTimersByTime(300));
    expect(screen.getByTestId("map-hover-preview").textContent).toContain("18 photos");
    // The halo marks the dot a click would take.
    expect(maps[0].sources.get("photo-map-hover-halo")?.setData.mock.lastCall?.[0].features).toHaveLength(1);
    maps[0].rendered = [];
    act(() => maps[0].fire("mousemove", { point: { x: 1, y: 1 } }));
    expect(maps[0].canvas.style.cursor).toBe("");
    // A moment to reach the card, then it closes.
    await act(async () => vi.advanceTimersByTime(250));
    expect(screen.queryByTestId("map-hover-preview")).toBeNull();
  });

  it("keeps the card open while the pointer is on it, and opens a photo from it in the viewer", async () => {
    serve();
    renderMap();
    await waitFor(() => expect(maps[0]?.handlers.mousemove).toBeTruthy());
    maps[0].rendered = [POINT_HIT];
    act(() => maps[0].fire("mousemove", { point: { x: 1, y: 1 } }));
    const card = await screen.findByRole("group", { name: "This area" });
    maps[0].rendered = [];
    act(() => maps[0].fire("mousemove", { point: { x: 40, y: 1 } }));
    fireEvent.pointerEnter(card);
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.getByRole("group", { name: "This area" })).toBeTruthy();
    // The best photos, as buttons; the second opens the viewer on it, with the others to step to.
    fireEvent.click(await screen.findByRole("button", { name: "Osprey, Apr 3, 2026" }));
    expect(await screen.findByText("Osprey, Apr 3, 2026", { selector: "p, span, div" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "This area" })).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("folds a saved spot under a cluster: the cluster is picked and its card names the spot", async () => {
    serve();
    renderMap();
    await spotsShown();
    await waitFor(() => expect(maps[0]?.handlers.mousemove).toBeTruthy());
    maps[0].project.mockReturnValue({ x: 1, y: 1 });
    maps[0].sources.get("photo-map-photos")!.getClusterLeaves = vi.fn(async () => [
      { geometry: { coordinates: [-123.2, 49.1] }, properties: { count: 30, photoId: "p1" } },
    ]);
    maps[0].rendered = [
      { layer: { id: "photo-map-spot-markers" }, properties: { id: "s1" }, geometry: { coordinates: [-123.2, 49.1] } },
      {
        layer: { id: "photo-map-clusters" },
        properties: { cluster_id: 7, total: 30, placed: 30, regionOnly: 0 },
        geometry: { coordinates: [-123.2, 49.1] },
      },
    ];
    act(() => maps[0].fire("mousemove", { point: { x: 1, y: 1 } }));
    // The cluster's own count (the spot alone would say 4 photos).
    expect((await screen.findByRole("group", { name: "Reifel pond" })).textContent).toContain("30 photos");
  });

  it("asks for a cluster's best photos once, however often it's hovered", async () => {
    serve();
    renderMap();
    await waitFor(() => expect(maps[0]?.handlers.mousemove).toBeTruthy());
    const cluster = {
      layer: { id: "photo-map-clusters" },
      properties: { cluster_id: 7, total: 30 },
      geometry: { coordinates: [-123, 49] },
    };
    maps[0].sources.get("photo-map-photos")!.getClusterExpansionZoom = vi.fn(async () => 6);
    maps[0].sources.get("photo-map-photos")!.getClusterLeaves = vi.fn(async () => [
      { geometry: { coordinates: [-110, 45] }, properties: { count: 30, photoId: "p1" } },
    ]);
    const samples = () => get.mock.calls.filter((c) => String(c[0]).includes("limit=6")).length;
    for (const _ of [1, 2]) {
      maps[0].rendered = [cluster];
      act(() => maps[0].fire("mousemove", { point: { x: 1, y: 1 } }));
      await screen.findByRole("group", { name: "This area" });
      act(() => maps[0].fire("movestart"));
    }
    expect(samples()).toBe(1);
  });

  it("shows no card or halo while dragging", async () => {
    serve();
    renderMap();
    await waitFor(() => expect(maps[0]?.handlers.mousemove).toBeTruthy());
    maps[0].rendered = [POINT_HIT];
    act(() => maps[0].fire("mousemove", { point: { x: 1, y: 1 }, originalEvent: { buttons: 1 } }));
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByTestId("map-hover-preview")).toBeNull();
    expect(maps[0].canvas.style.cursor).toBe("");
  });

  it("places a group from the tray: the first Place drops a pin, the second places", async () => {
    serve();
    post.mockResolvedValue({ updated: 2, background: false });
    const handlers = renderMap({}, "/gallery?view=map&at=tray");
    fireEvent.click(await screen.findByRole("button", { name: "Place" }));
    fireEvent.click(await screen.findByRole("button", { name: "Place 2 photos here" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/captures/coordinates", { captureIds: ["g1", "g2"], lat: 10, lon: 20 }),
    );
    expect(String(get.mock.calls.find((c) => String(c[0]).includes("unplaced/photos"))?.[0])).toContain("key=k1");
    expect(handlers.onChanged).toHaveBeenCalled();
    const [message, options] = toast.show.mock.calls[0];
    expect(message).toBe("Placed 2 photos");
    post.mockResolvedValue({ restored: 2, canUndo: false });
    options.actions[0].onClick();
    expect(post).toHaveBeenLastCalledWith("/captures/location/undo");
  });

  it("places Gallery-picked photos without a location by default", async () => {
    serve();
    post.mockResolvedValue({ updated: 2, background: false });
    const handlers = renderMap({ placing: { captureIds: ["a", "b", "c"], located: new Set(["a"]) } });
    await clickMap();
    expect(screen.getByText("1 of these already has a location.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Place 2 photos here" }));
    await waitFor(() => expect(handlers.onPlacingChange).toHaveBeenCalledWith(null));
    expect(post).toHaveBeenCalledWith("/captures/coordinates", { captureIds: ["b", "c"], lat: 48.5, lon: -122.25 });
  });

  it("replaces existing locations only when asked", async () => {
    serve();
    post.mockResolvedValue({ updated: 3, background: false });
    renderMap({ placing: { captureIds: ["a", "b", "c"], located: new Set(["a"]) } });
    await clickMap();
    fireEvent.click(screen.getByRole("button", { name: "Replace all" }));
    fireEvent.click(screen.getByRole("button", { name: "Place 3 photos here" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/captures/coordinates", {
        captureIds: ["a", "b", "c"],
        lat: 48.5,
        lon: -122.25,
      }),
    );
  });

  it("files the photos under a saved spot clicked on the map, as the shared location job", async () => {
    serve();
    post.mockResolvedValue({ ok: true });
    renderMap({ placing: { captureIds: ["a"], located: new Set() } });
    await spotsShown();
    // The spot alone under the pointer.
    maps[0].project.mockReturnValue({ x: 1, y: 1 });
    await clickMap([
      { layer: { id: "photo-map-spot-markers" }, properties: { id: "s1" }, geometry: { coordinates: [-123.2, 49.1] } },
    ]);
    expect(screen.getByText("Reifel pond")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Place 1 photo here" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/saved-spots/s1/apply", { captureIds: ["a"] }));
    expect(get.mock.calls.some((c) => c[0] === "/captures/location/status")).toBe(true);
  });

  it("files the photos under a place made from the list's Add row, not just at its point", async () => {
    serve();
    localStorage.setItem("lifer:places-online", '"off"');
    const served = get.getMockImplementation()!;
    get.mockImplementation((path: string, ...rest: unknown[]) =>
      String(path).startsWith("/places/locate")
        ? Promise.resolve({ places: [], nextOffset: null })
        : served(path, ...rest),
    );
    post.mockImplementation(async (url: string, body: { name?: string; lat?: number; lon?: number }) =>
      url === "/saved-spots"
        ? { ...SPOT, id: "new1", name: body.name, lat: body.lat, lon: body.lon, photoCount: 0 }
        : { ok: true },
    );
    renderMap({ placing: { captureIds: ["a"], located: new Set() } });
    await clickMap();
    const field = within(screen.getByTestId("photo-map-placing")).getByRole("combobox");
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "King Fisher Pond" } });
    fireEvent.click(await screen.findByRole("option", { name: "Add “King Fisher Pond” as a new place" }));
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText("Name") as HTMLInputElement).value).toBe("King Fisher Pond");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Place 1 photo here" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/saved-spots/new1/apply", { captureIds: ["a"] }));
    localStorage.removeItem("lifer:places-online");
  });

  it("opens a saved spot's photos in the panel, with Open in Gallery as the way out", async () => {
    serve({ withoutCoordinates: 0, regionOnly: 0 });
    const handlers = renderMap();
    await spotsShown();
    // The spot alone under the pointer.
    maps[0].project.mockReturnValue({ x: 1, y: 1 });
    await clickMap([
      { layer: { id: "photo-map-spot-markers" }, properties: { id: "s1" }, geometry: { coordinates: [-123.2, 49.1] } },
    ]);
    expect(await screen.findByRole("heading", { name: "Reifel pond" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open in Gallery" }));
    expect(handlers.onOpenPlace).toHaveBeenCalledWith("Reifel pond");
  });

  it("undoes the latest location change with Mod+Z on the map", async () => {
    serve();
    post.mockResolvedValue({ restored: 1, canUndo: false });
    renderMap();
    await screen.findByText("18 of 30 photos placed.");
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, metaKey: true });
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(post).toHaveBeenCalledWith("/captures/location/undo"));
  });

  const COUNTRY_HIT = { layer: { id: "photo-map-country-fill" }, properties: { id: "c1" } };
  const RING_HIT = {
    layer: { id: "photo-map-region-bubbles" },
    properties: { id: "r1", count: 8 },
    geometry: { coordinates: [-125, 54] },
  };
  const MASK_HIT = { layer: { id: "region-view-mask" }, properties: {} };

  it("frames a clicked country and still opens its photos beside the map", async () => {
    serve();
    renderMap();
    await screen.findByText("18 of 30 photos placed.");
    await clickMap([COUNTRY_HIT]);
    expect(seen.search).toContain("at=region%3Ac1");
    await waitFor(() => expect(camera.enter).toHaveBeenCalledWith(CANADA_OUTLINE, "CA", null, { still: false }));
    const path = screen.getByRole("navigation", { name: "Map location" });
    expect(path.textContent).toBe("World/Canada");
    fireEvent.click(screen.getByRole("button", { name: "Reset view" }));
    expect(camera.reset).toHaveBeenCalled();
  });

  it("fetches a province's outline for its framing, and the dimmed world goes up a level", async () => {
    serve();
    renderMap({}, "/gallery?view=map&region=c1");
    await screen.findByText("18 of 30 photos placed.");
    await clickMap([{ layer: { id: "photo-map-province-fill" }, properties: { id: "r1", name: "British Columbia" } }]);
    expect(seen.search).toContain("at=region%3Ar1");
    await waitFor(() => expect(camera.enter).toHaveBeenCalledWith(BC_OUTLINE, "CA-BC", null, { still: false }));
    expect(screen.getByRole("navigation", { name: "Map location" }).textContent).toBe("World/Canada/British Columbia");
    // Outside British Columbia: up to Canada, with no new panel.
    await clickMap([MASK_HIT]);
    await waitFor(() => expect(camera.enter).toHaveBeenLastCalledWith(CANADA_OUTLINE, "CA", null, { still: false }));
    expect(seen.search).toContain("at=region%3Ar1");
    // Outside Canada: back to the photos' own view.
    await waitFor(() =>
      expect(screen.getByRole("navigation", { name: "Map location" }).textContent).toBe("World/Canada"),
    );
    await clickMap([MASK_HIT]);
    expect(camera.leave).toHaveBeenCalled();
    expect(screen.queryByRole("navigation", { name: "Map location" })).toBeNull();
  });

  it("ignores the second click of a double-click on the same country", async () => {
    serve();
    renderMap();
    await screen.findByText("18 of 30 photos placed.");
    await clickMap([COUNTRY_HIT]);
    await waitFor(() => expect(camera.enter).toHaveBeenCalledTimes(1));
    await clickMap([COUNTRY_HIT]);
    await new Promise((r) => setTimeout(r, 0));
    expect(camera.enter).toHaveBeenCalledTimes(1);
  });

  it("offers 3D or Flat, 3D (automatic) by default and remembered", async () => {
    Object.assign(env, { basemap: true, relief: true });
    serve();
    renderMap();
    const angle = await screen.findByRole("group", { name: "Map angle" });
    expect(angle.querySelector('[aria-pressed="true"]')?.textContent).toBe("3D");
    fireEvent.click(screen.getByRole("button", { name: "Flat" }));
    expect(localStorage.getItem("lifer:photo-map-tilt")).toBe('"flat"');
  });

  it("asks no online host for tiles until Online detail is turned on", async () => {
    env.basemap = true;
    serve();
    renderMap();
    expect(await screen.findByRole("button", { name: "Map layers" })).toBeTruthy();
    await waitFor(() => expect(maps[0].sources.size).toBeGreaterThan(0));
    expect(JSON.stringify([...maps[0].sourceSpecs.values()])).not.toMatch(/https?:/);
    // MapLibre's own credits are replaced by the shared credits button (MapCredits).
    expect(maps[0].options?.attributionControl).toBe(false);
  });

  it("shows the layers button on hover or focus, like the Collection map", async () => {
    env.basemap = true;
    serve();
    renderMap();
    const button = await screen.findByRole("button", { name: "Map layers" });
    const fading = button.closest(".transition-opacity")!;
    expect(fading.className).toMatch(/pointer-fine:opacity-0/);
    expect(fading.className).toMatch(/group-has-\[:focus-visible\]:opacity-100/);
    expect(button.closest(".group")).toBe(screen.getByTestId("photo-map"));
  });

  it("takes the nearest dot within reach of the pointer, flat or tilted, using the projected spots", async () => {
    serve();
    renderMap();
    await screen.findByText("18 of 30 photos placed.");
    const dot = (lon: number, lat: number) => ({
      layer: { id: "photo-map-points" },
      properties: { count: 1, photoId: `p${lon}` },
      geometry: { coordinates: [lon, lat] },
    });
    // Neither is under the pointer at (1, 1): one 6 px away, one 12 px away.
    const place = (offset: number) =>
      maps[0].project.mockImplementation(([lon]: [number, number]) => ({
        x: 1 + (lon === 10 ? 6 : 12) + offset,
        y: 1,
      }));
    place(0);
    await clickMap([dot(20, 0), dot(10, 0)]);
    expect(seen.search).toContain("at=point%3A9.9995");
    // Tilted, the screen positions move; the pick follows them, not the coordinates.
    maps[0].pitch = 50;
    maps[0].project.mockImplementation(([lon]: [number, number]) => ({ x: lon === 20 ? 4 : 30, y: 1 }));
    await clickMap([dot(20, 0), dot(10, 0)]);
    expect(seen.search).toContain("at=point%3A19.9995");
  });

  it("frames a country picked in the keyboard list, with its photos", async () => {
    serve();
    renderMap({}, "/gallery?view=map");
    fireEvent.click(await screen.findByRole("button", { name: /Canada/ }));
    await waitFor(() => expect(seen.search).toContain("region=c1"));
    expect(seen.search).toContain("at=region");
  });

  it("frames a clicked province of the framed country, with its photos, and Back returns", async () => {
    serve();
    renderMap({}, "/gallery?view=map&region=c1");
    await waitFor(() => expect(camera.enter).toHaveBeenCalledWith(CANADA_OUTLINE, "CA", null, { still: false }));
    await waitFor(() =>
      expect(maps[0].sources.get("photo-map-provinces")?.setData.mock.lastCall?.[0].features).toEqual([
        expect.objectContaining({ properties: { id: "r1", name: "British Columbia" } }),
      ]),
    );
    await clickMap([{ layer: { id: "photo-map-province-fill" }, properties: { id: "r1", name: "British Columbia" } }]);
    expect(seen.search).toContain("region=r1");
    expect(seen.search).toContain("at=region%3Ar1");
    await waitFor(() => expect(camera.enter).toHaveBeenLastCalledWith(BC_OUTLINE, "CA-BC", null, { still: false }));
    act(() => history.back());
    await waitFor(() => expect(seen.search).toContain("region=c1"));
    await waitFor(() => expect(camera.enter).toHaveBeenLastCalledWith(CANADA_OUTLINE, "CA", null, { still: false }));
  });

  it("offers a region's far parts, framing one on its own, and Reset view goes back", async () => {
    serve();
    renderMap({}, "/gallery?view=map&region=no");
    await waitFor(() => expect(camera.enter).toHaveBeenCalledWith(NORWAY_OUTLINE, "NO", null, { still: false }));
    fireEvent.click(await screen.findByRole("button", { name: "Also in Norway" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Svalbard" }));
    await waitFor(() => expect(camera.enter).toHaveBeenLastCalledWith(NORWAY_OUTLINE, "NO", 0, { still: false }));
    expect(screen.getByRole("navigation", { name: "Map location" }).textContent).toBe("World/Norway/Svalbard");
    fireEvent.click(screen.getByRole("button", { name: "Reset view" }));
    await waitFor(() => expect(camera.enter).toHaveBeenLastCalledWith(NORWAY_OUTLINE, "NO", null, { still: false }));
    expect(seen.search).not.toContain("part=");
  });

  it("never takes the end of a drag, or a click while the camera moves, as a click", async () => {
    serve();
    const handlers = renderMap();
    await screen.findByText("18 of 30 photos placed.");
    // Pressed 30 px away from where it was let go.
    act(() => maps[0].canvasHandlers.pointerdown({ clientX: 31, clientY: 1, pointerType: "mouse" }));
    await clickMap([POINT_HIT]);
    expect(seen.search).not.toContain("at=");
    maps[0].moving = true;
    act(() => maps[0].canvasHandlers.pointerdown({ clientX: 1, clientY: 1, pointerType: "mouse" }));
    await clickMap([POINT_HIT]);
    expect(seen.search).not.toContain("at=");
    // A real click still opens the dot.
    maps[0].moving = false;
    await clickMap([POINT_HIT]);
    expect(seen.search).toContain("at=point");
    expect(handlers.onOpenArea).not.toHaveBeenCalled();
  });

  it("keeps the region level when zoomed in past the framing; near it a province click still enters", async () => {
    serve();
    camera.zoom = 3;
    renderMap({}, "/gallery?view=map&region=c1");
    await waitFor(() => expect(camera.enter).toHaveBeenCalledWith(CANADA_OUTLINE, "CA", null, { still: false }));
    const province = { layer: { id: "photo-map-province-fill" }, properties: { id: "r1", name: "British Columbia" } };
    maps[0].zoom = 5;
    await clickMap([province]);
    expect(seen.search).not.toContain("region=r1");
    await clickMap([{ layer: { id: "region-view-mask" }, properties: {} }]);
    expect(seen.search).toContain("region=c1");
    // The breadcrumb and Reset view still work when zoomed in.
    fireEvent.click(screen.getByRole("button", { name: "Reset view" }));
    expect(camera.reset).toHaveBeenCalled();
    maps[0].zoom = 3.5;
    await clickMap([province]);
    expect(seen.search).toContain("region=r1");
    fireEvent.click(screen.getByRole("button", { name: "World" }));
    expect(seen.search).not.toContain("region=");
  });

  it("zooming out past a province lets go to its country in place, then to the world", async () => {
    serve();
    camera.overshoot = 0.5;
    renderMap({}, "/gallery?view=map&region=r1");
    await waitFor(() => expect(camera.enter).toHaveBeenCalledWith(BC_OUTLINE, "CA-BC", null, { still: false }));
    expect(screen.getByRole("status").textContent).toBe("Keep zooming out to leave British Columbia");
    act(() => camera.onRelease!());
    await waitFor(() => expect(camera.enter).toHaveBeenLastCalledWith(CANADA_OUTLINE, "CA", null, { still: true }));
    expect(seen.search).toContain("region=c1");
    act(() => camera.onRelease!());
    await waitFor(() => expect(camera.leave).toHaveBeenCalled());
    expect(seen.search).not.toContain("region=");
    // Replaced, not pushed: Back leaves the map's entry rather than stepping into Canada.
    act(() => history.back());
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.search).not.toContain("region=c1");
  });

  it("moves onto a clicked dot in one eased move, two levels in, without framing a region", async () => {
    serve();
    renderMap();
    await screen.findByText("18 of 30 photos placed.");
    maps[0].zoom = 1;
    await clickMap([POINT_HIT]);
    // After the panel's resize, one move onto the dot.
    act(() => maps[0].fire("resize"));
    await waitFor(() => expect(maps[0].easeTo).toHaveBeenCalledTimes(1));
    expect(maps[0].easeTo).toHaveBeenCalledWith(
      // Zoomed around the point that slides the dot (at 1, 1 here) straight to the centre.
      expect.objectContaining({ around: anchorAt([1, 1], 2), zoom: 3, duration: 750 }),
    );
    expect(camera.enter).not.toHaveBeenCalled();
    expect(seen.search).not.toContain("region=");
  });

  it("takes a cluster to where it splits, and a ring to its centre, never into a region", async () => {
    serve();
    renderMap();
    await screen.findByText("18 of 30 photos placed.");
    const source = maps[0].sources.get("photo-map-photos")!;
    source.getClusterExpansionZoom = vi.fn(async () => 6);
    source.getClusterLeaves = vi.fn(async () => [{ geometry: { coordinates: [-110, 45] }, properties: { count: 3 } }]);
    await clickMap([
      {
        layer: { id: "photo-map-clusters" },
        properties: { cluster_id: 4, total: 3, placed: 3 },
        geometry: { coordinates: [-110, 45] },
      },
    ]);
    await act(async () => {});
    act(() => maps[0].fire("resize"));
    await waitFor(() =>
      expect(maps[0].easeTo).toHaveBeenCalledWith(expect.objectContaining({ around: anchorAt([1, 1], 5), zoom: 6 })),
    );
    maps[0].easeTo.mockClear();
    await clickMap([RING_HIT]);
    expect(seen.search).toContain("at=ring%3Ar1");
    expect(maps[0].easeTo).toHaveBeenCalledTimes(1);
    expect(maps[0].easeTo).toHaveBeenCalledWith(expect.objectContaining({ around: expect.anything() }));
    expect(camera.enter).not.toHaveBeenCalled();
  });

  it("jumps onto a clicked dot with reduced motion", async () => {
    window.matchMedia = vi.fn(
      () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList,
    );
    serve();
    renderMap();
    await screen.findByText("18 of 30 photos placed.");
    await clickMap([POINT_HIT]);
    act(() => maps[0].fire("resize"));
    await waitFor(() => expect(maps[0].easeTo).toHaveBeenCalledWith(expect.objectContaining({ duration: 0 })));
  });

  it("moves onto a dot only after the panel's resize, so the resize can't throw the move off", async () => {
    serve();
    renderMap();
    await screen.findByText("18 of 30 photos placed.");
    await clickMap([POINT_HIT]);
    expect(maps[0].easeTo).not.toHaveBeenCalled();
    act(() => maps[0].fire("resize"));
    expect(maps[0].easeTo).toHaveBeenCalledTimes(1);
  });
});
