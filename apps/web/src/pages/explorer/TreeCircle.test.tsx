// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
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

  // The pointer can rest on an arc while the tree under it changes (a region pill, a mark, Targets only).
  it("drops a hovered group the new tree lacks", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") }));
    const { container, rerender } = render(<TreeCircle {...props} center={null} />);
    fireEvent.mouseEnter(container.querySelector('[aria-label^="Strigiformes"]')!);
    expect(container.querySelector('[aria-live="polite"]')!.textContent).toContain("Strigiformes");
    const other = indexTree([node("class", "Mammalia", 20, [node("order", "Carnivora", 20)])]);
    rerender(<TreeCircle {...props} index={other} center={null} />);
    expect(container.querySelector('[aria-live="polite"]')!.textContent).toContain("All groups");
    expect(container.querySelector('[data-outline="hover"]')).toBeNull();
  });

  it("reads a More groups arc like a group, and opens it on click", () => {
    const big = { ...node("class", "Aves", 1000, [node("order", "P", 1000)]), tiers: { common: 1000 } };
    const tiny = (name: string, extra: Partial<TreeNode>) => ({
      ...node("class", name, 1, [node("order", `${name}o`, 1)]),
      ...extra,
    });
    const onMore = vi.fn();
    const { container } = render(
      <TreeCircle
        {...props}
        center={null}
        onMore={onMore}
        index={indexTree([
          big,
          tiny("A", { tiers: { common: 1 }, collected: 1 }),
          tiny("B", { tiers: { rare: 1 }, targetCount: 1 }),
          tiny("C", { tiers: { unrated: 1 } }),
        ])}
      />,
    );
    const arc = container.querySelector('[aria-label^="3 more groups"]')!;
    // (common + rare) / 2 rounds to uncommon; the unrated species does not count.
    expect(arc.getAttribute("aria-label")).toBe(
      "3 more groups, 1 of 3 species, 1 target. Mostly Uncommon, 1 of 2 rare or rarer",
    );
    expect(arc.getAttribute("role")).toBe("button");
    expect(arc.parentElement!.querySelector(".fill-rarity-uncommon")).not.toBeNull();
    expect(arc.parentElement!.querySelector(".fill-accent")).not.toBeNull();
    fireEvent.mouseEnter(arc);
    const middle = container.querySelector('[aria-live="polite"]')!.textContent;
    expect(middle).toContain("3 more groups");
    expect(middle).toContain("1 of 3 species");
    expect(middle).toContain("Mostly Uncommon");
    fireEvent.click(arc);
    expect(onMore).toHaveBeenCalledWith(expect.objectContaining({ id: null, more: 3, ring: 1, outer: 3 }));
  });

  it("drops a hovered More groups arc the new tree lacks", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") }));
    const big = node("class", "Aves", 10_000, [node("order", "Passeriformes", 10_000)]);
    const withThin = indexTree([big, node("class", "Amphibia", 1, [node("order", "Anura", 1)])]);
    const { container, rerender } = render(<TreeCircle {...props} index={withThin} center={null} />);
    fireEvent.mouseEnter(container.querySelector('[aria-label^="1 more group"]')!);
    expect(container.querySelector('[aria-live="polite"]')!.textContent).toContain("1 more group");
    rerender(<TreeCircle {...props} index={indexTree([big])} center={null} />);
    expect(container.querySelector('[aria-live="polite"]')!.textContent).toContain("All groups");
  });
});
