// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RemoteState } from "../../lib/packIndex";

let connection: RemoteState = "offline";
vi.mock("../../lib/packIndex", () => ({ useConnection: () => connection }));
vi.mock("../../api/client", () => ({ api: { get: () => Promise.reject(new Error("getaddrinfo ENOTFOUND")) } }));
vi.mock("../../hooks/useJobPoll", () => ({
  useJobPoll: () => ({ status: null, loadError: "none", actionError: null, starting: false, cancelling: false }),
}));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => async () => false }));

const { default: OfflineDataSettings } = await import("./OfflineDataSettings");

describe("Species catalog row", () => {
  it("says it's offline instead of showing the raw error, and can still check again", async () => {
    connection = "offline";
    render(<OfflineDataSettings />);
    expect(await screen.findByText(/You're offline/)).toBeTruthy();
    expect(screen.queryByText(/ENOTFOUND/)).toBeNull();
    expect((screen.getByRole("button", { name: "Check again" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the error when online", async () => {
    connection = "online";
    render(<OfflineDataSettings />);
    expect(await screen.findByText(/ENOTFOUND/)).toBeTruthy();
    expect(screen.queryByText(/You're offline/)).toBeNull();
  });
});
