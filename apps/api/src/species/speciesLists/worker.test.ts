// The list fetch loop against a fake iNaturalist: paging, the saved cursor, resuming, batches past
// the cap, and iNaturalist being away. No network, no database.
import { describe, expect, it, vi } from "vitest";
import { InatUnavailableError, PAGES_PER_BATCH, PER_PAGE, parseSpeciesCounts, speciesCountsUrl } from "./inat.js";
import { BATCH_GAP_MS, runList, type WorkerDeps } from "./worker.js";

function fakeInat(total: number, fail?: { page: number; error: Error }) {
  const pages: number[] = [];
  const saved: { page: number; nextPage: number; last: boolean; n: number }[] = [];
  const states: [string, string | null, number | null][] = [];
  const deps: WorkerDeps = {
    fetchPage: async (_q, page) => {
      pages.push(page);
      if (fail?.page === page) throw fail.error;
      const start = (page - 1) * PER_PAGE;
      const n = Math.max(0, Math.min(PER_PAGE, total - start));
      return {
        total,
        species: Array.from({ length: n }, (_, i) => ({
          taxonId: start + i + 1,
          scientificName: `Zz sp${start + i + 1}`,
          commonName: null,
          iconicTaxon: "Arachnida",
          count: 1,
          establishmentMeans: null,
          photo: null,
        })),
      };
    },
    savePage: async (_id, res, nextPage, last) => {
      saved.push({ page: nextPage - 1, nextPage, last, n: res.species.length });
      return true;
    },
    setState: async (_id, status, err, retry) => void states.push([status, err, retry]),
    sleep: async () => {},
  };
  return { deps, pages, saved, states };
}

const list = (nextPage = 1) => ({
  id: "l1",
  inat_taxon_id: 47118,
  inat_place_id: 6712,
  native_only: false,
  next_page: nextPage,
});
const signal = new AbortController().signal;

describe("runList", () => {
  it("reads every page, saving the cursor after each, and marks the last", async () => {
    const inat = fakeInat(795);
    expect(await runList(list(), signal, inat.deps)).toBe("done");
    expect(inat.pages).toEqual([1, 2]);
    expect(inat.saved).toEqual([
      { page: 1, nextPage: 2, last: false, n: 500 },
      { page: 2, nextPage: 3, last: true, n: 295 },
    ]);
  });

  it("resumes from the saved page", async () => {
    const inat = fakeInat(1600);
    expect(await runList(list(3), signal, inat.deps)).toBe("done");
    expect(inat.pages).toEqual([3, 4]);
  });

  it("stops at the size cap and leaves the next batch for later", async () => {
    const inat = fakeInat(15_415);
    expect(await runList(list(), signal, inat.deps)).toBe("batch");
    expect(inat.pages).toHaveLength(PAGES_PER_BATCH);
    expect(inat.states).toEqual([["queued", null, BATCH_GAP_MS]]);
    // The next batch picks up where this one stopped.
    const next = fakeInat(15_415);
    await runList(list(PAGES_PER_BATCH + 1), signal, next.deps);
    expect(next.pages[0]).toBe(PAGES_PER_BATCH + 1);
  });

  it("finishes an empty list after one call", async () => {
    const inat = fakeInat(0);
    expect(await runList(list(), signal, inat.deps)).toBe("done");
    expect(inat.saved).toEqual([{ page: 1, nextPage: 2, last: true, n: 0 }]);
  });

  it("waits offline, keeping the cursor, when the connection drops mid-list", async () => {
    const inat = fakeInat(1600, { page: 2, error: new InatUnavailableError("offline") });
    expect(await runList(list(), signal, inat.deps)).toBe("offline");
    expect(inat.saved.map((s) => s.nextPage)).toEqual([2]);
    expect(inat.states[0].slice(0, 2)).toEqual(["offline", "offline"]);
  });

  it("backs off for an hour on a refusal instead of failing the list", async () => {
    for (const code of ["rate_limited", "refused"] as const) {
      const inat = fakeInat(600, { page: 1, error: new InatUnavailableError(code) });
      expect(await runList(list(), signal, inat.deps)).toBe("throttled");
      expect(inat.states).toEqual([["queued", code, 60 * 60_000]]);
    }
  });

  it("marks the list failed on anything else", async () => {
    const inat = fakeInat(600, { page: 1, error: new Error("bad shape") });
    expect(await runList(list(), signal, inat.deps)).toBe("failed");
    expect(inat.states).toEqual([["failed", "failed", null]]);
  });

  it("stops when the list was paused or removed meanwhile", async () => {
    const inat = fakeInat(1600);
    inat.deps.savePage = vi.fn(async () => false);
    expect(await runList(list(), signal, inat.deps)).toBe("stopped");
    expect(inat.pages).toEqual([1]);
  });
});

describe("species_counts", () => {
  it("asks for Research Grade species, and native ones only when asked", () => {
    const url = new URL(speciesCountsUrl({ taxonId: 47118, placeId: 6712, nativeOnly: false }, 2));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      taxon_id: "47118",
      place_id: "6712",
      quality_grade: "research",
      rank: "species",
      per_page: "500",
      page: "2",
      locale: "en",
    });
    expect(url.searchParams.has("native")).toBe(false);
    const native = new URL(speciesCountsUrl({ taxonId: 47118, placeId: 6712, nativeOnly: true }, 1));
    expect(native.searchParams.get("native")).toBe("true");
  });

  it("reads names, counts, establishment and only licensed photos", () => {
    const taxon = (id: number, extra: object) => ({
      id,
      name: `Zz sp${id}`,
      rank: "species",
      iconic_taxon_name: "Arachnida",
      ...extra,
    });
    const page = parseSpeciesCounts({
      total_results: 4,
      results: [
        {
          count: 12,
          taxon: taxon(1, {
            preferred_common_name: "cross orbweaver",
            establishment_means: { establishment_means: "introduced", place: { id: 6712 } },
            default_photo: {
              medium_url: "https://inaturalist-open-data.s3.amazonaws.com/photos/1/medium.jpg",
              license_code: "cc-by-nc",
              attribution: "(c) A",
            },
          }),
        },
        {
          count: 3,
          taxon: taxon(2, {
            default_photo: { medium_url: "https://x/2.jpg", license_code: null, attribution: "(c) B" },
          }),
        },
        { count: 2, taxon: { ...taxon(3, {}), rank: "subspecies" } },
        { count: 1, taxon: taxon(4, { preferred_establishment_means: "native" }) },
      ],
    });
    expect(page.total).toBe(4);
    expect(page.species.map((s) => s.taxonId)).toEqual([1, 2, 4]);
    expect(page.species[0]).toMatchObject({
      commonName: "Cross Orbweaver",
      count: 12,
      establishmentMeans: "introduced",
      photo: { license: "cc-by-nc", credit: "(c) A" },
    });
    // All rights reserved: no photo kept.
    expect(page.species[1].photo).toBeNull();
    expect(page.species[2].establishmentMeans).toBe("native");
  });

  it("refuses a body that isn't a species_counts answer", () => {
    expect(() => parseSpeciesCounts({ error: "nope" })).toThrow();
  });
});
