import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DownloadStalledError, downloadToFile } from "./download.js";

let server: Server;
let base: string;
let tmp: string;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "lifer-download-"));
  server = createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, { "Content-Length": "10" });
      res.end("0123456789");
    } else if (req.url === "/stall") {
      res.writeHead(200, { "Content-Length": "100" });
      res.write("abc"); // then never finishes
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

describe("downloadToFile", () => {
  it("writes the body and reports byte progress", async () => {
    const dest = path.join(tmp, "ok.bin");
    const progress: Array<[number, number | null]> = [];
    const result = await downloadToFile(`${base}/ok`, dest, { onProgress: (d, t) => progress.push([d, t]) });
    expect(result).toEqual({ bytes: 10, totalBytes: 10 });
    expect(readFileSync(dest, "utf8")).toBe("0123456789");
    expect(progress.at(-1)).toEqual([10, 10]);
  });

  it("rejects on HTTP errors and leaves no file behind", async () => {
    const dest = path.join(tmp, "missing.bin");
    await expect(downloadToFile(`${base}/missing`, dest)).rejects.toThrow(/HTTP 404/);
    expect(existsSync(dest)).toBe(false);
  });

  it("aborts a stalled transfer and removes the partial file", async () => {
    const dest = path.join(tmp, "stall.bin");
    await expect(downloadToFile(`${base}/stall`, dest, { stallMs: 150 })).rejects.toBeInstanceOf(DownloadStalledError);
    expect(existsSync(dest)).toBe(false);
  });

  it("stops when the caller's signal aborts", async () => {
    const dest = path.join(tmp, "cancel.bin");
    const ctl = new AbortController();
    const p = downloadToFile(`${base}/stall`, dest, { signal: ctl.signal, stallMs: 10_000 });
    setTimeout(() => ctl.abort(), 50);
    await expect(p).rejects.toThrow();
    expect(existsSync(dest)).toBe(false);
  });
});
