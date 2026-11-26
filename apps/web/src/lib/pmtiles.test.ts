// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("maplibre-gl", () => ({ setWorkerUrl: () => {}, addProtocol: () => {} }));
vi.mock("maplibre-gl/dist/maplibre-gl-worker.mjs?url", () => ({ default: "/worker.js" }));
vi.mock("./pmtilesAvailable", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pmtilesAvailable")>()),
  reliefAvailable: () => false,
  detailMaps: () => ["BEL"],
}));

describe("reliefStyleParts", () => {
  it("keeps small maps quiet: one light, no tint", async () => {
    const { reliefStyleParts } = await import("./mapStyle");
    const quiet = reliefStyleParts("/r.pmtiles");
    expect(quiet.tint).toBeUndefined();
    expect(quiet.hillshade.paint).not.toHaveProperty("hillshade-method");
  });

  it("gives the relief look matching light arrays, and an elevation tint", async () => {
    const { reliefStyleParts } = await import("./mapStyle");
    const strong = reliefStyleParts("/r.pmtiles", true);
    const paint = strong.hillshade.paint as Record<string, unknown[]>;
    expect(paint["hillshade-method"]).toBe("multidirectional");
    const lights = paint["hillshade-illumination-direction"].length;
    expect(lights).toBeGreaterThan(1);
    for (const k of ["hillshade-illumination-altitude", "hillshade-shadow-color", "hillshade-highlight-color"])
      expect(paint[k]).toHaveLength(lights);
    expect(strong.tint).toMatchObject({ type: "color-relief", source: "relief" });
  });
});

describe("pmtilesStyle with a detailed map", () => {
  it("adds the country's archive over the world map, fills above the water and names on top", async () => {
    const { pmtilesStyle } = await import("./pmtiles");
    const style = pmtilesStyle("light");
    expect(style.sources["offline-detail-BEL"]).toMatchObject({
      type: "vector",
      url: `pmtiles://${window.location.origin}/maps/detail/BEL.pmtiles`,
    });
    expect((style.sources["offline-detail-BEL"] as { attribution?: string }).attribution).toMatch(/OpenStreetMap/);
    const ids = style.layers.map((l) => l.id);
    expect(ids.indexOf("offline-detail-BEL-earth")).toBe(ids.indexOf("water") + 1);
    expect(ids.indexOf("offline-detail-BEL-trail")).toBeLessThan(ids.indexOf("boundaries_country"));
    expect(ids.at(-1)).toBe("offline-detail-BEL-label-place");
  });
});
