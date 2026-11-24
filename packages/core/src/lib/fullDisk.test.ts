// A real full disk: CI points LIFER_FULL_DISK_DIR at a tiny tmpfs (the full-disk job in ci.yml).
// Skipped elsewhere, since it needs a volume that's nearly full.
import { existsSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DiskFullError, ensureRoom, freeSpace } from "./freeSpace.js";
import { downloadResumable } from "./resumableDownload.js";

const dir = process.env.LIFER_FULL_DISK_DIR;
const BIG = 8 * 1024 * 1024;

describe.skipIf(!dir)("on a full disk", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    // Chunked, with no Content-Length, so the up-front check can't catch it and the write must.
    server = createServer((req, res) => {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        ...(req.url === "/sized" && { "content-length": String(BIG) }),
      });
      const chunk = Buffer.alloc(64 * 1024, 1);
      let sent = 0;
      const pump = () => {
        while (sent < BIG) {
          sent += chunk.length;
          if (!res.write(chunk)) return res.once("drain", pump);
        }
        res.end();
      };
      pump();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  // The tests abort downloads mid-stream, so connections may still be open: drop them or close() waits.
  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );

  it("reports the volume's free space", async () => {
    const free = await freeSpace(dir!);
    expect(free).not.toBeNull();
    expect(free!).toBeLessThan(BIG);
  });

  it("refuses to start a job that can't fit, in plain sizes", async () => {
    await expect(ensureRoom(dir!, BIG)).rejects.toBeInstanceOf(DiskFullError);
    await expect(ensureRoom(dir!, BIG)).rejects.toThrow(/^Needs 8 MB, .+ free$/);
  });

  it("stops a download before writing when the size is known", async () => {
    const dest = path.join(dir!, "sized.bin");
    await expect(downloadResumable(`${base}/sized`, dest)).rejects.toBeInstanceOf(DiskFullError);
    expect(readdirSync(dir!)).toEqual([]);
  });

  it("deletes the partial file when the disk fills mid-way", async () => {
    const dest = path.join(dir!, "chunked.bin");
    await expect(downloadResumable(`${base}/chunked`, dest)).rejects.toBeInstanceOf(DiskFullError);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });
});
