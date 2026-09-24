import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { downloadResumable, StallError } from "./resumableDownload.js";

const body = Buffer.from(Array.from({ length: 100_000 }, (_, i) => i % 251));
const sha = createHash("sha256").update(body).digest("hex");
let server: http.Server;
let base: string;
const rangeHeaders: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/stall") {
      res.writeHead(200, { "content-length": String(body.length) });
      res.write(body.subarray(0, 10)); // then never finish
      return;
    }
    const range = req.headers.range;
    if (range) rangeHeaders.push(range);
    const m = range ? /^bytes=(\d+)-$/.exec(range) : null;
    if (m) {
      const start = Number(m[1]);
      res.writeHead(206, { "content-length": String(body.length - start) });
      res.end(body.subarray(start));
    } else {
      res.writeHead(200, { "content-length": String(body.length) });
      res.end(body);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "lifer-dl-test-"));

describe("downloadResumable", () => {
  it("resumes from a partial file with a Range request", async () => {
    const dest = path.join(tmp(), "f.bin");
    writeFileSync(`${dest}.part`, body.subarray(0, 40_000));
    const seen: number[] = [];
    await downloadResumable(`${base}/f`, dest, { expectedSha256: sha, onProgress: (d) => seen.push(d) });
    expect(readFileSync(dest).equals(body)).toBe(true);
    expect(rangeHeaders).toContain("bytes=40000-");
    expect(seen[0]).toBe(40_000);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it("rejects and discards a file with the wrong checksum", async () => {
    const dest = path.join(tmp(), "f.bin");
    await expect(downloadResumable(`${base}/f`, dest, { expectedSha256: "0".repeat(64) })).rejects.toThrow(/checksum/);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it("aborts a stalled transfer and keeps the partial file", async () => {
    const dest = path.join(tmp(), "f.bin");
    await expect(downloadResumable(`${base}/stall`, dest, { stallTimeoutMs: 300 })).rejects.toBeInstanceOf(StallError);
    expect(existsSync(`${dest}.part`)).toBe(true);
  });

  it("honors the caller's abort signal", async () => {
    const dest = path.join(tmp(), "f.bin");
    const ctl = new AbortController();
    const p = downloadResumable(`${base}/stall`, dest, { signal: ctl.signal, stallTimeoutMs: 10_000 });
    setTimeout(() => ctl.abort(), 100);
    await expect(p).rejects.toThrow();
  });
});
