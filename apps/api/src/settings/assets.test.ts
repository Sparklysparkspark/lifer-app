import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const appData = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/lifer-assets-${process.pid}`;
  process.env.APP_DATA_DIR = dir;
  process.env.MAP_DOWNLOAD_URL = "http://localhost/map.pmtiles";
  return dir;
});

const seen = vi.hoisted(() => ({ partExisted: null as boolean | null }));
vi.mock("@lifer/core/lib/resumableDownload.js", () => ({
  downloadResumable: async (_url: string, dest: string) => {
    seen.partExisted = existsSync(`${dest}.part`);
    return { bytes: 0 };
  },
}));
vi.mock("./autoDownloads.js", () => ({
  AUTO_MAP_KEY: "auto_map",
  AUTO_MODELS_KEY: "auto_models",
  setAutoDownload: async () => {},
  startAutoDownloads: async (_pool: unknown, _file: string, start: { map: () => boolean }) => ({
    models: false,
    map: start.map(),
  }),
}));
vi.mock("../species/catalogSeedUpdate.js", () => ({
  catalogFirstBootState: () => "done",
  waitForFirstBootCatalog: async () => {},
}));

describe("offline map download", () => {
  afterAll(() => rmSync(appData, { recursive: true, force: true }));

  it("starts over instead of resuming a partial map", async () => {
    const maps = path.join(appData, "maps");
    mkdirSync(maps, { recursive: true });
    writeFileSync(path.join(maps, "world-z8.pmtiles.part"), "older map");
    const { startAssetAutoDownloads } = await import("./assets.js");
    await startAssetAutoDownloads({} as never, { warn: () => {} });
    for (let i = 0; i < 50 && seen.partExisted === null; i++) await new Promise((r) => setTimeout(r, 10));
    expect(seen.partExisted).toBe(false);
  });
});
