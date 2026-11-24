// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a) },
}));

const { hoverSamples } = await import("./MapHoverCard");
const { photosDeleted, resetAccountCaches } = await import("../../lib/resource");
const { movedPhotosChanged } = await import("../../hooks/useMovedPhotos");

const place = new URLSearchParams({ regionId: "r1" });

beforeEach(() => {
  resetAccountCaches();
  get.mockReset();
  get.mockResolvedValue({ items: [], total: 0 });
});

describe("hoverSamples cache", () => {
  it("asks once per place, then again after a sign-out, a delete or moved photos", async () => {
    await hoverSamples(place);
    await hoverSamples(place);
    expect(get).toHaveBeenCalledTimes(1);

    for (const change of [resetAccountCaches, photosDeleted, movedPhotosChanged]) {
      change();
      await hoverSamples(place);
    }
    expect(get).toHaveBeenCalledTimes(4);
  });
});
