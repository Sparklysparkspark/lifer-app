// The publish gate's decisions over what the catalog queries return. The database, the published
// index download, the anchors file and the report file are stand-ins; the gate's own rules
// (which rows fail, which pass, what drift is accepted) run for real.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexPack, PackIndex } from "./packs.js";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  // Anchor lookups by "region|name".
  anchors: new Map<string, { on_list: boolean; tier: string | null }>(),
  fakeRare: { n: "0", sample: [] as string[] },
  noPhoto: { n: "0" },
  coverage: [] as Array<{ name: string; taxa: string[] }>,
  otherTaxa: [] as string[],
  catalogNames: [] as string[],
}));
// The pipeline's data folder is never read or written here: the anchors file comes from
// `files.anchors`, and a report aimed at the data folder is only recorded.
const files = vi.hoisted(() => ({
  dataDir: "",
  anchors: [] as Array<{ region: string; name: string; tier?: string }>,
  written: new Map<string, string>(),
}));
files.dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const missing = vi.hoisted(() => ({
  add: [] as Array<{ scientificName: string; taxonClass: string; inatObservations: number }>,
}));
const published = vi.hoisted(() => ({ packs: [] as Array<{ id: string; speciesCount: number }> }));

vi.mock("../db.js", () => ({
  pool: {
    query: async (sql: string, params: unknown[] = []): Promise<{ rows: Row[] }> => {
      if (sql.includes("WITH target AS")) {
        const [region, name] = params as [string, string];
        return { rows: [db.anchors.get(`${region}|${name}`) ?? { on_list: false, tier: null }] };
      }
      if (sql.includes("'rare', 'legendary'")) return { rows: [db.fakeRare] };
      if (sql.includes("reference_photo IS NULL")) return { rows: [db.noPhoto] };
      if (sql.includes("array_agg(DISTINCT s.taxon_class)")) return { rows: db.coverage };
      const names = (params[0] ?? []) as string[];
      if (sql.includes("WHERE is_other_taxa AND")) {
        return { rows: db.otherTaxa.filter((n) => names.includes(n)).map((n) => ({ scientific_name: n })) };
      }
      if (sql.includes("WHERE NOT is_other_taxa AND")) {
        return { rows: db.catalogNames.filter((n) => names.includes(n)).map((n) => ({ scientific_name: n })) };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  },
}));
vi.mock("../scripts/add-missing-species.js", () => ({
  findMissingSpecies: async (opts: { offline: boolean }) => {
    // The gate must never go online for this check.
    if (!opts.offline) throw new Error("findMissingSpecies called online");
    return { add: missing.add, synonyms: [], links: [] };
  },
}));
vi.mock("./packs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./packs.js")>()),
  fetchPublishedIndex: async () => ({ generatedAt: "2026-01-01T00:00:00.000Z", packs: published.packs }),
}));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    readFileSync: ((p: string, ...rest: unknown[]) =>
      p === `${files.dataDir}/reference/checklist-anchors.json`
        ? JSON.stringify(files.anchors)
        : (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)) as typeof real.readFileSync,
    mkdirSync: ((p: string, ...rest: unknown[]) =>
      String(p).startsWith(files.dataDir)
        ? undefined
        : (real.mkdirSync as (...a: unknown[]) => unknown)(p, ...rest)) as typeof real.mkdirSync,
    writeFileSync: ((p: string, data: string) =>
      String(p).startsWith(files.dataDir)
        ? void files.written.set(String(p), data)
        : real.writeFileSync(p, data)) as typeof real.writeFileSync,
  };
});

const { runGate, summarizeGate, DRIFT_LIMIT } = await import("./gate.js");
type GateReport = Awaited<ReturnType<typeof runGate>>;

let tmp: string;
let OUT: string;

