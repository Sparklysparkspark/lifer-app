// The packs stage's decisions: which built packs count as changed, which index entries are kept,
// and how the published index is read. The database, the pack builders, the pack store and the
// published index are stand-ins; archives are real tar.gz files so content versions are read for real.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexPack, PackIndex } from "./packIndex.js";

const state = vi.hoisted(() => ({
  zones: [] as Array<{ id: string; name: string; taxa: string[] }>,
  countries: [] as Array<{ id: string; name: string }>,
  taxa: new Map<string, string[]>(),
  // What each pack builds to now: content version, or an error.
  versions: new Map<string, string | Error>(),
  published: { generatedAt: "", packs: [] } as PackIndex,
  fetchResponse: null as Response | null,
}));

vi.mock("../db.js", () => ({
  pool: {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes("FROM sea_zones z")) return { rows: state.zones };
      if (sql.includes("JOIN regions cont")) return { rows: state.countries };
      if (sql.includes("SELECT DISTINCT s.taxon_class"))
        return { rows: (state.taxa.get(params[0] as string) ?? []).map((t) => ({ taxon_class: t })) };
      throw new Error(`unexpected query: ${sql}`);
    },
  },
}));
vi.mock("./photoLicensePolicy.js", () => ({ assertPhotosPublishable: async () => {} }));
vi.mock("./packStore.js", () => ({
  PACK_SHARD_PREFIX: "lifer-packs-",
  writePackStore: () => [],
  publishPackStore: async () => {},
}));
vi.mock("@lifer/core/lib/http.js", () => ({
  httpFetch: async () => {
    if (!state.fetchResponse) throw new Error("no response set");
    return state.fetchResponse;
  },
}));
function writeArchive(outDir: string, id: string) {
  const v = state.versions.get(id);
  if (v instanceof Error) throw v;
  const stage = mkdtempSync(path.join(os.tmpdir(), "lifer-packs-stage-"));
  try {
    writeFileSync(path.join(stage, "manifest.json"), JSON.stringify({ contentVersion: v ?? "new" }));
    tar.create({ gzip: true, file: path.join(outDir, `${id}.pack.tar.gz`), cwd: stage, sync: true }, ["manifest.json"]);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  return { fileName: `${id}.pack.tar.gz` };
}
vi.mock("../build/build-region-pack.js", () => ({
  buildSeaZonePack: async (zone: string, outDir: string, taxon: string | null) =>
    writeArchive(outDir, `seazone-${zone}${taxon ? `-${taxon}` : ""}`),
  buildRegionPack: async (country: string, outDir: string, taxon: string) =>
    writeArchive(outDir, `${country}-${taxon}`),
}));
// build-pack-index.ts runs as a child process; here it indexes the folder the same way, in process.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: (_cmd: string, args: string[]) => {
    const outDir = args.at(-1)!;
    const built = readdirSync(outDir).filter((f) => f.endsWith(".pack.tar.gz"));
    const ids = new Set(built.map((f) => f.replace(/\.pack\.tar\.gz$/, "")));
    const index: PackIndex = {
      generatedAt: "now",
      packs: [...state.published.packs.filter((p) => !ids.has(p.id)), ...[...ids].map((id) => entry(id, "x"))],
    };
    writeFileSync(path.join(outDir, "pack-index.json"), JSON.stringify(index));
  },
}));

const { buildPacks, checkIndex, fetchPublishedIndex } = await import("./packs.js");

function entry(id: string, contentVersion: string, extra: Partial<IndexPack> = {}): IndexPack {
  const seaZone = id.startsWith("seazone-");
  return {
    id,
    type: seaZone ? "seaZone" : "region",
    region: seaZone ? undefined : id.split("-")[0],
    sizeBytes: 1,
    speciesCount: 1,
    contentVersion,
    scientificNames: [],
    url: "lifer-packs-1.bin",
    range: [0, 1],
    format: 3,
    ...extra,
  };
}

let outDir: string;
beforeEach(() => {
  outDir = mkdtempSync(path.join(os.tmpdir(), "lifer-packs-test-"));
  state.zones = [];
  state.countries = [];
  state.taxa = new Map();
  state.versions = new Map();
  state.published = { generatedAt: "", packs: [] };
  state.fetchResponse = null;
});
afterEach(() => rmSync(outDir, { recursive: true, force: true }));

