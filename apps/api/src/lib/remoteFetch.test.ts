import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { backoffMemo, fetchPatient, isUnreachable, remoteStateOf, retrying } from "./remoteFetch.js";

// A slow but working host: headers after 8 s, then the body a few bytes at a time.
let slow: http.Server;
let slowUrl = "";
beforeAll(async () => {
  slow = http.createServer((req, res) => {
    if (req.url === "/stall") {
      res.writeHead(200);
      res.write("a");
      return; // then silence
    }
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      const parts = ['{"pa', 'cks":', "[]", "}"];
      let i = 0;
      const tick = setInterval(() => {
        res.write(parts[i++]);
        if (i === parts.length) {
          clearInterval(tick);
          res.end();
        }
      }, 300);
    }, 8_000);
  });
  await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
  slowUrl = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;
});
afterAll(() => {
  slow.closeAllConnections();
  slow.close();
});
afterEach(() => vi.useRealTimers());

// A port nothing listens on: refused at once, like a host with no route.
async function deadUrl(): Promise<string> {
  const s = http.createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = (s.address() as AddressInfo).port;
  await new Promise((resolve) => s.close(resolve));
  return `http://127.0.0.1:${port}/index.json`;
}

describe("fetchPatient", () => {
  it("waits out a slow host and completes, without calling it offline", async () => {
    const { res, body } = await fetchPatient(`${slowUrl}/index.json`);
    expect(res.status).toBe(200);
    expect(JSON.parse(body.toString("utf8"))).toEqual({ packs: [] });
  }, 20_000);

  it("gives up on silence with a TimeoutError, which reads as slow", async () => {
    const err = await fetchPatient(`${slowUrl}/stall`, { stallMs: 300 }).catch((e: unknown) => e);
    expect((err as Error).name).toBe("TimeoutError");
    expect(remoteStateOf(err)).toBe("slow");
  });

  it("reads a refused host as offline, fast", async () => {
    const started = Date.now();
    const err = await fetchPatient(await deadUrl()).catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(isUnreachable(err)).toBe(true);
    expect(remoteStateOf(err)).toBe("offline");
  });
});

describe("backoffMemo", () => {
  it("backs off 10 s, then 20 s, up to the cap, and resets on success", () => {
    vi.useFakeTimers();
    const memo = backoffMemo({ firstMs: 10_000, maxMs: 30_000 });
    expect(memo.recent()).toBeNull();
    memo.fail("down");
    vi.advanceTimersByTime(9_999);
    expect(memo.recent()).not.toBeNull();
    vi.advanceTimersByTime(2);
    expect(memo.recent()).toBeNull();
    memo.fail("down");
    vi.advanceTimersByTime(19_999);
    expect(memo.recent()).not.toBeNull();
    memo.fail("down");
    memo.fail("down");
    vi.advanceTimersByTime(30_001);
    expect(memo.recent()).toBeNull();
    memo.clear();
    memo.fail("down");
    vi.advanceTimersByTime(10_001);
    expect(memo.recent()).toBeNull();
  });
});

describe("retrying", () => {
  it("tries again after a stall and stops at a 404", async () => {
    let calls = 0;
    const flaky = () => (++calls < 3 ? Promise.reject(new Error("stalled")) : Promise.resolve("ok"));
    expect(await retrying(flaky, { baseMs: 1 })).toBe("ok");
    expect(calls).toBe(3);

    const { HttpStatusError } = await import("./remoteFetch.js");
    let notFound = 0;
    await expect(
      retrying(
        () => {
          notFound++;
          return Promise.reject(new HttpStatusError(404, "x"));
        },
        { baseMs: 1 },
      ),
    ).rejects.toThrow("(404)");
    expect(notFound).toBe(1);
  });
});
