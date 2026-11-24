// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCollectionDisplayPrefs } from "./useCollectionDisplayPrefs";

describe("uncollectedColour pref", () => {
  beforeEach(() => localStorage.clear());

  it("is off by default, switches on and survives a remount", () => {
    const first = renderHook(() => useCollectionDisplayPrefs());
    expect(first.result.current.uncollectedColour).toBe(false);
    act(() => first.result.current.setUncollectedColour(true));
    expect(first.result.current.uncollectedColour).toBe(true);
    first.unmount();
    expect(renderHook(() => useCollectionDisplayPrefs()).result.current.uncollectedColour).toBe(true);
  });
});

describe("group progress pref", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("is on by default, switches off and survives a remount", () => {
    const first = renderHook(() => useCollectionDisplayPrefs());
    expect(first.result.current.showGroupProgress).toBe(true);
    act(() => first.result.current.setShowGroupProgress(false));
    expect(first.result.current.showGroupProgress).toBe(false);
    first.unmount();
    expect(renderHook(() => useCollectionDisplayPrefs()).result.current.showGroupProgress).toBe(false);
  });

  it("reads as on when storage is unreadable", () => {
    localStorage.setItem("lifer:collectionGroupProgressHidden", "true");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(renderHook(() => useCollectionDisplayPrefs()).result.current.showGroupProgress).toBe(true);
  });
});
