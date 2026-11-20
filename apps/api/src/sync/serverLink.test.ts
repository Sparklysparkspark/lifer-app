import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { linkProof } from "./linkProof.js";
import { keyMayGoTo, linkedServer } from "./serverLink.js";

describe("keyMayGoTo", () => {
  it("allows https anywhere, and plain http only on this computer or the local network", () => {
    for (const ok of [
      "https://lifer.example.com",
      "http://127.0.0.1:4000",
      "http://localhost:4000",
      "http://192.168.1.20:4000",
      "http://10.0.0.5",
      "http://172.20.1.1",
      "http://100.101.102.103",
      "http://[::1]:4000",
      "http://[fd12::1]",
      "http://nas:4000",
      "http://truenas.local:4000",
      "http://box.home.arpa",
    ])
      expect(keyMayGoTo(ok), ok).toBe(true);
    for (const no of [
      "http://203.0.113.5:4000",
      "http://lifer.example.com",
      "http://[2001:db8::1]",
      "ftp://nas",
      "nope",
    ])
      expect(keyMayGoTo(no), no).toBe(false);
  });
});

describe("linkedServer", () => {
  const servers: Server[] = [];
  const urls: string[] = [];
  beforeAll(async () => {
    for (const instanceId of ["another-server", "the-server"]) {
      const s = createServer((_req, res) => res.end(JSON.stringify({ instanceId })));
      await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
      servers.push(s);
      urls.push(`http://127.0.0.1:${(s.address() as AddressInfo).port}/`);
    }
  });
  afterAll(() => servers.forEach((s) => s.close()));

  it("skips an address that answers as another server, and never tries plain http over the internet", async () => {
    const started = Date.now();
    const server = await linkedServer({
      instanceId: "the-server",
      token: "t",
      urls: ["http://203.0.113.5:4000", ...urls],
    });
    expect(server?.baseUrl).toBe(urls[1].replace(/\/$/, ""));
    // The public address would have taken its 4 s timeout had it been tried.
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await linkedServer({ instanceId: "missing", token: "t", urls })).toBeNull();
  });
});

describe("linkedServer proof", () => {
  const SECRET = "the-link-secret";
  const KEY = "eeeeeeee-0000-4000-8000-000000000c01";
  let real: Server;
  let impostor: Server;
  const base = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const answer = (secret: string | null) =>
    createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      const u = new URL(req.url ?? "", "http://x");
      if (u.pathname === "/health") return res.end(JSON.stringify({ instanceId: "same-id" }));
      if (secret && u.pathname === "/api/sync/link/proof")
        return res.end(JSON.stringify({ proof: linkProof(secret, u.searchParams.get("nonce") ?? "") }));
      res.statusCode = 404;
      res.end("{}");
    });
  beforeAll(async () => {
    real = answer(SECRET);
    impostor = answer("a-guess");
    for (const s of [real, impostor]) await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  });
  afterAll(() => [real, impostor].forEach((s) => s.close()));

  it("gives the key only to a server that proves it holds the link secret", async () => {
    const link = { instanceId: "same-id", token: "t", keyId: KEY, linkSecret: SECRET };
    expect(await linkedServer({ ...link, urls: [base(impostor)] })).toBeNull();
    expect((await linkedServer({ ...link, urls: [base(impostor), base(real)] }))?.baseUrl).toBe(base(real));
    // Without any proof route the instance id alone earns nothing either.
    const silent = answer(null);
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    expect(await linkedServer({ ...link, urls: [base(silent)] })).toBeNull();
    silent.close();
  });
});
