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

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LowSpaceBanner", () => {
  it("shows under the reserve with the free space, and hides when dismissed", async () => {
    post.mockResolvedValue({ tier: "tight", free: 4.2e9, toFree: 0 });
    render(<LowSpaceBanner />);
    expect(post).toHaveBeenCalledWith("/uploads/space", { files: 0, bytes: 0 });
    expect(await screen.findByText(/Your disk is nearly full \(4\.2 GB free\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/Your disk is nearly full/)).toBeNull();
    expect(localStorage.getItem("lifer:lowSpaceDismissed")).toContain("4200000000");
  });

  it("stays dismissed across a remount and a poll, and returns only when much fuller, critical or after 7 days", async () => {
    post.mockResolvedValue({ tier: "tight", free: 40e9, volume: 7, toFree: 0 });
    const first = render(<LowSpaceBanner />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    first.unmount();
    render(<LowSpaceBanner />);
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Your disk is nearly full/)).toBeNull();
    cleanup();

    post.mockResolvedValue({ tier: "tight", free: 25e9, volume: 7, toFree: 0 });
    render(<LowSpaceBanner />);
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(3));
    expect(screen.queryByText(/Your disk is nearly full/)).toBeNull();
    cleanup();

    post.mockResolvedValue({ tier: "critical", free: 4e9, volume: 7, toFree: 1e9 });
    render(<LowSpaceBanner />);
    expect(await screen.findByText(/Your disk is nearly full \(4 GB free\)/)).toBeTruthy();
  });

  it("returns after 7 days", async () => {
    post.mockResolvedValue({ tier: "tight", free: 40e9, volume: 7, toFree: 0 });
    vi.useFakeTimers({ toFake: ["Date"] });
    const first = render(<LowSpaceBanner />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    first.unmount();
    vi.setSystemTime(Date.now() + 8 * 24 * 3600_000);
    render(<LowSpaceBanner />);
    expect(await screen.findByText(/Your disk is nearly full/)).toBeTruthy();
    vi.useRealTimers();
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
