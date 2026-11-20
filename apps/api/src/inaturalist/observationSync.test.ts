// Reading the user's observations: paging by id, the changed-since filter, pacing and backing off.
// Every request is mocked; nothing reaches iNaturalist.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { PAGE_SIZE, fetchObservationPages, fetchPreview, politeGet } from "./observationSync.js";

const osprey = JSON.parse(readFileSync(new URL("./__fixtures__/osprey-observation.json", import.meta.url), "utf8"))
  .results[0];
const obs = (id: number) => ({ ...osprey, id });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("fetchObservationPages", () => {
  it("pages by id_above until a short page, pausing between requests", async () => {
    const first = Array.from({ length: PAGE_SIZE }, (_, i) => obs(i + 1));
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ total_results: 201, results: first }))
      .mockResolvedValueOnce(json({ total_results: 1, results: [obs(201)] }));
    const sleep = vi.fn(async (_ms: number) => {});
    const pages: number[] = [];
    const progress: Array<{ read: number; total: number }> = [];
    const read = await fetchObservationPages(
      {
        inatUserId: "10831672",
        jwt: "jwt-token",
        idAbove: 0,
        updatedSince: null,
        onPage: async (page, p) => {
          pages.push(page.length);
          progress.push(p);
        },
      },
      { fetchImpl, sleep },
    );
    expect(read).toBe(201);
    expect(pages).toEqual([200, 1]);
    expect(progress.at(-1)).toEqual({ read: 201, total: 201 });
    const urls = fetchImpl.mock.calls.map((c) => new URL(String(c[0])));
    expect(urls[0].searchParams.get("id_above")).toBe("0");
    expect(urls[1].searchParams.get("id_above")).toBe("200");
    expect(urls[0].searchParams.get("order_by")).toBe("id");
    expect(urls[0].searchParams.get("per_page")).toBe("200");
    expect(urls[0].searchParams.get("user_id")).toBe("10831672");
    expect((fetchImpl.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe("jwt-token");
    expect((fetchImpl.mock.calls[0][1]?.headers as Record<string, string>)["User-Agent"]).toMatch(/Lifer/);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("asks only for what changed, resuming from a given id", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ total_results: 0, results: [] }));
    await fetchObservationPages(
      { inatUserId: "1", jwt: null, idAbove: 412000000, updatedSince: "2026-11-03T00:00:00Z", onPage: async () => {} },
      { fetchImpl, sleep: async () => {} },
    );
    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.searchParams.get("updated_since")).toBe("2026-11-03T00:00:00Z");
    expect(url.searchParams.get("id_above")).toBe("412000000");
    expect(fetchImpl.mock.calls[0][1]?.headers).not.toHaveProperty("Authorization");
  });

  it("fails plainly on a refused request", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({}, 401));
    await expect(
      fetchObservationPages(
        { inatUserId: "1", jwt: "x", idAbove: 0, updatedSince: null, onPage: async () => {} },
        { fetchImpl, sleep: async () => {} },
      ),
    ).rejects.toThrow(/401/);
  });
});

describe("politeGet", () => {
  it("waits as long as Retry-After says on 429, then retries", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 429, { "retry-after": "7" }))
      .mockResolvedValueOnce(json({ ok: true }));
    const sleep = vi.fn(async (_ms: number) => {});
    const res = await politeGet("https://api.inaturalist.org/v1/x", {}, { fetchImpl, sleep });
    expect(res.status).toBe(200);
    expect(sleep).toHaveBeenCalledWith(7000);
  });

  it("backs off longer each time on 5xx and network errors, then gives up", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue(json({}, 503));
    const sleep = vi.fn(async (_ms: number) => {});
    await expect(politeGet("https://api.inaturalist.org/v1/x", {}, { fetchImpl, sleep })).rejects.toThrow(/503/);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([5000, 10000, 20000, 40000, 80000]);
  });
});

describe("fetchPreview", () => {
  it("takes only images", async () => {
    const image = new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { "content-type": "image/jpeg" } });
    expect(
      (await fetchPreview("https://x/large.jpg", { fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(image) })).length,
    ).toBe(3);
    const page = new Response("<html>", { headers: { "content-type": "text/html" } });
    await expect(
      fetchPreview("https://x/large.jpg", { fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(page) }),
    ).rejects.toThrow(/isn't a photo/);
  });
});
