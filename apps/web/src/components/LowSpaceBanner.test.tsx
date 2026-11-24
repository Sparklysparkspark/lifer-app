// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../i18n";
import LowSpaceBanner from "./LowSpaceBanner";

const post = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: { post: (...a: unknown[]) => post(...a) },
}));

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LowSpaceBanner", () => {
  it("shows under the reserve with the free space, and hides for the session when dismissed", async () => {
    post.mockResolvedValue({ tier: "tight", free: 4.2e9, toFree: 0 });
    render(<LowSpaceBanner />);
    expect(post).toHaveBeenCalledWith("/uploads/space", { files: 0, bytes: 0 });
    expect(await screen.findByText(/Your disk is nearly full \(4\.2 GB free\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide until next launch" }));
    expect(screen.queryByText(/Your disk is nearly full/)).toBeNull();
    expect(sessionStorage.getItem("lifer-low-space-dismissed")).toBe("1");
  });

  it("says nothing with room, or when the check fails", async () => {
    post.mockResolvedValueOnce({ tier: "ok", free: 400e9, toFree: 0 });
    const { container, unmount } = render(<LowSpaceBanner />);
    await vi.waitFor(() => expect(post).toHaveBeenCalled());
    expect(container.textContent).toBe("");
    unmount();
    post.mockRejectedValueOnce(new Error("offline"));
    const second = render(<LowSpaceBanner />);
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(second.container.textContent).toBe("");
  });
});
