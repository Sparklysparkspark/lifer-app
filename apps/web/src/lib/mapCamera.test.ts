import { describe, expect, it } from "vitest";
import {
  curatedPitch,
  farParts,
  holdableView,
  openingBounds,
  startFraming,
  viewAround,
  markMove,
  anchoredPosition,
  easeOut,
  zoomAnchor,
  framingBounds,
  lonSpan,
  partFraming,
  outsideMask,
  panLimits,
  regionCamera,
  regionFraming,
  zoomFloor,
} from "./mapCamera";

const box = (w: number, s: number, e: number, n: number) => [
  [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
    [w, s],
  ],
];
const multi = (...polys: number[][][][]) => ({
  type: "Feature",
  geometry: { type: "MultiPolygon", coordinates: polys },
});

describe("framingBounds", () => {
  it("frames a single outline by its bounds", () => {
    expect(framingBounds({ type: "Polygon", coordinates: box(-10, 40, 5, 50) })).toEqual([-10, 40, 5, 50]);
  });

  it("keeps Chile's long mainland and drops Easter Island", () => {
    const chile = multi(box(-75, -56, -67, -17), box(-109.5, -27.2, -109.2, -27));
    expect(framingBounds(chile)).toEqual([-75, -56, -67, -17]);
  });

  it("keeps the USA's Alaska (a big share) but not Hawaii (small and far)", () => {
    const usa = multi(box(-125, 25, -67, 49), box(-168, 54, -141, 71), box(-160, 19, -155, 22));
    expect(framingBounds(usa)).toEqual([-168, 25, -67, 71]);
  });

  it("keeps a small island close to the mainland", () => {
    const withIsland = multi(box(0, 40, 10, 50), box(12, 41, 12.5, 41.5));
    expect(framingBounds(withIsland)).toEqual([0, 40, 12.5, 50]);
  });

  it("frames Fiji across the antimeridian as one box", () => {
    const fiji = multi(box(177, -19, 180, -16), box(-180, -17, -178.5, -16));
    expect(framingBounds(fiji)).toEqual([177, -19, 181.5, -16]);
  });

  it("frames Russia from Kaliningrad to Chukotka without spanning the globe", () => {
    const russia = multi(box(27, 41, 180, 82), box(-180, 64, -169, 71), box(19.6, 54.3, 22.9, 55.3));
    expect(framingBounds(russia)).toEqual([19.6, 41, 191, 82]);
  });

  it("returns null for no outline", () => {
    expect(framingBounds(null)).toBeNull();
    expect(framingBounds({ type: "Point", coordinates: [0, 0] })).toBeNull();
  });
});

describe("a hub's framing (a continent or the world)", () => {
  // Canada with its Arctic islands, Belize about 4,000 km south, Kenya, Greenland.
  const canada = multi(box(-141, 41.7, -52.6, 70), box(-125, 70, -61, 83.1));
  const belize = multi(box(-89.2, 15.9, -87.8, 18.5));
  const kenya = multi(box(33.9, -4.7, 41.9, 5));
  const greenland = multi(box(-73, 59.8, -11.4, 83.6));
  const hub = (...countries: Array<ReturnType<typeof multi>>) => ({
    type: "Feature",
    geometry: { type: "MultiPolygon", coordinates: countries.flatMap((c) => c.geometry.coordinates) },
    properties: { countries: countries.map((outline) => ({ outline, code: null })) },
  });
  const frame = (outline: unknown) => {
    const f = regionFraming(outline, "NA")!;
    return { bounds: f.bounds, start: startFraming(outline, f.bounds) };
  };

  it("keeps a small country far from a big one (Belize with Canada)", () => {
    // The joined outline alone would drop Belize as a far-flung bit of Canada.
    expect(framingBounds(hub(canada, belize))).toEqual([-141, 41.7, -52.6, 83.1]);
    expect(frame(hub(canada, belize))).toEqual({
      bounds: [-141, 15.9, -52.6, 83.1],
      start: [-141, 15.9, -52.6, 76],
    });
  });

  it("frames one country exactly as on its own (Canada, Belize)", () => {
    expect(frame(hub(canada))).toEqual({ bounds: [-141, 41.7, -52.6, 83.1], start: [-141, 41.7, -52.6, 76] });
    expect(frame(hub(belize)).start).toEqual([-89.2, 15.9, -87.8, 18.5]);
  });

  it("covers countries on two continents at the world", () => {
    expect(frame(hub(canada, belize, kenya)).bounds).toEqual([-141, -4.7, 41.9, 83.1]);
  });

  it("keeps the far north when a country lies mostly up there (Greenland)", () => {
    expect(frame(hub(canada, greenland)).start).toEqual([-141, 41.7, -11.4, 83.6]);
  });
});