function publish(...packs: IndexPack[]) {
  state.published = { generatedAt: "2026-01-01T00:00:00.000Z", packs };
  state.fetchResponse = new Response(JSON.stringify(state.published), { status: 200 });
}

describe("buildPacks", () => {
  it("keeps only packs whose content changed, and drops packs in scope that lost every species", async () => {
    state.countries = [{ id: "k", name: "kenya" }];
    state.taxa.set("k", ["aves", "mammalia"]);
    state.versions.set("kenya-aves", "same");
    state.versions.set("kenya-mammalia", "changed");
    publish(
      entry("kenya-aves", "same"),
      entry("kenya-mammalia", "old"),
      entry("kenya-amphibia", "old"),
      entry("peru-aves", "p"),
    );

    const result = await buildPacks({ countries: ["kenya"], outDir, log: () => {} });
    expect(result).toMatchObject({ built: 2, unchanged: 1, changed: ["kenya-mammalia.pack.tar.gz"], failures: [] });
    expect(readdirSync(outDir).filter((f) => f.endsWith(".pack.tar.gz"))).toEqual(["kenya-mammalia.pack.tar.gz"]);
    // kenya-amphibia had no species this run; peru is outside --countries, so it stays.
    expect(result.index!.packs.map((p) => p.id).sort()).toEqual(["kenya-aves", "kenya-mammalia", "peru-aves"]);
  });

  it("keeps every published pack when a build failed, since a failure proves nothing", async () => {
    state.countries = [{ id: "k", name: "kenya" }];
    state.taxa.set("k", ["aves", "mammalia"]);
    state.versions.set("kenya-aves", "changed");
    state.versions.set("kenya-mammalia", new Error("disk full"));
    publish(entry("kenya-aves", "old"), entry("kenya-mammalia", "old"), entry("kenya-amphibia", "old"));

    const result = await buildPacks({ outDir, log: () => {} });
    expect(result.failures).toEqual([{ pack: "kenya mammalia full", error: "disk full" }]);
    expect(result.index!.packs.map((p) => p.id).sort()).toEqual(["kenya-amphibia", "kenya-aves", "kenya-mammalia"]);
  });

  it("clears a reused folder's old archives and returns the published index when nothing changed", async () => {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "leftover.pack.tar.gz"), "x");
    writeFileSync(path.join(outDir, "lifer-packs-old.bin"), "x");
    state.zones = [{ id: "z", name: "red_sea", taxa: [] }];
    state.versions.set("seazone-red_sea", "same");
    publish(entry("seazone-red_sea", "same"));

    const result = await buildPacks({ outDir, log: () => {} });
    expect(result.changed).toEqual([]);
    expect(result.index).toEqual(state.published);
    expect(readdirSync(outDir)).toEqual([]);
  });
});

describe("fetchPublishedIndex", () => {
  it("reads a published index, and an empty one only on 404", async () => {
    publish(entry("kenya-aves", "v"));
    expect((await fetchPublishedIndex()).packs.map((p) => p.id)).toEqual(["kenya-aves"]);
    state.fetchResponse = new Response("", { status: 404 });
    expect((await fetchPublishedIndex()).packs).toEqual([]);
  });

  it("throws on a server error or a body that isn't an index, never returning nothing", async () => {
    state.fetchResponse = new Response("", { status: 500 });
    await expect(fetchPublishedIndex()).rejects.toThrow(/HTTP 500/);
    state.fetchResponse = new Response(JSON.stringify({ message: "Not Found" }), { status: 200 });
    await expect(fetchPublishedIndex()).rejects.toThrow(/Unexpected published pack index/);
  });
});

describe("checkIndex", () => {
  it("reports dependencies that aren't in the index", () => {
    const index = {
      generatedAt: "",
      packs: [
        entry("kenya-aves", "v", { seaZoneDependencies: ["seazone-red_sea", "seazone-gone"] }),
        entry("seazone-red_sea", "v"),
      ],
    };
    expect(checkIndex(index)).toEqual(["kenya-aves depends on seazone-gone, which isn't in the index"]);
  });
});
