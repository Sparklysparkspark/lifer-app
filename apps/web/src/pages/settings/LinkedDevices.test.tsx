// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const del = vi.fn();
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a), delete: (...a: unknown[]) => del(...a) },
}));

const { default: LinkedDevices } = await import("./LinkedDevices");
const { ConfirmContext } = await import("../../hooks/useConfirm");
const { ToastContext } = await import("../../hooks/useToast");
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

const key = (i: number, permissions: string[], lastUsedAt: string | null = null) => ({
  id: `k${i}`,
  name: i === 0 ? "x".repeat(300) : `Desktop app ${i}`,
  permissions,
  lastUsedAt,
  createdAt: "2026-05-01T00:00:00Z",
});

function show(keys: object[]) {
  get.mockResolvedValue({ keys });
  render(
    <ToastContext.Provider value={toast}>
      <ConfirmContext.Provider value={vi.fn().mockResolvedValue(true)}>
        <LinkedDevices />
      </ConfirmContext.Provider>
    </ToastContext.Provider>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("LinkedDevices", () => {
  it("says so when nothing is linked, and ignores keys that aren't desktop links", async () => {
    show([key(1, ["gallery.read"])]);
    expect(await screen.findByText("No desktop app is linked to this server yet.")).toBeTruthy();
    expect(screen.queryByText("Desktop app 1")).toBeNull();
  });

  it("lists one device and revokes it after confirming", async () => {
    show([key(1, ["sync", "photos.read"], "2026-06-01T00:00:00Z")]);
    expect(await screen.findByText("Desktop app 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/api-keys/k1"));
  });

  it("holds 30 devices and a 300-character name", async () => {
    show(Array.from({ length: 30 }, (_, i) => key(i, ["sync"])));
    await screen.findByText("Desktop app 29");
    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(30);
  });
});
