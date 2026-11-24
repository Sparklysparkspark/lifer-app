// @vitest-environment jsdom
import { createElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a) },
}));

const { default: MapHoverCard, hoverSamples } = await import("./MapHoverCard");
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

describe("MapHoverCard", () => {
  it("fills all six cells with photos when there's no Show all for a +N cell", async () => {
    const items = Array.from({ length: 6 }, (_, i) => ({
      captureId: `c${i}`,
      photoId: `p${i}`,
      commonName: `Bird ${i}`,
      takenAt: null,
    }));
    get.mockResolvedValue({ items, total: 40 });
    const noop = () => {};
    render(
      createElement(MapHoverCard, {
        x: 0,
        y: 0,
        avoid: 0,
        title: "Here",
        line: "40 photos",
        query: new URLSearchParams({ regionId: "slots" }),
        photoIds: [],
        onOpen: noop,
        onPointerEnter: noop,
        onPointerLeave: noop,
      }),
    );
    await waitFor(() => expect(screen.getByTestId("map-hover-preview").querySelectorAll("img")).toHaveLength(6));
    expect(screen.queryByText("+35")).toBeNull();
  });
});
