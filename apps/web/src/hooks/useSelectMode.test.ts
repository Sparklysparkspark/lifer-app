// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { pruneSelection, useSelectMode, type SelectModeOptions } from "./useSelectMode";

const id = (s: string) => s;

function setup(items: string[], options?: SelectModeOptions) {
  return renderHook(({ list, opts }) => useSelectMode(list, id, true, opts), {
    initialProps: { list: items, opts: options },
  });
}

describe("pruneSelection", () => {
  it("drops ids that are no longer shown and keeps the same Set when nothing changed", () => {
    const selected = new Set(["a", "b"]);
    expect([...pruneSelection(selected, ["b", "c"])]).toEqual(["b"]);
    expect(pruneSelection(selected, ["a", "b", "c"])).toBe(selected);
  });
});

describe("useSelectMode", () => {
  it("trims the selection to what a filter left on screen", () => {
    const { result, rerender } = setup(["a", "b", "c"], { pruneToItems: true });
    act(() => {
      result.current.toggle("a", 0, false);
      result.current.toggle("c", 2, false);
    });
    rerender({ list: ["b", "c"], opts: { pruneToItems: true } });
    expect([...result.current.selectedIds]).toEqual(["c"]);
  });

  it("keeps shift-click anchored on the same photo after the list changes", () => {
    const { result, rerender } = setup(["a", "b", "c", "d"], { pruneToItems: true });
    act(() => result.current.toggle("c", 2, false));
    rerender({ list: ["x", "c", "d"], opts: { pruneToItems: true } });
    act(() => result.current.toggle("d", 2, true));
    expect([...result.current.selectedIds].sort()).toEqual(["c", "d"]);
  });

  it("keeps ids it hasn't loaded by default, for a Select all that reaches past the page", () => {
    const { result, rerender } = setup(["a", "b"]);
    act(() => result.current.setSelectedIds(new Set(["a", "b", "z"])));
    rerender({ list: ["a"], opts: undefined });
    expect(result.current.selectedIds.size).toBe(3);
  });

  it("clears when the reset key changes, not on first render", () => {
    const { result, rerender } = setup(["a", "b"], { resetKey: "q=heron" });
    act(() => result.current.toggle("a", 0, false));
    rerender({ list: ["a", "b"], opts: { resetKey: "q=heron" } });
    expect(result.current.selectedIds.size).toBe(1);
    rerender({ list: ["a", "b"], opts: { resetKey: "q=owl" } });
    expect(result.current.selectedIds.size).toBe(0);
  });
});
