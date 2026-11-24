// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ReviewRowBase } from "./useImportReview";
import { isMac } from "../../lib/platform";

vi.mock("../../lib/speciesName", () => ({ useSpeciesName: () => (s: { commonName?: string }) => s.commonName ?? "" }));
const { useImportReview } = await import("./useImportReview");

const sp = (id: string) => ({ id, commonName: id, scientificName: id, score: 0.5 }) as never;
const row = (key: string, suggestions = [sp(`${key}-a`), sp(`${key}-b`)]): ReviewRowBase => ({
  key,
  speciesId: null,
  speciesLabel: null,
  suggestions,
});

function setup(initial: ReviewRowBase[]) {
  return renderHook(() => {
    const [rows, setRows] = useState(initial);
    return { rows, ...useImportReview(rows, setRows, { enterStartsImport: false }) };
  });
}

const press = (key: string) => act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key })));

describe("useImportReview", () => {
  it("unticking a photo whose species was confirmed reopens its suggestions", () => {
    const { result } = setup([row("p1"), row("p2")]);
    press("ArrowRight");
    press("Enter");
    expect(result.current.rows[0].speciesId).toBe("p1-b");
    expect(result.current.selected.has("p1")).toBe(true);

    act(() => result.current.toggleSelected("p1"));
    expect(result.current.selected.has("p1")).toBe(false);
    expect(result.current.rows[0].speciesId).toBeNull();
    // It's the row the keys act on again, with the earlier pick still highlighted.
    expect(result.current.activeRow?.key).toBe("p1");
    expect(result.current.highlightIndex).toBe(1);
  });

  it("ticking a photo without a species only selects it", () => {
    const { result } = setup([row("p1")]);
    act(() => result.current.toggleSelected("p1"));
    act(() => result.current.toggleSelected("p1"));
    expect(result.current.selected.size).toBe(0);
    expect(result.current.rows[0].speciesId).toBeNull();
  });

  it("bulk assign skips ticked photos that are already confirmed", () => {
    const { result } = setup([row("p1"), row("p2"), row("p3")]);
    press("Enter");
    act(() => result.current.toggleSelected("p3"));
    expect([...result.current.selected].sort()).toEqual(["p1", "p3"]);
    expect(result.current.bulkKeys).toEqual(["p3"]);
    act(() => result.current.assignSpecies(result.current.bulkKeys, sp("x") as never));
    expect(result.current.bulkKeys).toEqual([]);
    expect(result.current.rows[0].speciesId).toBe("p1-a");
  });

  it("Up and Down move between photos when nothing is highlighted", () => {
    const { result } = setup([row("p1", []), row("p2", []), row("p3", [])]);
    expect(result.current.activeRow?.key).toBe("p1");
    press("ArrowDown");
    expect(result.current.activeRow?.key).toBe("p2");
    press("ArrowDown");
    press("ArrowDown");
    expect(result.current.activeRow?.key).toBe("p3");
    press("ArrowUp");
    expect(result.current.activeRow?.key).toBe("p2");
  });

  it("Down moves on from a photo whose suggestion was confirmed when every photo has a species", () => {
    const { result } = setup([row("p1"), row("p2")]);
    press("Enter");
    press("Enter");
    expect(result.current.activeRow).toBeUndefined();
    press("ArrowDown");
    expect(result.current.activeRow?.key).toBe("p1");
    // Enter on a photo with nothing highlighted opens its species box.
    press("Enter");
    expect(result.current.focusedRowKey).toBe("p1");
  });

  it("Up and Down move between photos and never confirm the highlighted suggestion", () => {
    const { result } = setup([row("p1"), row("p2"), row("p3")]);
    press("ArrowRight");
    expect(result.current.highlightIndex).toBe(1);
    press("ArrowDown");
    expect(result.current.activeRow?.key).toBe("p2");
    press("ArrowUp");
    expect(result.current.activeRow?.key).toBe("p1");
    expect(result.current.rows.every((r) => r.speciesId === null)).toBe(true);
  });

  it("1 to 5 highlight a suggestion, and Enter confirms it and moves to the next photo to confirm", () => {
    const { result } = setup([row("p1"), row("p2", []), row("p3")]);
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "2", code: "Digit2" })));
    expect(result.current.highlightIndex).toBe(1);
    press("Enter");
    expect(result.current.rows[0].speciesId).toBe("p1-b");
    expect(result.current.activeRow?.key).toBe("p2");
  });

  it("Backspace clears a species and Mod+Z undoes the last confirm or clear", () => {
    const { result } = setup([row("p1"), row("p2")]);
    const mod = (key: string) =>
      act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key, metaKey: isMac, ctrlKey: !isMac })));
    press("ArrowRight");
    press("Enter");
    mod("z");
    expect(result.current.rows[0].speciesId).toBeNull();
    expect(result.current.activeRow?.key).toBe("p1");
    expect(result.current.highlightIndex).toBe(1);
    press("Enter");
    press("ArrowUp");
    expect(result.current.activeRow?.key).toBe("p1");
    press("Backspace");
    expect(result.current.rows[0].speciesId).toBeNull();
    mod("z");
    expect(result.current.rows[0].speciesId).toBe("p1-b");
  });

  it("Mod+Backspace leaves a photo out as having no animal and moves on; Mod+Z brings it back", () => {
    const { result } = setup([row("p1"), row("p2")]);
    const mod = (key: string) =>
      act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key, metaKey: isMac, ctrlKey: !isMac })));
    mod("Backspace");
    expect(result.current.rows[0].notWildlife).toEqual({ looksLike: "", marked: true });
    expect(result.current.activeRow?.key).toBe("p2");
    mod("z");
    expect(result.current.rows[0].notWildlife).toBeUndefined();
    expect(result.current.activeRow?.key).toBe("p1");
  });

  it("a 'maybe' photo stays in the list; Not wildlife leaves it out with what it looked like, Keep drops the question", () => {
    const maybe = { looksLike: "a landscape", share: 0.6 };
    const { result } = setup([
      { ...row("p1"), maybeNotWildlife: maybe },
      { ...row("p2"), maybeNotWildlife: maybe },
    ]);
    expect(result.current.activeRow?.key).toBe("p1");
    act(() => result.current.markNoAnimal(["p1"]));
    expect(result.current.rows[0].notWildlife).toEqual({ looksLike: "a landscape", marked: true });
    expect(result.current.rows[0].maybeNotWildlife).toBeNull();
    act(() => result.current.dismissWarning("p2", "maybeNotWildlife"));
    expect(result.current.rows[1].maybeNotWildlife).toBeNull();
    expect(result.current.rows[1].notWildlife).toBeUndefined();
  });

  it("C opens compare on the photo the keys act on, and the review keys wait while it's open", () => {
    const { result } = setup([row("p1"), row("p2")]);
    press("c");
    expect(result.current.compare).toEqual({ key: "p1", group: null, speciesId: undefined });
    press("Enter");
    press("ArrowDown");
    expect(result.current.rows[0].speciesId).toBeNull();
    expect(result.current.highlightIndex).toBe(0);
    act(() => result.current.closeCompare());
    press("Enter");
    expect(result.current.rows[0].speciesId).toBe("p1-a");
  });

  it("a ticked photo compares together with the other ticked photos still to confirm", () => {
    const { result } = setup([row("p1"), row("p2"), row("p3")]);
    act(() => result.current.toggleSelected("p1"));
    act(() => result.current.toggleSelected("p3"));
    act(() => result.current.openCompare("p3", "p3-b"));
    expect(result.current.compare).toEqual({ key: "p3", group: ["p1", "p3"], speciesId: "p3-b" });
    act(() => result.current.openCompare("p2"));
    expect(result.current.compare?.group).toBeNull();
  });

  it("passes imported photos by: no keys, ticks, bulk picks or clearing reach them", () => {
    const done = { ...row("p1"), speciesId: "p1-a", speciesLabel: "p1-a", locked: true };
    const { result } = setup([done, row("p2")]);
    expect(result.current.activeRow?.key).toBe("p2");
    press("ArrowUp");
    expect(result.current.activeRow?.key).toBe("p2");
    act(() => result.current.toggleSelected("p1"));
    expect(result.current.rows[0].speciesId).toBe("p1-a");
    act(() => result.current.toggleSelected("p2"));
    act(() => result.current.assignSpecies(["p1", "p2"], sp("x") as never));
    expect(result.current.rows[0].speciesId).toBe("p1-a");
    expect(result.current.rows[1].speciesId).toBe("x");
    act(() => result.current.markNoAnimal(["p1"]));
    expect(result.current.rows[0].notWildlife).toBeUndefined();
  });
});
