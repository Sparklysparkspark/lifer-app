// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ settings: { tipsEnabled: true, tipsSeen: [] as string[] } }));
const setLocal = vi.hoisted(() => vi.fn());
vi.mock("./useSettings", () => ({ useSettings: () => ({ settings: state.settings, setLocal }) }));
vi.mock("../api/client", () => ({ api: { post: vi.fn(() => Promise.resolve({})) } }));

import { useHint } from "./useTip";

describe("useHint", () => {
  beforeEach(() => {
    state.settings = { tipsEnabled: true, tipsSeen: [] };
    setLocal.mockClear();
  });
  afterEach(cleanup);

  it("shows once the screen is usable, and is recorded as seen when dismissed", () => {
    const { result, rerender } = renderHook(({ when }) => useHint("smart-album", when), {
      initialProps: { when: false },
    });
    expect(result.current.show).toBe(false);
    rerender({ when: true });
    expect(result.current.show).toBe(true);
    act(() => result.current.dismiss());
    expect(result.current.show).toBe(false);
    expect(setLocal).toHaveBeenCalledWith({ tipsSeen: ["smart-album"] });
  });

  it("stays away once seen, and when hints are switched off", () => {
    state.settings = { tipsEnabled: true, tipsSeen: ["trip-dates"] };
    expect(renderHook(() => useHint("trip-dates", true)).result.current.show).toBe(false);
    state.settings = { tipsEnabled: false, tipsSeen: [] };
    expect(renderHook(() => useHint("similar-group", true)).result.current.show).toBe(false);
  });

  it("shows only one hint at a time", () => {
    const first = renderHook(() => useHint("smart-album", true));
    const second = renderHook(() => useHint("similar-group", true));
    expect([first.result.current.show, second.result.current.show]).toEqual([true, false]);
    first.unmount();
    expect(second.result.current.show).toBe(true);
  });
});
