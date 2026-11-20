// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("maplibre-gl", () => ({ setWorkerUrl: () => {}, addProtocol: () => {} }));
vi.mock("maplibre-gl/dist/maplibre-gl-worker.mjs?url", () => ({ default: "/worker.js" }));
vi.mock("./pmtilesAvailable", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pmtilesAvailable")>()),
  reliefAvailable: () => false,
  detailMaps: () => ["BEL"],
}));

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
