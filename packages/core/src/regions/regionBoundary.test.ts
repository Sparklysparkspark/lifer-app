import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const fetchCached = vi.hoisted(() => vi.fn());
vi.mock("../rawCache.js", () => ({ fetchCached }));

import { fetchAllCountries } from "./regionBoundary.js";

describe("fetchAllCountries", () => {
  it("retries the load after a failed one instead of failing for the rest of the process", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "lifer-ne-")), "admin0.geojson");
    writeFileSync(
      file,
      JSON.stringify({
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: { ADM0_A3: "FRA", NAME: "France", ISO_A2: "FR" }, geometry: null }],
      }),
    );
    fetchCached.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(file);
    await expect(fetchAllCountries()).rejects.toThrow("offline");
    const countries = await fetchAllCountries();
    expect(countries.map((c) => c.iso2)).toEqual(["FR"]);
  });
});
