import { describe, expect, it } from "vitest";
import { matchSpecies, singular } from "./species";
import { buildGrid, monthAt, monthOf } from "../photos/layout";
import { listPackRegions, packChecklist, parsePackIndex } from "../standalone/packs";
import { distanceKm, formatBytes, nearestSpot, syncLine } from "../format/format";

const sp = (scientificName: string, commonName: string | null, taxonClass: string | null = "aves") => ({
  scientificName,
  commonName,
  taxonClass,
});
const ROWS = [
  sp("Cygnus olor", "Mute Swan"),
  sp("Cygnus columbianus", "Tundra Swan"),
  sp("Anser anser", "Greylag Goose"),
  sp("Anas crecca", "Eurasian Teal"),
  sp("Vulpes vulpes", "Red Fox", "mammalia"),
  sp("Carduelis carduelis", null),
];

describe("offline species search", () => {
  it("finds swans from the plural", () => {
    expect(matchSpecies(ROWS, "swans").map((r) => r.commonName)).toEqual(["Mute Swan", "Tundra Swan"]);
  });
  it("handles geese, partial words, scientific names and accents", () => {
    expect(matchSpecies(ROWS, "geese").map((r) => r.commonName)).toEqual(["Greylag Goose"]);
    expect(matchSpecies(ROWS, "mut sw").map((r) => r.commonName)).toEqual(["Mute Swan"]);
    expect(matchSpecies(ROWS, "carduelis")).toHaveLength(1);
    expect(matchSpecies([sp("Turdus x", "Mistle Thrush")], "mïstle")).toHaveLength(1);
  });
  it("uses group words by taxon class and returns everything for an empty box", () => {
    expect(matchSpecies(ROWS, "mammals").map((r) => r.commonName)).toEqual(["Red Fox"]);
    expect(matchSpecies(ROWS, "  ")).toHaveLength(ROWS.length);
  });
  it("singularises", () => {
    expect([singular("finches"), singular("flies"), singular("grass"), singular("owls")]).toEqual([
      "finch",
      "fly",
      "grass",
      "owl",
    ]);
  });
});

describe("grid layout", () => {
  const photos = [
    { photoId: "a", takenAt: "2026-09-02T00:00:00Z" },
    { photoId: "b", takenAt: "2026-09-01T00:00:00Z" },
    { photoId: "c", takenAt: "2026-09-01T00:00:00Z" },
    { photoId: "d", takenAt: "2026-08-15T00:00:00Z" },
    { photoId: "e", takenAt: null },
  ];
  it("puts a heading before each month and fills rows", () => {
    const g = buildGrid(photos, { width: 200, headingHeight: 40, withHeadings: true }, { columns: 2 });
    expect(g.rows.map((r) => (r.type === "heading" ? r.monthKey : r.ids.join("")))).toEqual([
      "2026-09",
      "ab",
      "c",
      "2026-08",
      "d",
      "undated",
      "e",
    ]);
    expect(g.offsets).toEqual([0, 40, 140, 240, 280, 380, 420]);
    expect(g.months.map((m) => m.row)).toEqual([0, 3, 5]);
  });
  it("has no headings for search results, and maps a scrubber position to a month", () => {
    expect(buildGrid(photos, { width: 300, headingHeight: 40, withHeadings: false }, { columns: 3 }).rows).toHaveLength(
      2,
    );
    const g = buildGrid(photos, { width: 200, headingHeight: 40, withHeadings: true }, { columns: 2 });
    expect(monthAt(g, 0)?.monthKey).toBe("2026-09");
    expect(monthAt(g, 1)?.monthKey).toBe("undated");
    expect(monthOf("garbage")).toBe("undated");
  });
  it("lays out 60,000 photos fast", () => {
    const many = Array.from({ length: 60000 }, (_, i) => ({
      photoId: `p${i}`,
      takenAt: `2025-${String(1 + (i % 12)).padStart(2, "0")}-01`,
    }));
    const t = Date.now();
    expect(
      buildGrid(many, { width: 360, headingHeight: 40, withHeadings: true }, { columns: 4 }).rows.length,
    ).toBeGreaterThan(15000);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe("pack index", () => {
  const index = JSON.stringify({
    generatedAt: "2026-10-08",
    packs: [
      {
        id: "canada-aves",
        type: "region",
        region: "Canada",
        taxon: "aves",
        variant: "full",
        scientificNames: ["Anas crecca", "Cygnus olor"],
      },
      {
        id: "canada-mammalia",
        type: "region",
        region: "Canada",
        taxon: "mammalia",
        scientificNames: ["Vulpes vulpes"],
      },
      {
        id: "canada-aves.small",
        type: "region",
        region: "Canada",
        taxon: "aves",
        variant: "small",
        scientificNames: ["Anas crecca"],
      },
      { id: "seazone-x", type: "seaZone", seaZone: "X", scientificNames: ["Orcinus orca"] },
    ],
  });
  it("lists regions with distinct species and builds a checklist with classes", () => {
    const idx = parsePackIndex(index)!;
    expect(listPackRegions(idx)).toEqual([{ name: "Canada", speciesCount: 3 }]);
    expect(packChecklist(idx, "Canada").map((s) => [s.scientificName, s.taxonClass])).toContainEqual([
      "Vulpes vulpes",
      "mammalia",
    ]);
  });
  it("refuses a truncated or wrong file", () => {
    expect(parsePackIndex("{")).toBeNull();
    expect(parsePackIndex('{"packs":[]}')).toBeNull();
  });
});

describe("format and sync line", () => {
  it("formats sizes", () => {
    expect(formatBytes(1536)).toEqual({ value: "1.5", unit: "KB" });
    expect(formatBytes(1024 ** 3)).toEqual({ value: "1.0", unit: "GB" });
    expect(formatBytes(900)).toEqual({ value: "900", unit: "B" });
  });
  it("finds the nearest saved spot", () => {
    const spots = [
      { lat: 52.5, lon: 1.0, id: "a" },
      { lat: 40, lon: -3, id: "b" },
    ];
    expect(nearestSpot(spots, { lat: 52.6, lon: 1.1 })?.id).toBe("a");
    expect(nearestSpot(spots, { lat: 0, lon: 0 })).toBeNull();
    expect(Math.round(distanceKm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }))).toBe(111);
  });
  it("describes sync calmly", () => {
    const base = {
      syncing: false,
      lastSyncAt: null,
      waiting: 0,
      now: new Date("2026-10-25T10:00:00Z"),
      reachable: true,
      desktop: true,
    };
    expect(syncLine({ ...base, syncing: true }).key).toBe("sync.syncing");
    expect(syncLine(base).key).toBe("sync.never");
    expect(syncLine({ ...base, lastSyncAt: "2026-10-25T09:58:00Z" })).toEqual({ key: "sync.minutes", n: 2 });
    expect(syncLine({ ...base, lastSyncAt: "2026-10-25T06:00:00Z" })).toEqual({ key: "sync.hours", n: 4 });
    expect(syncLine({ ...base, waiting: 12, reachable: false })).toEqual({ key: "sync.waiting", n: 12, where: "home" });
    expect(syncLine({ ...base, lastSyncAt: "2026-10-25T09:59:59Z" }).key).toBe("sync.justNow");
  });
});
