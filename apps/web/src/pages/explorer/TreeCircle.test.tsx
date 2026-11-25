// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TreeCircle from "./TreeCircle";
import { indexTree, type TreeNode } from "./treeModel";

const node = (rank: TreeNode["rank"], name: string, total: number, children: TreeNode[] = []): TreeNode => ({
  rank,
  name,
  collected: Math.floor(total / 2),
  total,
  photos: 0,
  targetCount: 0,
  seenCount: 0,
  tiers: {},
  photoId: null,
  children,
});
const index = indexTree([
  node("class", "Aves", 40, [node("order", "Passeriformes", 30), node("order", "Strigiformes", 10)]),
  node("class", "Mammalia", 20, [node("order", "Carnivora", 20)]),
]);
const props = {
  index,
  genus: false,
  selected: null,
  label: (n: TreeNode) => n.name,
  onPick: () => {},
  onMore: () => {},
  top: null,
  onZoomOut: () => {},
  onMenu: () => {},
  rarity: true,
};
const shapes = (c: HTMLElement) =>
  [...c.querySelectorAll("[data-arcs] path")].map((p) => `${p.getAttribute("aria-label")}:${p.getAttribute("d")}`);

let frames: FrameRequestCallback[] = [];
let clock = 0;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  frames = [];
});
const stubFrames = () => {
  clock = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
};
/** Moves the clock on by `ms` and runs the waiting frame. */
const runFrame = (ms: number) => {
  clock += ms;
  act(() => frames.splice(0).forEach((cb) => cb(clock)));
};

describe("TreeCircle motion", () => {
  it("morphs a zoom on a hidden layer, then shows the same arcs as a still render", () => {
    stubFrames();
    const { container, rerender } = render(<TreeCircle {...props} center={null} />);
    expect(container.querySelector("[data-arc-motion]")).toBeNull();
    rerender(<TreeCircle {...props} center="class:Aves" />);
    const layer = container.querySelector("[data-arc-motion]")!;
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector("[data-arcs]")!.getAttribute("class")).toContain("opacity-0");
    // The first frame is painted at once, from where the arcs were.
    expect(layer.querySelector('[data-part="empty"]')!.getAttribute("d")).toBeTruthy();
    runFrame(100);
    expect(container.querySelector("[data-arc-motion]")).not.toBeNull();
    runFrame(10_000);
    expect(container.querySelector("[data-arc-motion]")).toBeNull();
    expect(container.querySelector("[data-arcs]")!.getAttribute("class")).toBeNull();

    const still = render(<TreeCircle {...props} center="class:Aves" />);
    expect(shapes(container)).toEqual(shapes(still.container));
  });

  it("a change mid-morph restarts from the frame on screen without a jump", () => {
    stubFrames();
    const { container, rerender } = render(<TreeCircle {...props} center={null} />);
    rerender(<TreeCircle {...props} center="class:Aves" />);
    runFrame(150);
    const drawn = () =>
      [...container.querySelectorAll('[data-arc-motion] [data-part="empty"]')].map((p) => p.getAttribute("d")).sort();
    const before = drawn();
    rerender(<TreeCircle {...props} center={null} />);
    // The retargeted first frame is exactly the frame just drawn.
    expect(drawn()).toEqual(before);
    runFrame(10_000);
    expect(container.querySelector("[data-arc-motion]")).toBeNull();
  });

  it("swaps instantly with reduced motion", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") }));
    const { container, rerender } = render(<TreeCircle {...props} center={null} />);
    rerender(<TreeCircle {...props} center="class:Aves" />);
    expect(container.querySelector("[data-arc-motion]")).toBeNull();
  });

  it("rings the selection over every arc, and hides the ring while the arcs morph", () => {
    stubFrames();
    const { container, rerender } = render(<TreeCircle {...props} center={null} selected="class:Aves" />);
    const ring = container.querySelector('[data-outline="selected"]')!;
    expect(ring.previousElementSibling?.matches("[data-arcs]")).toBe(true);
    // No arc keeps the old heavy selection stroke.
    expect(container.querySelector("[data-arcs] .stroke-ink")).toBeNull();
    rerender(<TreeCircle {...props} center="class:Aves" selected="class:Aves/order:Passeriformes" />);
    expect(container.querySelector("[data-outline]")).toBeNull();
    runFrame(10_000);
    expect(container.querySelector('[data-outline="selected"]')).not.toBeNull();
  });
});
