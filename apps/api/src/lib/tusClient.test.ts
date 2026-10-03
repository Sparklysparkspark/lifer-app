import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tusUploadFile } from "./tusClient.js";

let server: Server;
let endpoint: string;
let tmp: string;
// What the fake server answers a PATCH with: a proper offset, or none at all.
let patchOffset: (received: number) => string | null;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "lifer-tus-client-"));
  let received = 0;
  server = createServer((req, res) => {
    if (req.method === "POST") {
      received = 0;
      return void res.writeHead(201, { Location: "/tus/upload1" }).end();
    }
    if (req.method === "DELETE") return void res.writeHead(204).end();
    if (req.method === "PATCH") {
      req.on("data", (c: Buffer) => (received += c.length));
      req.on("end", () => {
        const offset = patchOffset(received);
        res.writeHead(204, offset === null ? {} : { "Upload-Offset": offset }).end();
      });
      return;
    }
    res.writeHead(405).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tus`;
});

afterAll(() => {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("tusUploadFile", () => {
  const file = () => {
    const p = path.join(tmp, "f.bin");
    writeFileSync(p, Buffer.alloc(1000, 1));
    return p;
  };

  it("uploads in chunks and returns the upload id", async () => {
    patchOffset = (received) => String(received);
    await expect(tusUploadFile(file(), { filename: "f.bin" }, { endpoint, headers: {}, initialChunkSize: 300 })).resolves.toBe("upload1");
  });

  it("fails rather than finishing early when a PATCH reply has no offset", async () => {
    patchOffset = () => null;
    await expect(tusUploadFile(file(), { filename: "f.bin" }, { endpoint, headers: {}, initialChunkSize: 300 })).rejects.toThrow(/unexpected upload offset/);
  });
});