function pack(id: string, speciesCount: number, extra: Partial<IndexPack> = {}): IndexPack {
  return {
    id,
    type: "region",
    sizeBytes: 1,
    speciesCount,
    contentVersion: "1",
    scientificNames: [],
    url: "u",
    ...extra,
  };
}
function index(...packs: IndexPack[]): PackIndex {
  return { generatedAt: "2026-02-01T00:00:00.000Z", packs };
}
const checks = (report: GateReport) => report.failures.map((f) => f.check);

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "lifer-gate-"));
  OUT = path.join(tmp, "report.json");
  db.anchors.clear();
  db.fakeRare = { n: "0", sample: [] };
  db.noPhoto = { n: "0" };
  db.coverage = [];
  db.otherTaxa = [];
  db.catalogNames = [];
  files.anchors = [];
  files.written.clear();
  missing.add = [];
  published.packs = [];
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("runGate", () => {
  it("passes clean data and writes the report where it was asked to, creating the folders", async () => {
    const out = path.join(tmp, "reports", "2026", "gate.json");
    const report = await runGate({ index: index(pack("kenya-aves", 100)), out });
    expect(report).toMatchObject({ ok: true, failures: [], warnings: [], drift: [] });
    expect(existsSync(out)).toBe(true);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(report);
  });

  it("names the report after the day it ran, in the pipeline's build folder, when no path is given", async () => {
    const report = await runGate({ index: null });
    expect(report.at.slice(0, 10)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect([...files.written.keys()]).toEqual([
      path.join(files.dataDir, "build", `gate-${report.at.slice(0, 10)}.json`),
    ]);
  });

  describe("checklist anchors", () => {
    it("fails when a known species is missing from its region", async () => {
      files.anchors = [{ region: "Kenya", name: "Struthio camelus" }];
      const report = await runGate({ index: null, out: OUT });
      expect(report.ok).toBe(false);
      expect(report.failures).toEqual([{ check: "anchor_missing", detail: "Struthio camelus is not on Kenya's list" }]);
    });

    it("fails when the tier differs from the anchor's, and accepts either of a/b tiers", async () => {
      files.anchors = [
        { region: "Kenya", name: "A a", tier: "common" },
        { region: "Kenya", name: "B b", tier: "rare/legendary" },
        { region: "Kenya", name: "C c", tier: "rare" },
        { region: "Kenya", name: "D d" },
      ];
      db.anchors.set("Kenya|A a", { on_list: true, tier: "common" });
      db.anchors.set("Kenya|B b", { on_list: true, tier: "legendary" });
      db.anchors.set("Kenya|C c", { on_list: true, tier: null });
      db.anchors.set("Kenya|D d", { on_list: true, tier: "rare" });
      const report = await runGate({ index: null, out: OUT });
      expect(report.failures).toEqual([{ check: "anchor_tier", detail: "C c in Kenya is unrated, expected rare" }]);
    });

    it("reports the tier it found when it's the wrong one", async () => {
      files.anchors = [{ region: "Kenya", name: "A a", tier: "rare/legendary" }];
      db.anchors.set("Kenya|A a", { on_list: true, tier: "common" });
      const report = await runGate({ index: null, out: OUT });
      expect(report.failures[0].detail).toBe("A a in Kenya is common, expected rare/legendary");
    });
  });

  it("fails on rare or legendary rows with no records, showing examples", async () => {
    db.fakeRare = { n: "2", sample: ["Kenya: A a", "Peru: B b"] };
    const report = await runGate({ index: null, out: OUT });
    expect(report.failures).toEqual([
      {
        check: "rare_without_records",
        detail:
          "2 rare/legendary rows have no records of any age and no photos behind them (e.g. Kenya: A a; Peru: B b)",
      },
    ]);
  });

  describe("catalog gaps", () => {
    it("fails on missing vertebrates and on anything with 100 or more observations", async () => {
      missing.add = [
        { scientificName: "Bird one", taxonClass: "aves", inatObservations: 0 },
        { scientificName: "Mammal", taxonClass: "mammalia", inatObservations: 0 },
        { scientificName: "Fish", taxonClass: "actinopterygii", inatObservations: 0 },
        { scientificName: "Snake", taxonClass: "squamata", inatObservations: 0 },
        { scientificName: "Turtle", taxonClass: "testudines", inatObservations: 0 },
        { scientificName: "Frog", taxonClass: "amphibia", inatObservations: 0 },
        { scientificName: "Popular crab", taxonClass: "crustacea", inatObservations: 100 },
        { scientificName: "Obscure crab", taxonClass: "crustacea", inatObservations: 99 },
      ];
      const report = await runGate({ index: null, out: OUT });
      expect(report.failures).toEqual([
        {
          check: "catalog_gaps",
          detail:
            "7 species on iNaturalist or eBird lists are missing from the catalog (e.g. Bird one, Mammal, Fish, Snake, Turtle); run the catalog stage",
        },
      ]);
    });

    it("lets a rarely seen invertebrate wait for a later catalog run", async () => {
      missing.add = [{ scientificName: "Obscure crab", taxonClass: "crustacea", inatObservations: 99 }];
      expect((await runGate({ index: null, out: OUT })).ok).toBe(true);
    });
  });

  it("warns, without failing, about listed species with no photo", async () => {
    db.noPhoto = { n: "3" };
    const report = await runGate({ index: null, out: OUT });
    expect(report.ok).toBe(true);
    expect(report.warnings).toEqual([{ check: "no_photo", detail: "3 listed species have no reference photo yet" }]);
  });

  it("skips the pack checks when there's no index", async () => {
    db.coverage = [{ name: "Kenya", taxa: ["aves"] }];
    published.packs = [{ id: "kenya-aves", speciesCount: 100 }];
    expect((await runGate({ index: null, out: OUT })).ok).toBe(true);
  });

  describe("pack coverage", () => {
    it("fails when a country has species in a pack taxon but no pack for it", async () => {
      db.coverage = [{ name: "Costa Rica", taxa: ["aves", "mammalia", "insecta"] }];
      const report = await runGate({ index: index(pack("costa_rica-aves", 10)), out: OUT });
      // insecta isn't a pack taxon, so it isn't expected to have a pack.
      expect(report.failures).toEqual([
        { check: "pack_missing", detail: "Costa Rica has mammalia species but no costa_rica-mammalia pack" },
      ]);
    });

    it("fails when a pack depends on a sea zone pack that isn't in the index", async () => {
      const report = await runGate({
        index: index(pack("kenya-corals", 5, { seaZoneDependencies: ["seazone-indian_ocean-corals"] })),
        out: OUT,
      });
      expect(report.failures).toEqual([
        { check: "index", detail: "kenya-corals depends on seazone-indian_ocean-corals, which isn't in the index" },
      ]);
    });
  });

  describe("Other Taxa in packs", () => {
    it("fails when a personal Other Taxa species is in a pack", async () => {
      db.otherTaxa = ["Mysterius beetleus", "Shared name"];
      db.catalogNames = ["Shared name", "Struthio camelus"];
      const report = await runGate({
        index: index(
          pack("kenya-aves", 5, { scientificNames: ["Mysterius beetleus", "Shared name", "Struthio camelus"] }),
        ),
        out: OUT,
      });
      expect(report.failures).toEqual([
        { check: "other_taxa_in_pack", detail: "1 Other Taxa species are in packs (e.g. Mysterius beetleus)" },
      ]);
    });

    it("shows at most five of the leaked names", async () => {
      db.otherTaxa = ["A", "B", "C", "D", "E", "F"];
      const report = await runGate({ index: index(pack("p", 5, { scientificNames: db.otherTaxa })), out: OUT });
      expect(report.failures[0].detail).toBe("6 Other Taxa species are in packs (e.g. A, B, C, D, E)");
    });

    it("lets an Other Taxa name through when the catalog has a species by that name too", async () => {
      db.otherTaxa = ["Shared name"];
      db.catalogNames = ["Shared name"];
      const report = await runGate({
        index: index(pack("kenya-aves", 5, { scientificNames: ["Shared name"] })),
        out: OUT,
      });
      expect(report.ok).toBe(true);
    });
  });

  describe("species-count drift", () => {
    it(`fails a pack that moved more than ${DRIFT_LIMIT * 100}% from the published count, either way`, async () => {
      published.packs = [
        { id: "up", speciesCount: 100 },
        { id: "down", speciesCount: 100 },
        { id: "edge", speciesCount: 100 },
      ];
      const report = await runGate({ index: index(pack("up", 126), pack("down", 74), pack("edge", 125)), out: OUT });
      expect(report.drift).toEqual([
        { pack: "up", published: 100, now: 126 },
        { pack: "down", published: 100, now: 74 },
      ]);
      expect(report.failures).toEqual([
        { check: "drift", detail: "up: 100 species published, 126 now (26%)" },
        { check: "drift", detail: "down: 100 species published, 74 now (26%)" },
      ]);
    });

    it("ignores new packs and packs published empty", async () => {
      published.packs = [{ id: "empty", speciesCount: 0 }];
      const report = await runGate({ index: index(pack("empty", 50), pack("new", 50)), out: OUT });
      expect(report.drift).toEqual([]);
      expect(report.ok).toBe(true);
    });

    it("accepts drift for the packs named, still listing it", async () => {
      published.packs = [
        { id: "a", speciesCount: 100 },
        { id: "b", speciesCount: 100 },
      ];
      const report = await runGate({ index: index(pack("a", 200), pack("b", 200)), acceptDrift: ["a"], out: OUT });
      expect(report.drift.map((d) => d.pack)).toEqual(["a", "b"]);
      expect(report.failures.map((f) => f.detail)).toEqual(["b: 100 species published, 200 now (100%)"]);
    });

    it("accepts every pack's drift with acceptDrift all", async () => {
      published.packs = [{ id: "kenya-aves", speciesCount: 100 }];
      const report = await runGate({ index: index(pack("kenya-aves", 10)), acceptDrift: "all", out: OUT });
      expect(report.drift).toHaveLength(1);
      expect(report.ok).toBe(true);
    });
  });

  it("collects failures from every check instead of stopping at the first", async () => {
    files.anchors = [{ region: "Kenya", name: "A a" }];
    db.fakeRare = { n: "1", sample: ["Kenya: B b"] };
    missing.add = [{ scientificName: "Bird", taxonClass: "aves", inatObservations: 0 }];
    db.coverage = [{ name: "Kenya", taxa: ["mammalia"] }];
    db.otherTaxa = ["Mine"];
    published.packs = [{ id: "kenya-aves", speciesCount: 10 }];
    const report = await runGate({ index: index(pack("kenya-aves", 100, { scientificNames: ["Mine"] })), out: OUT });
    expect(checks(report)).toEqual([
      "anchor_missing",
      "rare_without_records",
      "catalog_gaps",
      "pack_missing",
      "other_taxa_in_pack",
      "drift",
    ]);
  });
});

describe("summarizeGate", () => {
  const base: GateReport = { at: "2026-02-01T00:00:00.000Z", ok: true, failures: [], warnings: [], drift: [] };

  it("says it passed with the counts", () => {
    expect(summarizeGate(base)).toBe(
      "Gate passed: 0 failure(s), 0 warning(s), 0 pack(s) with a big species-count change.",
    );
  });

  it("groups failures by check, shows at most 8 of each, and lists warnings", () => {
    const failures = [
      ...Array.from({ length: 10 }, (_, i) => ({ check: "drift", detail: `d${i}` })),
      { check: "index", detail: "i0" },
    ];
    const summary = summarizeGate({
      ...base,
      ok: false,
      failures,
      warnings: [{ check: "no_photo", detail: "3 listed species have no reference photo yet" }],
      drift: [{ pack: "a", published: 1, now: 2 }],
    });
    expect(summary.split("\n")).toEqual([
      "Gate FAILED: 11 failure(s), 1 warning(s), 1 pack(s) with a big species-count change.",
      "  drift (10):",
      ...Array.from({ length: 8 }, (_, i) => `    d${i}`),
      "    ...and 2 more",
      "  index (1):",
      "    i0",
      "  warning no_photo: 3 listed species have no reference photo yet",
    ]);
  });

  it("shows exactly 8 without a 'more' line", () => {
    const failures = Array.from({ length: 8 }, (_, i) => ({ check: "drift", detail: `d${i}` }));
    expect(summarizeGate({ ...base, ok: false, failures })).not.toContain("more");
  });
});
