import { describe, expect, it } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import { activeCredits, alsoUsedCredits } from "./mapCredits";

// Just the style and zoom the credits read.
function map(layers: object[], zoom = 5, sources: Record<string, unknown> = {}) {
  return { getZoom: () => zoom, getStyle: () => ({ layers, sources }) } as unknown as MapLibreMap;
}
const keys = (m: MapLibreMap, o = {}) => activeCredits(m, o).map((c) => c.key);
const bundled = [
  { id: "earth", source: "protomaps" },
  { id: "relief-hillshade", source: "relief" },
];
const detail = { id: "detail-road", source: "online-detail", minzoom: 10 };
const satellite = { id: "satellite-imagery", source: "online-satellite" };
const labels = { id: "satellite-label-place", source: "online-detail" };
const EOX = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg";

describe("activeCredits", () => {
  it("credits the offline map, with the relief's source notices in full near the top", () => {
    const credits = activeCredits(map(bundled));
    expect(credits.map((c) => c.key)).toEqual(["terrain", "osm", "protomaps"]);
    expect(credits[0].lines).toContain("Norway terrain data © Kartverket.");
    expect(credits[0].lines?.some((l) => l.includes("Crown copyright"))).toBe(true);
    expect(credits.find((c) => c.key === "protomaps")?.text).toMatch(/Natural Earth/);
  });

  it("adds OpenFreeMap only once its detail shows", () => {
    expect(keys(map([...bundled, detail], 8))).not.toContain("openfreemap");
    expect(keys(map([...bundled, detail], 12))).toContain("openfreemap");
  });

  it("credits Mapterhorn only while its sharper relief shows, linking its sources page", () => {
    const relief = { id: "online-relief-hillshade", source: "online-relief", minzoom: 6 };
    const handedOver = [{ id: "earth", source: "protomaps" }, { ...bundled[1], maxzoom: 6 }, relief];
    expect(keys(map(handedOver, 5))).not.toContain("mapterhorn");
    const credits = activeCredits(map(handedOver, 9));
    expect(credits.map((c) => c.key)).toEqual(["mapterhorn", "osm", "protomaps"]);
    expect(credits[0].href).toBe("https://mapterhorn.com/attribution");
  });

  it("puts EOX's own full sentence first under satellite, and drops the covered offline map", () => {
    const credits = activeCredits(map([...bundled, satellite, labels], 5, { "online-satellite": { tiles: [EOX] } }));
    expect(credits[0]).toMatchObject({
      key: "eox",
      text: "EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2025)",
      licence: { name: "CC BY-NC-SA 4.0" },
    });
    expect(credits.map((c) => c.key)).toEqual(["eox", "osm", "openfreemap"]);
  });

  it("names a user's own imagery provider by its host", () => {
    const own = "https://api.example.com/sat/{z}/{x}/{y}.jpg?key=k";
    expect(activeCredits(map([satellite], 5, { "online-satellite": { tiles: [own] } }))[0].name).toBe(
      "api.example.com",
    );
  });

  it("credits OpenStreetMap for a downloaded detailed map on its own", () => {
    expect(keys(map([{ id: "offline-detail-BEL-earth", source: "offline-detail-BEL" }], 12))).toEqual([
      "osm",
      "protomaps",
    ]);
  });

  it("lists Photon on a map with place search", () => {
    expect(keys(map(bundled), { placeSearch: true }).at(-1)).toBe("photon");
  });
});

describe("alsoUsedCredits", () => {
  it("lists every other source once, so all licences stay one click away", () => {
    const also = alsoUsedCredits(activeCredits(map(bundled))).map((c) => c.key);
    expect(also).toEqual(["mapterhorn", "openfreemap", "eox"]);
  });
});
