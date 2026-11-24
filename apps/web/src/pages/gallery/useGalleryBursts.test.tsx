// @vitest-environment jsdom
// The grid's burst badge, the View menu's Group bursts and the folding it does.
import { fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GalleryItem } from "./types";

const post = vi.fn();
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: { post: (...args: unknown[]) => post(...args) },
}));

const { collapseBursts, useGalleryBursts } = await import("./useGalleryBursts");
const { default: PhotoTile } = await import("../../components/PhotoTile");
const { PhotoViewMenu } = await import("../../components/PhotoGridControls");

const item = (id: string, qualityRating: number | null = null, takenAt = "2025-05-01T10:00:00Z") =>
  ({ captureId: id, photoId: `p-${id}`, qualityRating, takenAt, kind: "image" }) as GalleryItem;

describe("collapseBursts", () => {
  it("folds each burst onto its best-rated photo, else its earliest, where the burst first shows", () => {
    const items = [
      item("a"),
      item("b1", null, "2025-05-01T10:00:01Z"),
      item("b0", null, "2025-05-01T10:00:00Z"),
      item("c"),
      item("d0", 2),
      item("d1", 5),
    ];
    const bursts = new Map([
      ["b0", { burstId: "b0", count: 9 }],
      ["b1", { burstId: "b0", count: 9 }],
      ["d0", { burstId: "d0", count: 2 }],
      ["d1", { burstId: "d0", count: 2 }],
    ]);
    expect(collapseBursts(items, bursts).map((i) => i.captureId)).toEqual(["a", "b0", "c", "d1"]);
  });
});

describe("useGalleryBursts", () => {
  it("asks once per photo, still photos only, and maps each to its burst", async () => {
    post.mockResolvedValue({ bursts: [{ burstId: "x", count: 12, captureIds: ["x", "y"] }] });
    const video = { ...item("v"), kind: "video" } as GalleryItem;
    const { result, rerender } = renderHook(({ items }) => useGalleryBursts(items), {
      initialProps: { items: [item("x"), item("y"), video] },
    });
    await waitFor(() => expect(result.current.get("y")).toEqual({ burstId: "x", count: 12 }));
    expect(post).toHaveBeenCalledWith("/gallery/bursts", { captureIds: ["x", "y"] });
    rerender({ items: [item("x"), item("y"), video, item("z")] });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post).toHaveBeenLastCalledWith("/gallery/bursts", { captureIds: ["z"] });
  });

  it("applies a big search's chunks in one update, so the grid changes once", async () => {
    post.mockReset();
    post.mockImplementation((_path: string, body: { captureIds: string[] }) =>
      Promise.resolve({ bursts: [{ burstId: body.captureIds[0], count: 2, captureIds: body.captureIds.slice(0, 2) }] }),
    );
    const items = Array.from({ length: 1200 }, (_, i) => item(`c${i}`));
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useGalleryBursts(items);
    });
    await waitFor(() => expect(result.current.size).toBe(6));
    expect(post).toHaveBeenCalledTimes(3);
    // The first render, then one for all three answers.
    expect(renders).toBe(2);
  });
});

describe("burst badge", () => {
  const tile = (burstCount?: number) =>
    render(
      <PhotoTile
        photoId="p1"
        alt="Scene Wren"
        burstCount={burstCount}
        onOpen={() => {}}
        selectMode={false}
        selected={false}
        onToggleSelect={() => {}}
        menuOpen={false}
        onToggleMenu={() => {}}
      />,
    );

  it("shows how many more photos the burst holds, and names the burst", () => {
    tile(12);
    expect(screen.getByText("+11")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Burst of 12 photos/ })).toBeTruthy();
  });

  it("sits over the photo, so a badge arriving late never changes the tile's height", () => {
    tile(12);
    expect(screen.getByText("+11").parentElement!.className).toMatch(/\babsolute\b/);
  });

  it("is absent for a photo alone", () => {
    tile(1);
    expect(screen.queryByText(/^\+/)).toBeNull();
  });
});

describe("Group bursts in the View menu", () => {
  it("toggles from the shared View menu", () => {
    const onChange = vi.fn();
    render(<PhotoViewMenu sections={["bursts"]} activeCount={0} groupBursts={{ checked: false, onChange }} />);
    fireEvent.click(screen.getByRole("button", { name: /View/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Group bursts" }));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
