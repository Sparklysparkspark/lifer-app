import { beforeEach, describe, expect, it, vi } from "vitest";

const httpFetch = vi.hoisted(() => vi.fn());
vi.mock("@lifer/core/db.js", () => ({ pool: {} }));
vi.mock("@lifer/core/lib/http.js", () => ({ httpFetch }));
vi.mock("@lifer/core/lib/log.js", () => ({ log: { warn: vi.fn() } }));
// Successful lookups are written to the real cache file otherwise.
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

const { inatOffline, resetInatOffline, resolveCurrentInatTaxonId } = await import("./inatChecklist.js");

const refused = () => new Response("", { status: 429 });
const found = (name: string) =>
  new Response(
    JSON.stringify({
      total_results: 1,
      results: [{ id: 7, name, is_active: true, matched_term: name, rank: "species" }],
    }),
    { status: 200 },
  );

let n = 0;
const name = () => `Testus offlinensis${++n}`;

beforeEach(() => {
  resetInatOffline();
  httpFetch.mockReset();
});

describe("giving up on iNaturalist after repeated refusals", () => {
  it("stops calling after three requests in a row are refused, and answers unknown instead", async () => {
    httpFetch.mockImplementation(async () => refused());
    for (let i = 0; i < 3; i++) expect(await resolveCurrentInatTaxonId(name())).toBeNull();
    expect(inatOffline()).toBe(true);

    expect(await resolveCurrentInatTaxonId(name())).toBeNull();
    expect(httpFetch).toHaveBeenCalledTimes(3);
  });

  it("keeps going when a refusal is followed by an answer", async () => {
    httpFetch.mockImplementationOnce(async () => refused());
    httpFetch.mockImplementationOnce(async () => refused());
    const answered = name();
    httpFetch.mockImplementationOnce(async () => found(answered));
    httpFetch.mockImplementation(async () => refused());

    await resolveCurrentInatTaxonId(name());
    await resolveCurrentInatTaxonId(name());
    expect(await resolveCurrentInatTaxonId(answered)).toBe(7);
    await resolveCurrentInatTaxonId(name());
    await resolveCurrentInatTaxonId(name());
    expect(inatOffline()).toBe(false);
  });
});
