// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PreviewPane from "./PreviewPane";
import { DWELL_MS, previewAfterDwell, previewNow } from "./previewStore";
import TreeCircle from "./TreeCircle";
import { indexTree, type TreeNode } from "./treeModel";

const node = (rank: TreeNode["rank"], name: string, total: number, children: TreeNode[] = []): TreeNode => ({
  rank,
  name,
  collected: 1,
  total,
  photos: 0,
  targetCount: 0,
  seenCount: 0,
  tiers: {},
  photoId: null,
  children,
});
const index = indexTree([node("class", "Aves", 40), node("class", "Mammalia", 20)]);

/** The circle beside a pane that names what it shows, as the explorer wires them. */
function Page({ selected, onPick = () => {} }: { selected: string | null; onPick?: (id: string) => void }) {
  return (
    <>
      <TreeCircle
        index={index}
        center={null}
        top={null}
        genus={false}
        selected={selected}
        label={(n) => n.name}
        onPick={onPick}
        onMore={() => {}}
        onZoomOut={null}
        onMenu={() => {}}
        rarity={false}
      />
      <output>
        <PreviewPane selected={selected} has={(id) => index.byId.has(id)} render={(id) => `preview ${id}`}>
          {`selected ${selected}`}
        </PreviewPane>
      </output>
    </>
  );
}
const pane = () => screen.getByRole("status").textContent;
const arc = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  act(() => previewNow(null));
  vi.useRealTimers();
});

describe("hover preview", () => {
  it("previews an arc once the pointer rests on it, and goes back to the selection on leaving", () => {
    render(<Page selected="class:Aves" />);
    fireEvent.pointerOver(arc("Mammalia"));
    act(() => vi.advanceTimersByTime(DWELL_MS - 1));
    expect(pane()).toBe("selected class:Aves");
    act(() => vi.advanceTimersByTime(1));
    expect(pane()).toBe("preview class:Mammalia");
    fireEvent.mouseLeave(screen.getByRole("group"));
    expect(pane()).toBe("selected class:Aves");
  });

  it("sweeping across arcs previews only the one the pointer stops on", () => {
    render(<Page selected={null} />);
    fireEvent.pointerOver(arc("Aves"));
    act(() => vi.advanceTimersByTime(DWELL_MS / 2));
    fireEvent.pointerOut(arc("Aves"));
    fireEvent.pointerOver(arc("Mammalia"));
    act(() => vi.advanceTimersByTime(DWELL_MS / 2));
    expect(pane()).toBe("selected null");
    act(() => vi.advanceTimersByTime(DWELL_MS));
    expect(pane()).toBe("preview class:Mammalia");
  });

  it("previews at once when keyboard focus moves onto an arc", () => {
    render(<Page selected={null} />);
    act(() => arc("Mammalia").focus());
    expect(pane()).toBe("preview class:Mammalia");
  });

  it("a click selects and pins, dropping the preview", () => {
    const onPick = vi.fn();
    const { rerender } = render(<Page selected={null} onPick={onPick} />);
    fireEvent.pointerOver(arc("Aves"));
    act(() => vi.advanceTimersByTime(DWELL_MS));
    fireEvent.click(arc("Aves"));
    expect(onPick).toHaveBeenCalledWith("class:Aves");
    rerender(<Page selected="class:Aves" onPick={onPick} />);
    expect(pane()).toBe("selected class:Aves");
  });

  it("touch never previews; a preview the tree no longer holds is dropped", () => {
    render(<Page selected={null} />);
    act(() => {
      previewAfterDwell("class:Aves", "touch");
      vi.advanceTimersByTime(DWELL_MS * 2);
    });
    expect(pane()).toBe("selected null");
    act(() => previewNow("class:Gone"));
    expect(pane()).toBe("selected null");
  });
});
