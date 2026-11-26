// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";

const press = (init: KeyboardEventInit) => window.dispatchEvent(new KeyboardEvent("keydown", init));

describe("useKeyboardShortcuts on an embedded app's page", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("ignores gallery keys there and keeps app-wide ones", () => {
    const trash = vi.fn();
    const selectAll = vi.fn();
    const shortcuts = vi.fn();
    renderHook(() => useKeyboardShortcuts({ trash, selectAll, shortcuts }));
    window.history.replaceState(null, "", "/apps/example.app");
    press({ key: "Backspace", code: "Backspace", metaKey: true, ctrlKey: true });
    press({ key: "Delete", code: "Delete" });
    press({ key: "a", code: "KeyA", metaKey: true, ctrlKey: true });
    press({ key: "?", code: "Slash", shiftKey: true });
    expect(trash).not.toHaveBeenCalled();
    expect(selectAll).not.toHaveBeenCalled();
    expect(shortcuts).toHaveBeenCalledTimes(1);
    window.history.replaceState(null, "", "/gallery");
    press({ key: "Delete", code: "Delete" });
    expect(trash).toHaveBeenCalledTimes(1);
  });
});
