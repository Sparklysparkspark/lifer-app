// The published pack index on a weak signal (about 90 KB/s, 22 MB): it must arrive in the end,
// resuming with Range requests across dropped connections, never starting over from byte 0, and
// never calling a slow connection "offline". A local server stands in for the release CDN.
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ETAG = '"index-v1"';
const INDEX = Buffer.from(
  JSON.stringify({
    generatedAt: "2026-11-10T00:00:00Z",
    packs: Array.from({ length: 400 }, (_, i) => ({
      id: `test-pack-${i}`,
      type: "region",
      region: `Country ${i}`,
      taxon: "aves",
      sizeBytes: 1000 + i,
      speciesCount: 10,
      contentVersion: "v1",
      scientificNames: Array.from({ length: 20 }, (_, j) => `Genus species${i}x${j}`),
      url: "https://packs.invalid/shard.bin",
    })),
  }),
);
const requests: Array<{ path: string; range?: string; ifRange?: string; sent: number }> = [];
let drops = 2;
let server: http.Server;
const appData = mkdtempSync(path.join(os.tmpdir(), "lifer-index-download-"));

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url !== "/pack-index.json") return void res.writeHead(404).end();
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    const start = m && req.headers["if-range"] === ETAG ? Number(m[1]) : 0;
    const log = {
      path: req.url,
      range: req.headers.range,
      ifRange: req.headers["if-range"] as string | undefined,
      sent: 0,
    };
    requests.push(log);
    res.writeHead(
      start > 0 ? 206 : 200,
      start > 0
        ? {
            ETag: ETAG,
            "Content-Range": `bytes ${start}-${INDEX.length - 1}/${INDEX.length}`,
            "Content-Length": INDEX.length - start,
          }
        : { ETag: ETAG, "Content-Length": INDEX.length },
    );
    // Throttled, and the first connections drop part of the way through.
    const dropAfter = drops-- > 0 ? Math.floor((INDEX.length - start) / 3) : Infinity;
    let at = start;
    const tick = setInterval(() => {
      const end = Math.min(INDEX.length, at + 16_384);
      res.write(INDEX.subarray(at, end));
      log.sent += end - at;
      at = end;
      if (log.sent >= dropAfter) {
        clearInterval(tick);
        res.destroy();
      } else if (at >= INDEX.length) {
        clearInterval(tick);
        res.end();
      }
    }, 5);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.APP_DATA_DIR = appData;
  process.env.PACK_INDEX_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/pack-index.json`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
  rmSync(appData, { recursive: true, force: true });
});

describe("pack index on a weak, dropping connection", () => {
  it("completes across attempts, resuming with Range, never from zero, never 'offline'", async () => {
    const { fetchPackIndex, packIndexRemoteState, packNames } = await import("./index.js");
    const index = await fetchPackIndex({ fresh: true });
    expect(index.packs).toHaveLength(400);
    // The names are kept beside the packs, packed, for the routes that need them.
    const { names } = await packNames();
    const { namesOf } = await import("./indexLoader.js");
    expect(namesOf(names, 0)).toHaveLength(20);

    const full = requests.filter((r) => r.path === "/pack-index.json");
    expect(full.length).toBe(3);
    expect(full[0].range).toBeUndefined();
    // Each retry asks only for the rest, with the validator, so nothing is fetched twice.
    for (const retry of full.slice(1)) {
      expect(retry.range).toMatch(/^bytes=[1-9]\d*-$/);
      expect(retry.ifRange).toBe(ETAG);
    }
    // Each resume starts further on; only bytes lost in flight at a drop are asked for again.
    const starts = full.slice(1).map((r) => Number(/\d+/.exec(r.range!)![0]));
    expect(starts[1]).toBeGreaterThan(starts[0]);
    expect(full.reduce((sum, r) => sum + r.sent, 0)).toBeLessThan(INDEX.length * 1.25);
    expect(packIndexRemoteState().state).toBe("online");
  }, 30_000);
});
