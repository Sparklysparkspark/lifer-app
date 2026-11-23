import { describe, expect, it } from "vitest";
import { areaOutlineFeatures } from "./mapAreaOutlines";

const shape = (n: number) => ({ geometry: { type: "Polygon", coordinates: [[[n, 0]]] } });

describe("areaOutlineFeatures", () => {
  it("tags each outline with the pill it opens and leaves out what no pill lists", () => {
    // A group holding one province opens the province; a group without an outline stands in for
    // its provinces; a hidden area and an area without a boundary draw nothing.
    const target = (id: string) => (id === "group-one" ? "province-one" : id);
    const areas = [
      { id: "state", name: "State" },
      { id: "province-one", name: "Group One" },
      { id: "no-outline-group", name: "Outlineless" },
      { id: "missing", name: "Missing" },
    ];
    const boundaries = [
      { id: "state", parentId: "country", boundaryGeoJson: shape(1) },
      { id: "group-one", parentId: "country", boundaryGeoJson: shape(2) },
      { id: "p1", parentId: "no-outline-group", boundaryGeoJson: shape(3) },
      { id: "p2", parentId: "no-outline-group", boundaryGeoJson: shape(4) },
      { id: "hidden", parentId: "country", boundaryGeoJson: shape(5) },
      { id: "missing", parentId: "country", boundaryGeoJson: null },
    ];
    const { features } = areaOutlineFeatures(boundaries, "country", areas, target);
    expect(features.map((f) => [f.properties.area, f.properties.name])).toEqual([
      ["state", "State"],
      ["province-one", "Group One"],
      ["no-outline-group", "Outlineless"],
      ["no-outline-group", "Outlineless"],
    ]);
    expect(features[0].geometry).toBe(boundaries[0].boundaryGeoJson!.geometry);
  });
});