describe("lonSpan", () => {
  it("leaves out the largest gap", () => {
    expect(
      lonSpan([
        [-10, 0],
        [5, 20],
      ]),
    ).toEqual([-10, 20]);
    expect(
      lonSpan([
        [170, 180],
        [-180, -170],
      ]),
    ).toEqual([170, 190]);
  });
});

describe("regionFraming", () => {
  // France's overseas regions and Norway's Svalbard would shrink the mainland to a corner.
  it("uses the hand-tuned framing for France and Norway", () => {
    const france = multi(box(-5, 42, 8, 51), box(-54.6, 2.1, -51.6, 5.8));
    expect(regionFraming(france, "FR")?.bounds).toEqual([-5.2, 41.3, 9.6, 51.1]);
    expect(regionFraming(null, "NO")?.bounds).toEqual([4.5, 57.9, 31.2, 71.2]);
  });

  it("falls back to the rule when the override only names parts", () => {
    const outline = multi(box(-75, -56, -67, -17));
    const chile = regionFraming(outline, "CL");
    expect(chile?.bounds).toEqual([-75, -56, -67, -17]);
    expect(chile?.parts).toEqual([{ name: "Easter Island", bounds: [-109.5, -27.2, -109.2, -27.0] }]);
  });

  it("names the hand-set far parts, which frame on their own", () => {
    const norway = regionFraming(null, "NO");
    expect(norway?.parts.map((p) => p.name)).toEqual(["Svalbard", "Jan Mayen"]);
    expect(partFraming(norway!.parts[0])).toMatchObject({ bounds: [10.5, 76.4, 33.6, 80.9], pitch: 50, parts: [] });
  });

  it("derives far parts from the outline, grouping islands close together", () => {
    const outline = multi(box(0, 40, 10, 50), box(-60, 10, -59, 11), box(-58.5, 10, -58, 10.5), box(100, -10, 101, -9));
    const parts = farParts(outline, [0, 40, 10, 50]);
    expect(parts).toEqual([
      { name: null, bounds: [-60, 10, -58, 11] },
      { name: null, bounds: [100, -10, 101, -9] },
    ]);
    expect(regionFraming(outline)?.parts).toHaveLength(2);
  });

  it("exaggerates terrain more for regions over 1,000 km across", () => {
    expect(regionFraming(multi(box(-75, -56, -67, -17)))?.exaggeration).toBe(1.5);
    expect(regionFraming(multi(box(8, 46, 10, 47)))?.exaggeration).toBe(1.3);
    expect(regionFraming(multi(box(8, 46, 10, 47)))?.pitch).toBe(50);
  });

  it("computes once per outline", () => {
    const outline = multi(box(0, 0, 1, 1));
    expect(regionFraming(outline)).toBe(regionFraming(outline));
  });
});

