// @vitest-environment jsdom
// The viewer's burst and scene strip: what it shows, picking a frame by click and keyboard, the
// windowing that keeps a long burst cheap, and the viewer following a pick into another list.
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ToastContext, type ToastApi } from "../../hooks/useToast";
import type { GalleryItem } from "./types";

const scenes = new Map<string, unknown>();
vi.mock("../../lib/resource", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/resource")>()),
  useApiRoute: (path: string | null) => ({ data: path ? (scenes.get(path) ?? null) : null, error: null }),
}));

const { default: SceneStrip } = await import("./SceneStrip");
const { coverOf } = await import("./useGalleryBursts");
const { default: Lightbox } = await import("../../components/Lightbox");

const toast: ToastApi = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };
const item = (id: string, qualityRating: number | null = null) =>
  ({ captureId: id, photoId: `p-${id}`, qualityRating, kind: "image" }) as GalleryItem;
const burst = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => item(`${prefix}${i}`));

/** Registers the scene answer for every photo in it. */
function sceneOf(bursts: GalleryItem[][], truncated = false) {
  const body = { scene: bursts.map((frames) => ({ burstId: frames[0].captureId, frames })), truncated };
  for (const frames of bursts) for (const f of frames) scenes.set(`/captures/${f.captureId}/scene`, body);
}

function renderStrip(captureId: string, onPick = vi.fn()) {
  render(<SceneStrip captureId={captureId} onPick={onPick} />);
  return onPick;
}

describe("SceneStrip", () => {
  it("shows nothing for a photo alone", () => {
    sceneOf([[item("alone")]]);
    renderStrip("alone");
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("unfolds the photo's burst and folds the others into one tile each", () => {
    sceneOf([burst("a", 12), burst("b", 5), [item("c0")]]);
    renderStrip("a2");
    expect(screen.getByText("Burst of 12 photos, scene of 3 bursts")).toBeTruthy();
    const current = screen.getByRole("button", { name: "Frame 3 of 12" });
    expect(current.getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: "Burst 2 of 3, 5 photos" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Burst 3 of 3, 1 photo" })).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(14);
  });

  it("names a single photo's scene without a burst", () => {
    sceneOf([[item("s0")], [item("s1")]]);
    renderStrip("s0");
    expect(screen.getByText("Scene of 2 bursts")).toBeTruthy();
  });

  it("folds a burst onto its best-rated photo, else its first", () => {
    expect(coverOf([item("x"), item("y", 4), item("z", 2)]).captureId).toBe("y");
    expect(coverOf([item("x"), item("y")]).captureId).toBe("x");
  });

  it("picks a frame or a folded burst on click, with the whole scene", () => {
    sceneOf([burst("a", 3), burst("b", 2)]);
    const onPick = renderStrip("a0");
    fireEvent.click(screen.getByRole("button", { name: "Frame 2 of 3" }));
    expect(onPick.mock.calls[0][0].captureId).toBe("a1");
    expect(onPick.mock.calls[0][1].map((f: GalleryItem) => f.captureId)).toEqual(["a0", "a1", "a2", "b0", "b1"]);
    fireEvent.click(screen.getByRole("button", { name: "Burst 2 of 2, 2 photos" }));
    expect(onPick.mock.calls[1][0].captureId).toBe("b0");
  });

  it("moves with the arrow keys, Home and End, without the viewer's own arrows", () => {
    sceneOf([burst("a", 3), burst("b", 2)]);
    const onPick = renderStrip("a1");
    const viewerKeys = vi.fn();
    window.addEventListener("keydown", viewerKeys);
    const current = screen.getByRole("button", { name: "Frame 2 of 3" });
    expect(current.tabIndex).toBe(0);
    fireEvent.keyDown(current, { key: "ArrowRight" });
    fireEvent.keyDown(current, { key: "ArrowLeft" });
    fireEvent.keyDown(current, { key: "End" });
    fireEvent.keyDown(current, { key: "Home" });
    window.removeEventListener("keydown", viewerKeys);
    expect(onPick.mock.calls.map((c) => c[0].captureId)).toEqual(["a2", "a0", "b0", "a0"]);
    expect(viewerKeys).not.toHaveBeenCalled();
  });

  it("draws only the tiles near the photo in a 300-frame burst", () => {
    sceneOf([burst("l", 300)], true);
    renderStrip("l150");
    expect(screen.getByRole("button", { name: "Frame 151 of 300" })).toBeTruthy();
    expect(screen.getAllByRole("button").length).toBeLessThan(60);
    expect(screen.queryByRole("button", { name: "Frame 1 of 300" })).toBeNull();
    expect(screen.getByText("Showing the 300 photos nearest this one")).toBeTruthy();
  });
});

describe("SceneStrip in the viewer", () => {
  // As the Gallery does: a frame the list doesn't hold switches the viewer to the scene's photos.
  function Harness({ grid }: { grid: GalleryItem[] }) {
    const [list, setList] = useState(grid);
    const [index, setIndex] = useState(0);
    return (
      <Lightbox
        slides={list.map((it) => ({ url: `/${it.photoId}.jpg`, captureId: it.captureId, caption: it.captureId }))}
        index={index}
        onIndexChange={setIndex}
        onClose={vi.fn()}
        footer={(slide, follow) => (
          <SceneStrip
            captureId={slide.captureId!}
            onPick={(frame, scene) => {
              follow(frame.captureId);
              const at = list.findIndex((it) => it.captureId === frame.captureId);
              if (at < 0) setList(scene);
              setIndex(at >= 0 ? at : scene.findIndex((it) => it.captureId === frame.captureId));
            }}
          />
        )}
      />
    );
  }

  it("moves the viewer to a picked frame the grid doesn't list, and stays open", () => {
    const frames = burst("v", 4);
    sceneOf([frames]);
    render(
      <MemoryRouter>
        <ToastContext.Provider value={toast}>
          <Harness grid={[frames[0], item("other")]} />
        </ToastContext.Provider>
      </MemoryRouter>,
    );
    expect(screen.getByText("v0")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Frame 3 of 4" }));
    expect(screen.getByText("v2")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Frame 3 of 4" }).getAttribute("aria-current")).toBe("true");
  });
});
