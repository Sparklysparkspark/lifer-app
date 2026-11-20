// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
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
