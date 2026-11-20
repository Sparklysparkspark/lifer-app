// @vitest-environment jsdom
// One connection state for every download screen: "slow" from a late server, "offline" only from
// this computer's own signal or a host that couldn't be reached.
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a) },
}));
const { useConnection } = await import("./packIndex");
const { resetAccountCaches } = await import("./resource");

afterEach(() => {
  resetAccountCaches();
  vi.restoreAllMocks();
});

describe("useConnection", () => {
  it("reports slow from the server, and offline only when the computer says so", async () => {
    get.mockResolvedValue({ generatedAt: "", remote: "slow", packs: [], freeBytes: null });
    const { result } = renderHook(() => useConnection());
    await waitFor(() => expect(result.current).toBe("slow"));

    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(result.current).toBe("offline");
  });
});
