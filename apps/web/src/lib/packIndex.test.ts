import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../api/client", () => ({ api: { get: (...args: unknown[]) => get(...args) } }));
vi.mock("./packDownloadStore", () => ({ onPackDownloadFinish: () => {} }));

const { loadPackIndex } = await import("./packIndex");
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
  it("asks again once shortly after the server says photo sizes are still pending", async () => {
    get
      .mockResolvedValueOnce({ generatedAt: "", sizesPending: true, packs: [pack(10)] })
      .mockResolvedValueOnce({ generatedAt: "", sizesPending: true, packs: [pack(10)] })
      .mockResolvedValue({ generatedAt: "", packs: [pack(99)] });
    expect((await loadPackIndex())[0].sizeBytes).toBe(10);
    expect(get).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(get).toHaveBeenCalledTimes(2);
    // Still pending after the retry: no endless polling.
    await vi.advanceTimersByTimeAsync(20000);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("doesn't ask again when the sizes are complete", async () => {
    get.mockResolvedValue({ generatedAt: "", packs: [pack(99)] });
    await loadPackIndex();
    await vi.advanceTimersByTimeAsync(20000);
    expect(get).toHaveBeenCalledTimes(1);
  });
});
