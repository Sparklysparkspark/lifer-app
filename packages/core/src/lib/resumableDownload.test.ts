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
    if (req.url === "/ranged" || req.url === "/wrong-range" || req.url === "/long-range") {
      // Ranged answers for "0123456789", like GitHub's release downloads.
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? "");
      if (!m) return void res.writeHead(200).end("0123456789");
      if (req.url === "/wrong-range") return void res.writeHead(206, { "Content-Range": "bytes 0-3/10" }).end("0123");
      if (req.url === "/long-range") return void res.writeHead(206, { "Content-Range": "bytes 3-6/10" }).end("3456789");
      res
        .writeHead(206, { "Content-Range": `bytes ${m[1]}-${m[2]}/10` })
        .end("0123456789".slice(Number(m[1]), Number(m[2]) + 1));
      return;
    }
    if (req.url === "/missing") return void res.writeHead(404).end();
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
      if (start >= body.length) return void res.writeHead(416).end();
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

  it("restarts from zero when the partial file is already whole", async () => {
    const dest = path.join(tmp(), "f.bin");
    writeFileSync(`${dest}.part`, body);
    await downloadResumable(`${base}/f`, dest, { expectedSha256: sha });
    expect(rangeHeaders).toContain(`bytes=${body.length}-`);
    expect(readFileSync(dest).equals(body)).toBe(true);
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

  it("returns the file's size", async () => {
    const dest = path.join(tmp(), "f.bin");
    expect(await downloadResumable(`${base}/f`, dest)).toEqual({ bytes: body.length, totalBytes: body.length });
  });

  it("rejects on HTTP errors and leaves no file behind", async () => {
    const dest = path.join(tmp(), "missing.bin");
    await expect(downloadResumable(`${base}/missing`, dest)).rejects.toThrow(/HTTP 404/);
    expect(existsSync(dest)).toBe(false);
  });
});

describe("downloadResumable with a byte range", () => {
  it("fetches only the requested bytes", async () => {
    const dest = path.join(tmp(), "ranged.bin");
    expect(await downloadResumable(`${base}/ranged`, dest, { range: [3, 4] })).toEqual({ bytes: 4, totalBytes: 4 });
    expect(readFileSync(dest, "utf8")).toBe("3456");
  });

  it("never resumes a ranged download from a partial file", async () => {
    const dest = path.join(tmp(), "ranged.bin");
    writeFileSync(`${dest}.part`, "xx");
    await downloadResumable(`${base}/ranged`, dest, { range: [3, 4] });
    expect(readFileSync(dest, "utf8")).toBe("3456");
  });

  it("rejects a range request answered with the whole file", async () => {
    const dest = path.join(tmp(), "unranged.bin");
    await expect(downloadResumable(`${base}/f`, dest, { range: [3, 4] })).rejects.toThrow(/requested part/);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it("rejects a partial answer for another part of the file, or one longer than asked", async () => {
    const dest = path.join(tmp(), "wrong.bin");
    await expect(downloadResumable(`${base}/wrong-range`, dest, { range: [3, 4] })).rejects.toThrow(/requested part/);
    await expect(downloadResumable(`${base}/long-range`, dest, { range: [3, 4] })).rejects.toThrow(
      /more than the expected/,
    );
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it("rejects an invalid range before fetching", async () => {
    await expect(downloadResumable(`${base}/ranged`, path.join(tmp(), "bad.bin"), { range: [3, 0] })).rejects.toThrow(
      /invalid byte range/,
    );
  });
});