describe("regionCamera", () => {
  const framing = { bounds: [0, 0, 1, 1] as [number, number, number, number], parts: [], pitch: 50, exaggeration: 1.3 };

  it("is north up and flat unless 3D is on", () => {
    expect(regionCamera(framing, false, false)).toEqual({ bearing: 0, pitch: 0, duration: 900 });
    expect(regionCamera(framing, true, false)).toEqual({ bearing: 0, pitch: 50, duration: 900 });
  });

  it("jumps instead of flying with reduced motion", () => {
    expect(regionCamera(framing, true, true).duration).toBe(0);
  });
});

describe("pan and zoom limits", () => {
  it("holds pan to the framing plus a quarter each way, inside the poles", () => {
    expect(panLimits([0, 0, 40, 20])).toEqual([-10, -5, 50, 25]);
    expect(panLimits([0, 60, 40, 84])[3]).toBe(85);
    expect(panLimits([0, 0, 40, 20], [-30, -2, 70, 22])).toEqual([-30, -5, 70, 25]);
  });

  it("stops zooming out just past the framing", () => {
    expect(zoomFloor(5)).toBe(4.5);
    expect(zoomFloor(0.2)).toBe(0);
  });
});

describe("outsideMask", () => {
  it("cuts each part out of the world, wound opposite to it", () => {
    const mask = outsideMask(multi(box(0, 0, 1, 1), box(5, 5, 6, 6)));
    const rings = mask.geometry.coordinates;
    expect(rings).toHaveLength(3);
    const area = (r: number[][]) => r.slice(0, -1).reduce((a, p, i) => a + p[0] * r[i + 1][1] - r[i + 1][0] * p[1], 0);
    expect(area(rings[0])).toBeGreaterThan(0);
    expect(area(rings[1])).toBeLessThan(0);
    expect(area(rings[2])).toBeLessThan(0);
  });
});

describe("curatedPitch", () => {
  it("tilts to the one angle past zoom 5 in Auto, and holds it down to 4.5", () => {
    expect(curatedPitch(4.8, false, "auto", true)).toBe(0);
    expect(curatedPitch(5.2, false, "auto", true)).toBe(50);
    expect(curatedPitch(4.8, true, "auto", true)).toBe(50);
    expect(curatedPitch(4.4, true, "auto", true)).toBe(0);
  });

  it("stays flat when Flat is picked or there's no relief", () => {
    expect(curatedPitch(8, false, "flat", true)).toBe(0);
    expect(curatedPitch(8, true, "auto", false)).toBe(0);
  });
});

describe("holdableView", () => {
  it("holds a view narrower than the world, and none that wraps it (Canada in a short map)", () => {
    expect(holdableView([-139, 48, -114, 60])).toEqual([-139, 48, -114, 60]);
    expect(holdableView([-359, 33.6, 165.5, 84.2])).toBeNull();
  });
});

describe("markMove", () => {
  it("takes a dot about two levels closer in one eased move, never out and never past the cap", () => {
    expect(markMove({ zoom: 3, reducedMotion: false })).toEqual({ zoom: 5, duration: 750 });
    expect(markMove({ zoom: 11.5, reducedMotion: false })).toEqual({ zoom: 12, duration: 500 });
    expect(markMove({ zoom: 13, reducedMotion: false })).toEqual({ zoom: 13, duration: 500 });
  });

  it("takes a cluster to the zoom where it splits", () => {
    expect(markMove({ zoom: 2, expansionZoom: 6, reducedMotion: false }).zoom).toBe(6);
    expect(markMove({ zoom: 2, expansionZoom: 16, reducedMotion: false }).zoom).toBe(12);
  });

  it("jumps with reduced motion", () => {
    expect(markMove({ zoom: 3, reducedMotion: true }).duration).toBe(0);
  });
});

