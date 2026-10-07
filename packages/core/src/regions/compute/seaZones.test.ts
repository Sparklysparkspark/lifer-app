import { beforeEach, describe, expect, it, vi } from "vitest";

// The GBIF calls are replaced: each species' fake record sample says what the checks should find.
const behaviour = new Map<number, "ok" | "typeOnly" | "inland" | "outlier">();
let inFlight = 0;
let maxInFlight = 0;

vi.mock("../buildRegionSpecies.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../buildRegionSpecies.js")>();
  return {
    ...actual,
    fetchRecordSampleForZone: vi.fn(async (_wkt: string, gbifKey: number) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return [{ gbifKey }];
    }),
    looksTypeSpecimenOnly: (sample: Array<{ gbifKey: number }>) => behaviour.get(sample[0].gbifKey) === "typeOnly",
    looksLikeInlandRecords: async (sample: Array<{ gbifKey: number }>) => behaviour.get(sample[0].gbifKey) === "inland",
    fetchGlobalOccurrenceCount: vi.fn(async (gbifKey: number) => (behaviour.get(gbifKey) === "outlier" ? 10_000 : 3)),
  };
});
vi.mock("../../db.js", () => ({ pool: {}, withTransaction: vi.fn() }));

const { dropSuspiciousRecords } = await import("./seaZones.js");
const { GEOGRAPHIC_OUTLIER_MAX_LOCAL_RECORDS } = await import("../buildRegionSpecies.js");

beforeEach(() => {
  behaviour.clear();
  inFlight = 0;
  maxInFlight = 0;
});

describe("dropSuspiciousRecords", () => {
  it("keeps well-recorded species without checking them, and drops what the checks flag", async () => {
    const many = GEOGRAPHIC_OUTLIER_MAX_LOCAL_RECORDS + 1;
    behaviour.set(2, "typeOnly").set(3, "inland").set(4, "outlier").set(5, "ok");
    const counts = [
      { gbifKey: 1, recordCount: many },
      { gbifKey: 2, recordCount: 1 },
      { gbifKey: 3, recordCount: 1 },
      { gbifKey: 4, recordCount: 1 },
      { gbifKey: 5, recordCount: 1 },
    ];

    const kept = await dropSuspiciousRecords("POLYGON(())", counts, new Set());

    expect(kept.map((c) => c.gbifKey)).toEqual([1, 5]);
  });

  it("checks a well-recorded species when it's high tier with no photo, but never as an outlier", async () => {
    const many = GEOGRAPHIC_OUTLIER_MAX_LOCAL_RECORDS + 1;
    behaviour.set(7, "outlier").set(8, "inland");
    const counts = [
      { gbifKey: 7, recordCount: many },
      { gbifKey: 8, recordCount: many },
    ];

    const kept = await dropSuspiciousRecords("POLYGON(())", counts, new Set([7, 8]));

    expect(kept.map((c) => c.gbifKey)).toEqual([7]);
  });

  it("keeps the input order and never runs more checks at once than allowed", async () => {
    const counts = Array.from({ length: 20 }, (_, i) => ({ gbifKey: 100 + i, recordCount: 1 }));
    for (const c of counts) behaviour.set(c.gbifKey, "ok");

    const kept = await dropSuspiciousRecords("POLYGON(())", counts, new Set(), 3);

    expect(kept.map((c) => c.gbifKey)).toEqual(counts.map((c) => c.gbifKey));
    expect(maxInFlight).toBe(3);
  });
});
