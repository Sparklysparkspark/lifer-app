import { beforeEach, describe, expect, it, vi } from "vitest";

const regionNear = vi.fn();
vi.mock("../regions/regionAt.js", () => ({ regionNear: (...args: unknown[]) => regionNear(...args) }));
const { placeLabel } = await import("./placeLabel.js");

describe("placeLabel", () => {
  beforeEach(() => {
    regionNear.mockReset();
    regionNear.mockResolvedValue({ id: "bz", name: "Belize" });
  });

  it("names the saved place with the region it's filed under", async () => {
    expect(await placeLabel({ label: "Pigeon Lake", region: "Alberta", lat: 1, lon: 2 })).toBe("Pigeon Lake, Alberta");
    expect(await placeLabel({ label: "Pigeon Lake", region: null, lat: 1, lon: 2 })).toBe("Pigeon Lake");
    expect(regionNear).not.toHaveBeenCalled();
  });

  it("falls back to the filed region, then the region near the point", async () => {
    expect(await placeLabel({ label: null, region: "Belize", lat: "17.3", lon: "-87.5" })).toBe("Belize");
    expect(regionNear).not.toHaveBeenCalled();
    expect(await placeLabel({ label: null, region: null, lat: "17.3", lon: "-87.5" })).toBe("Belize");
    expect(regionNear).toHaveBeenCalledWith(17.3, -87.5);
  });

  it("says nothing without a point, or with no region close enough", async () => {
    expect(await placeLabel({ label: null, region: null, lat: null, lon: null })).toBeNull();
    regionNear.mockResolvedValue(null);
    expect(await placeLabel({ label: null, region: null, lat: 0, lon: -30 })).toBeNull();
    regionNear.mockRejectedValue(new Error("offline"));
    expect(await placeLabel({ label: null, region: null, lat: 0, lon: -30 })).toBeNull();
  });
});
