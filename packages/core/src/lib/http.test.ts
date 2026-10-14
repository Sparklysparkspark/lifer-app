import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FetchTimeoutError,
  httpFetch,
  paceHost,
  resetHostPacing,
  retryAfterMs,
  USER_AGENT,
  type Queryable,
} from "./http.js";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  resetHostPacing();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function fakeDb(cached: string | null = null) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const db: Queryable = {
    query: async (text, values) => {
      calls.push({ text, values });
      return { rows: text.trim().startsWith("SELECT") && cached !== null ? [{ response: cached }] : [] };
    },
  };
  return { db, calls, writes: () => calls.filter((c) => c.text.trim().startsWith("INSERT")) };
}

describe("httpFetch", () => {
  it("sends Lifer's User-Agent unless the caller sets one", async () => {
    fetchMock.mockResolvedValue(new Response("ok"));
    await httpFetch("https://example.org/a");
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("User-Agent")).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(/^Lifer\/.+github\.com/);

    await httpFetch("https://example.org/b", { init: { headers: { "User-Agent": "custom" } } });
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get("User-Agent")).toBe("custom");
  });

  it("waits as long as Retry-After asks before retrying a 429", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "5" } }))
      .mockResolvedValueOnce(new Response("ok"));
    const pending = httpFetch("https://example.org/x", { backoffBaseMs: 1 });
    await vi.advanceTimersByTimeAsync(4900);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    const res = await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await res.text()).toBe("ok");
  });

  it("returns the last 429 once retries run out", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 429 }));
    const res = await httpFetch("https://example.org/x", { maxRetries: 2, backoffBaseMs: 1 });
    expect(res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries 5xx only when asked", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 503 }));
    expect((await httpFetch("https://example.org/x", { backoffBaseMs: 1 })).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockClear();
    await httpFetch("https://example.org/x", { backoffBaseMs: 1, maxRetries: 2, retryServerErrors: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a dropped connection and rethrows when every attempt fails", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(new Response("ok"));
    expect((await httpFetch("https://example.org/x", { backoffBaseMs: 1 })).status).toBe(200);

    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(httpFetch("https://example.org/x", { backoffBaseMs: 1, maxRetries: 1 })).rejects.toThrow(
      "fetch failed",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("times out a connection that never answers, even when the fetch ignores its signal", async () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    await expect(httpFetch("https://example.org/x", { timeoutMs: 30, maxRetries: 0 })).rejects.toBeInstanceOf(
      FetchTimeoutError,
    );
  });

  it("caches successes only, and serves cached bodies without fetching", async () => {
    const empty = fakeDb();
    fetchMock.mockResolvedValueOnce(new Response("busy", { status: 500 }));
    await httpFetch("https://example.org/x", { cache: { table: "gbif_response_cache", db: empty.db } });
    expect(empty.writes()).toHaveLength(0);

    fetchMock.mockResolvedValueOnce(new Response("fresh"));
    await httpFetch("https://example.org/x", { cache: { table: "gbif_response_cache", db: empty.db } });
    expect(empty.writes()[0].values).toEqual(["https://example.org/x", "fresh"]);

    const hit = fakeDb("cached");
    fetchMock.mockClear();
    const res = await httpFetch("https://example.org/x", { cache: { table: "gbif_response_cache", db: hit.db } });
    expect(await res.text()).toBe("cached");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes the cache's max age to the lookup, null meaning any age", async () => {
    fetchMock.mockImplementation(async () => new Response("x"));
    const aged = fakeDb();
    await httpFetch("https://example.org/x", { cache: { table: "inat_response_cache", maxAgeMs: 1000, db: aged.db } });
    expect(aged.calls[0].text).toMatch(/fetched_at > now\(\)/);
    expect(aged.calls[0].values).toEqual(["https://example.org/x", 1000]);

    const forever = fakeDb();
    await httpFetch("https://example.org/x", { cache: { table: "inat_response_cache", db: forever.db } });
    expect(forever.calls[0].values).toEqual(["https://example.org/x", null]);
  });

  it("never caches a request other than GET", async () => {
    const { db, calls } = fakeDb("cached");
    fetchMock.mockResolvedValue(new Response("posted"));
    const res = await httpFetch("https://example.org/x", {
      init: { method: "POST" },
      cache: { table: "gbif_response_cache", db },
    });
    expect(await res.text()).toBe("posted");
    expect(calls).toHaveLength(0);
  });
});

describe("retryAfterMs", () => {
  it("reads seconds and HTTP dates, and ignores anything else", () => {
    expect(retryAfterMs("3")).toBe(3000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(retryAfterMs("0")).toBeNull();
    expect(retryAfterMs("soon")).toBeNull();
    expect(retryAfterMs(null)).toBeNull();
  });
});

describe("paceHost", () => {
  it("spaces calls to one host apart, whoever makes them, and leaves other hosts alone", async () => {
    vi.useFakeTimers();
    const times: Record<string, number[]> = { a: [], b: [] };
    const start = Date.now();
    const calls = [
      paceHost("a.example", 1000).then(() => times.a.push(Date.now() - start)),
      paceHost("a.example", 1000).then(() => times.a.push(Date.now() - start)),
      paceHost("b.example", 1000).then(() => times.b.push(Date.now() - start)),
    ];
    await vi.advanceTimersByTimeAsync(1500);
    await Promise.all(calls);
    expect(times.a).toEqual([0, 1000]);
    expect(times.b).toEqual([0]);
  });

  it("paces iNaturalist hosts by default", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => new Response("ok"));
    const first = httpFetch("https://api.inaturalist.org/v1/taxa/1");
    const second = httpFetch("https://api.inaturalist.org/v1/taxa/2");
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("holdHost", () => {
  it("makes every caller wait out a 429 on that host", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "30" } }))
      .mockResolvedValue(new Response("ok"));
    const refused = await httpFetch("https://example.org/a", { maxRetries: 0 });
    expect(refused.status).toBe(429);
    const other = httpFetch("https://example.org/b");
    await vi.advanceTimersByTimeAsync(29_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_100);
    expect((await other).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("httpFetch against a real server", () => {
  let server: Server | null = null;
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
    server = null;
  });

  async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  }

  it("gives up on a server that never answers, and drops the connection", async () => {
    let closed!: () => void;
    const connectionClosed = new Promise<void>((resolve) => (closed = resolve));
    const url = await serve((req) => req.socket.on("close", () => closed()));
    await expect(httpFetch(url, { timeoutMs: 50, maxRetries: 0 })).rejects.toThrow(
      `fetch timed out after 50ms: ${url}`,
    );
    await expect(connectionClosed).resolves.toBeUndefined();
  });

  it("cancels its timer once the response arrives", async () => {
    const url = await serve((_req, res) => res.end("ok"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const res = await httpFetch(url, { timeoutMs: 60_000 });
    expect(await res.text()).toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a body that stalls after the headers arrive", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.write("partial");
    });
    const res = await httpFetch(url, { timeoutMs: 100, maxRetries: 0 });
    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toThrow();
  });
});
