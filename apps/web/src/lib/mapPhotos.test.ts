import { describe, expect, it } from "vitest";
import {
  MAP_MAX_ZOOM,
  PHOTO_CLUSTERING,
  SAME_POINT_DEGREES,
  clusterTotals,
  mergeSamePoint,
  photoFeatures,
} from "./mapPhotos";

const cell = (count: number) => ({ lat: 49, lon: -123, count, photoId: "p", taxonClass: "aves", iconicTaxon: null });
const region = (id: string, regionOnlyCount: number, lat: number | null = 54) => ({
  id,
  name: id,
  regionOnlyCount,
  lat,
  lon: lat === null ? null : -125,
});

describe("photoFeatures", () => {
  it("draws placed photos as dots and region-only photos as rings, each photo once", () => {
    const features = photoFeatures(
      [cell(12), { ...cell(3), lat: 50 }],
      [region("bc", 5), region("ab", 0), region("nowhere", 2, null)],
    );
    expect(features.map((f) => f.properties.ring)).toEqual([false, false, true]);
    expect(features[2].properties).toMatchObject({ id: "bc", count: 5, placed: 0, regionOnly: 5 });
    const t = clusterTotals(features.map((f) => f.properties));
    // 15 placed and 5 with only a region; a region without a centre has no ring to draw.
    expect(t).toEqual({ total: 20, placed: 15, regionOnly: 5 });
  });

  it("merges a ring with nearby dots into one cluster with the breakdown", () => {
    const [dot, ring] = photoFeatures([cell(12)], [region("bc", 5)]);
    expect(clusterTotals([dot.properties, ring.properties])).toEqual({ total: 17, placed: 12, regionOnly: 5 });
    expect(clusterTotals([ring.properties, ring.properties])).toEqual({ total: 10, placed: 0, regionOnly: 10 });
  });
});

describe("photos at the same point", () => {
  // Screen pixels between two points at the deepest zoom, at the equator (Web Mercator).
  const pxAtMaxZoom = (degrees: number) => (degrees * 256 * 2 ** MAP_MAX_ZOOM) / 360;

  it("is one mark whatever the zoom: clustering runs to the deepest zoom", () => {
    expect(PHOTO_CLUSTERING.clusterMaxZoom).toBe(MAP_MAX_ZOOM);
    expect(PHOTO_CLUSTERING.clusterRadius).toBeGreaterThan(0);
  });

  it("merges cells at identical coordinates into one mark with their count", () => {
    const features = photoFeatures([cell(12), cell(3)], []);
    expect(features).toHaveLength(1);
    expect(features[0].properties).toMatchObject({ count: 15, placed: 15 });
  });

  it("keeps 500 photos at one point as one mark of 500", () => {
    const merged = mergeSamePoint(Array.from({ length: 500 }, () => cell(1)));
    expect(merged).toHaveLength(1);
    expect(merged[0].count).toBe(500);
  });

  it("merges points under 3 px apart at the deepest zoom, even across a bucket edge, and no further", () => {
    expect(pxAtMaxZoom(SAME_POINT_DEGREES)).toBeCloseTo(3, 5);
    const edge = Math.round(49 / SAME_POINT_DEGREES) * SAME_POINT_DEGREES + SAME_POINT_DEGREES / 2;
    const near = [
      { ...cell(4), lat: edge - SAME_POINT_DEGREES / 4 },
      { ...cell(2), lat: edge + SAME_POINT_DEGREES / 4 },
    ];
    expect(mergeSamePoint(near).map((c) => c.count)).toEqual([6]);
    const apart = [cell(4), { ...cell(2), lat: 49 + SAME_POINT_DEGREES * 4 }];
    expect(mergeSamePoint(apart)).toHaveLength(2);
  });
});