describe("zoomAnchor", () => {
  // The Collection map's case: 1500 x 320, a cluster low and left of centre, 3 levels in.
  const W = 1500;
  const H = 320;
  const centre: [number, number] = [W / 2, H / 2];
  const cases: Array<[string, [number, number], number]> = [
    ["low and left", [532, 300], 3],
    ["at the top right corner", [1490, 10], 4.5],
    ["near the centre", [760, 150], 2],
  ];
  it.each(cases)("keeps a mark %s on screen and sliding straight to the centre", (_name, from, dz) => {
    const anchor = zoomAnchor(from, centre, dz)!;
    let last = Infinity;
    for (let f = 0; f <= 40; f++) {
      const [x, y] = anchoredPosition(anchor, from, dz, easeOut(f / 40));
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(W);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(H);
      const d = Math.hypot(x - centre[0], y - centre[1]);
      expect(d).toBeLessThanOrEqual(last + 1e-9);
      last = d;
    }
    expect(last).toBeLessThan(1e-6);
  });

  it("is a plain pan when there's hardly any zoom", () => {
    expect(zoomAnchor([100, 100], centre, 0)).toBeNull();
  });
});

describe("openingBounds", () => {
  const canada: [number, number, number, number] = [-141, 41.7, -52.6, 83.1];
  const usa: [number, number, number, number] = [-168.1, 24.5, -67, 71.4];
  it("shows the whole country for one photo in a city", () => {
    expect(openingBounds([[-123.1, 49.3]], [canada])).toEqual(canada);
  });
  it("fits both countries for photos in two", () => {
    expect(
      openingBounds(
        [
          [-123.1, 49.3],
          [-74, 40.7],
        ],
        [canada, usa],
      ),
    ).toEqual([-168.1, 24.5, -52.6, 83.1]);
  });
  it("is the country for photos spread within it", () => {
    expect(
      openingBounds(
        [
          [-123.1, 49.3],
          [-63.6, 44.6],
          [-79.4, 43.7],
        ],
        [canada],
      ),
    ).toEqual(canada);
  });
  it("keeps a country across the antimeridian in one box", () => {
    expect(openingBounds([[177.5, -17.8]], [[174.6, -21.7, 181.8, -12.5]])).toEqual([174.6, -21.7, 181.8, -12.5]);
  });
  it("has nothing to frame without photos or countries", () => {
    expect(openingBounds([], [])).toBeNull();
  });
});

describe("startFraming", () => {
  const box2 = (w: number, s: number, e: number, n: number) => box(w, s, e, n);
  // Canada-like: a mainland to 70°N and Arctic islands to 83°N.
  const canada = multi(box2(-141, 41.7, -52.6, 70), box2(-120, 74, -61, 83.1), box2(-100, 70, -80, 74.5));
  const framing: [number, number, number, number] = [-141, 41.7, -52.6, 83.1];

  it("crops the stretched far north off a country's first view, keeping its south", () => {
    expect(startFraming(canada, framing)).toEqual([-141, 41.7, -52.6, 76]);
  });

  it("keeps a pin up in the cropped band on screen", () => {
    expect(startFraming(canada, framing, [50, 81.2])[3]).toBeCloseTo(82.2);
    expect(startFraming(canada, framing, [82.8])[3]).toBe(83.1);
  });

  it("leaves regions that don't reach the far north, or lie mostly in it, as they are", () => {
    expect(startFraming(multi(box2(-10, 40, 5, 50)), [-10, 40, 5, 50])).toEqual([-10, 40, 5, 50]);
    const greenland = multi(box2(-73, 59.8, -11.4, 83.6));
    expect(startFraming(greenland, [-73, 59.8, -11.4, 83.6])).toEqual([-73, 59.8, -11.4, 83.6]);
  });
});

describe("viewAround", () => {
  it("is the box a map shows around its centre", () => {
    // Zoom 0: the 512 px world; a 256 x 256 map around 0,0 shows half of it each way.
    const [w, s, e, n] = viewAround([0, 0], 0, 256, 256);
    expect([w, e]).toEqual([-90, 90]);
    expect(s).toBeCloseTo(-66.51, 1);
    expect(n).toBeCloseTo(66.51, 1);
  });
});
