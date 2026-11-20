import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../api/client", () => ({ api: { get: (...args: unknown[]) => get(...args) } }));
vi.mock("./packDownloadStore", () => ({ onPackDownloadFinish: () => {} }));

const { loadPackIndex, groupsForCountries } = await import("./packIndex");
const { resetAccountCaches } = await import("./resource");

const pack = (sizeBytes: number) => ({
  id: "canada",
  type: "region",
  sizeBytes,
  speciesCount: 1,
  contentVersion: "v1",
  url: "",
  downloaded: false,
  updateAvailable: false,
});

beforeEach(() => {
  vi.useFakeTimers();
  get.mockReset();
  resetAccountCaches();
});
afterEach(() => vi.useRealTimers());

describe("pack index", () => {
  it("keeps asking while photo sizes are pending, backing off, and stops once they land", async () => {
    get
      .mockResolvedValueOnce({ generatedAt: "", sizesPending: true, packs: [pack(10)] })
      .mockResolvedValueOnce({ generatedAt: "", sizesPending: true, packs: [pack(10)] })
      .mockResolvedValue({ generatedAt: "", packs: [pack(99)] });
    expect((await loadPackIndex())[0].sizeBytes).toBe(10);
    expect(get).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(get).toHaveBeenCalledTimes(2);
    // Still pending: asks again, later.
    await vi.advanceTimersByTimeAsync(10000);
    expect(get).toHaveBeenCalledTimes(3);
    expect((await loadPackIndex())[0].sizeBytes).toBe(99);
    await vi.advanceTimersByTimeAsync(120000);
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("follows a slow server's background refresh until the newer list lands, then stops", async () => {
    get
      .mockResolvedValueOnce({ generatedAt: "", remote: "slow", indexRefreshing: true, packs: [pack(10)] })
      .mockResolvedValueOnce({ generatedAt: "", remote: "slow", indexRefreshing: true, packs: [pack(10)] })
      .mockResolvedValue({ generatedAt: "", remote: "online", packs: [pack(99)] });
    await loadPackIndex();
    await vi.advanceTimersByTimeAsync(5000);
    expect(get).toHaveBeenCalledTimes(2);
    // Backs off: the next ask waits 10 s, not 5.
    await vi.advanceTimersByTimeAsync(5000);
    expect(get).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(get).toHaveBeenCalledTimes(3);
    // Online again: no more polling.
    await vi.advanceTimersByTimeAsync(120000);
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("doesn't ask again when the sizes are complete", async () => {
    get.mockResolvedValue({ generatedAt: "", packs: [pack(99)] });
    await loadPackIndex();
    await vi.advanceTimersByTimeAsync(20000);
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe("groupsForCountries", () => {
  const entry = (region: string, taxon: string, downloaded: boolean, sizeBytes = 10, variant?: string) =>
    ({
      ...pack(sizeBytes),
      id: `${region}-${taxon}-${variant ?? "full"}`,
      region,
      taxon,
      downloaded,
      variant,
    }) as never;

  it("marks a group downloaded only when every country has it, sizing what's missing per variant", () => {
    const packs = [
      entry("Canada", "aves", true),
      entry("United States", "aves", true),
      entry("Canada", "squamata", false, 5),
      entry("United States", "squamata", false, 7),
      entry("Canada", "mammalia", true),
      entry("United States", "mammalia", false, 20),
      entry("United States", "mammalia", false, 3, "small"),
      entry("Kenya", "corals", false),
    ];
    expect(groupsForCountries(packs, ["Canada", "United States"])).toEqual([
      { taxon: "aves", downloaded: true, sizeBytes: { full: 0, small: 0 } },
      { taxon: "mammalia", downloaded: false, sizeBytes: { full: 20, small: 3 } },
      { taxon: "squamata", downloaded: false, sizeBytes: { full: 12, small: 0 } },
    ]);
  });

  it("adds the sea zones a group pulls in, once each, in the same variant, unless already here", () => {
    const zone = (id: string, sizeBytes: number, downloaded = false, variant?: string) =>
      ({ ...pack(sizeBytes), id, type: "seaZone", seaZone: id, taxon: "actinopterygii", downloaded, variant }) as never;
    const fish = (region: string, sizeBytes: number, variant?: string) =>
      ({
        ...pack(sizeBytes),
        id: `${region}-fish${variant ? ".small" : ""}`,
        region,
        taxon: "actinopterygii",
        variant,
        seaZoneDependencies: ["zone-a", "zone-b"],
      }) as never;
    const packs = [
      fish("Canada", 100),
      fish("United States", 200),
      fish("Canada", 10, "small"),
      fish("United States", 20, "small"),
      zone("zone-a", 1000),
      zone("zone-b", 5000, true),
      zone("zone-a.small", 50, false, "small"),
      zone("zone-b.small", 70, false, "small"),
    ];
    // Full: 100 + 200 + zone-a (zone-b is here). Small: 10 + 20 + both small zones.
    expect(groupsForCountries(packs, ["Canada", "United States"])[0].sizeBytes).toEqual({ full: 1300, small: 150 });
  });

  it("is empty for no countries", () => {
    expect(groupsForCountries([entry("Canada", "aves", false)], [])).toEqual([]);
  });
});
