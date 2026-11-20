import { describe, expect, it } from "vitest";
import type { RegionSummary } from "@lifer/shared";
import { countriesInHub, countriesInView, joinBoundaries } from "./useHubBoundary";

const poly = (n: number) => ({ type: "Feature" as const, geometry: { type: "Polygon", coordinates: [[[n, n]]] } });
const multi = { type: "Feature" as const, geometry: { type: "MultiPolygon", coordinates: [[[[9, 9]]], [[[8, 8]]]] } };

describe("joinBoundaries", () => {
  it("joins polygons and multipolygons into one multipolygon", () => {
    expect(joinBoundaries([poly(1), multi])).toEqual({
      type: "Feature",
      geometry: { type: "MultiPolygon", coordinates: [[[[1, 1]]], [[[9, 9]]], [[[8, 8]]]] },
    });
  });
  it("is null with nothing to draw", () => {
    expect(joinBoundaries([])).toBeNull();
  });
});

describe("countriesInHub", () => {
  const country = (id: string, name: string, parentId: string) => ({ id, name, parentId }) as unknown as RegionSummary;
  const canada = country("ca", "Canada", "na");
  const belize = country("bz", "Belize", "na");
  const costaRica = country("cr", "Costa Rica", "na");
  const kenya = country("ke", "Kenya", "af");

  it("outlines a continent's own countries, Central America's included", () => {
    expect(countriesInHub([canada, belize, costaRica, kenya], "na", "world").map((c) => c.name)).toEqual([
      "Canada",
      "Belize",
      "Costa Rica",
    ]);
    expect(countriesInHub([canada, kenya], "world", "world")).toHaveLength(2);
  });
});

describe("countriesInView", () => {
  const country = (id: string, name: string, parentId: string) => ({ id, name, parentId }) as unknown as RegionSummary;
  const canada = country("ca", "Canada", "na");
  const us = country("us", "United States", "na");
  const kenya = country("ke", "Kenya", "af");
  const all = [canada, kenya, us];

  it("takes every downloaded country on All species and the world", () => {
    expect(countriesInView(null, false, "world", all, null)).toEqual(all);
    expect(countriesInView("world", true, "world", all, null)).toHaveLength(3);
  });
  it("takes a continent's downloaded countries only", () => {
    expect(countriesInView("na", true, "world", all, null).map((c) => c.name)).toEqual(["Canada", "United States"]);
  });
  it("takes a country or province's own country", () => {
    const bc = { id: "ca", name: "Canada" };
    expect(countriesInView("bc", false, "world", all, bc)).toEqual([bc]);
    expect(countriesInView("bc", false, "world", all, null)).toEqual([]);
  });
});
