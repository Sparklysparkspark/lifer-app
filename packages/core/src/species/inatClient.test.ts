import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queries: Array<{ text: string; values?: unknown[] }> = [];
let cachedBody: string | null = null;
vi.mock("../db.js", () => ({
  pool: {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      return { rows: text.trim().startsWith("SELECT") && cachedBody !== null ? [{ response: cachedBody }] : [] };
    },
  },
}));

const { resetHostPacing } = await import("../lib/http.js");
const {
  fetchINaturalistTaxon,
  inatFetch,
  INAT_RESPONSE_CACHE_MAX_AGE_MS,
  isTaxaResponse,
  PersistentRateLimitError,
  setInatResponseCacheMaxAge,
} = await import("./inatClient.js");

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  queries.length = 0;
  cachedBody = null;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  resetHostPacing();
  vi.useFakeTimers();
});
afterEach(() => {
  setInatResponseCacheMaxAge(INAT_RESPONSE_CACHE_MAX_AGE_MS);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("inatFetch", () => {
  it("throws PersistentRateLimitError when iNaturalist is still throttling after every retry", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 429 }));
    const pending = inatFetch("https://api.inaturalist.org/v1/taxa/1");
    const settled = expect(pending).rejects.toBeInstanceOf(PersistentRateLimitError);
    await vi.advanceTimersByTimeAsync(60_000);
    await settled;
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("reads the response cache with a 90-day limit, and with none once the pipeline asks", async () => {
    fetchMock.mockImplementation(async () => json({ results: [] }));
    await inatFetch("https://api.inaturalist.org/v1/taxa/1");
    expect(queries[0].values).toEqual(["https://api.inaturalist.org/v1/taxa/1", 90 * 24 * 60 * 60 * 1000]);

    queries.length = 0;
    setInatResponseCacheMaxAge(null);
    await vi.advanceTimersByTimeAsync(1000);
    await inatFetch("https://api.inaturalist.org/v1/taxa/1");
    expect(queries[0].values).toEqual(["https://api.inaturalist.org/v1/taxa/1", null]);
  });

  it("never caches image downloads", async () => {
    fetchMock.mockImplementation(async () => new Response("jpeg"));
    await inatFetch("https://inaturalist-open-data.s3.amazonaws.com/photos/1/medium.jpg");
    expect(queries).toHaveLength(0);
  });
});

describe("iNaturalist response shapes", () => {
  it("accepts the taxa fields enrichment reads and rejects odd payloads", () => {
    const photo = { medium_url: "https://x/1.jpg", license_code: null, attribution: "A" };
    expect(isTaxaResponse({ results: [{ id: 1, name: "A b", default_photo: photo, taxon_photos: [{ photo }] }] })).toBe(
      true,
    );
    expect(isTaxaResponse({ results: [{ id: 1, name: "A b", default_photo: null }] })).toBe(true);
    expect(isTaxaResponse({ error: "busy" })).toBe(false);
    expect(isTaxaResponse({ results: [{ id: "1", name: "A b" }] })).toBe(false);
    expect(isTaxaResponse({ results: [{ id: 1, name: "A b", default_photo: { url: "x" } }] })).toBe(false);
  });

  it("throws on a cached payload of the wrong shape and drops it from the cache", async () => {
    cachedBody = JSON.stringify({ unexpected: true });
    await expect(fetchINaturalistTaxon("Anas crecca")).rejects.toThrow(/Unexpected iNaturalist taxon search/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(queries.some((q) => q.text.startsWith("DELETE FROM inat_response_cache"))).toBe(true);
  });

  it("an error status is no answer rather than an exception", async () => {
    fetchMock.mockImplementation(async () => new Response("busy", { status: 500 }));
    await expect(fetchINaturalistTaxon("Anas crecca")).resolves.toBeNull();
  });
});
