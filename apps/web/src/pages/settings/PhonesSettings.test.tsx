// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    delete: (...a: unknown[]) => del(...a),
  },
}));

let mode: "desktop" | "server" = "server";
vi.mock("../../hooks/useDeploymentMode", () => ({ useDeploymentMode: () => mode }));
const invoke = vi.fn();
let inShell = false;
vi.mock("../../lib/tauri", () => ({ tauriInvoke: () => (inShell ? invoke : null) }));

const { default: PhonesSettings } = await import("./PhonesSettings");
const { ConfirmContext } = await import("../../hooks/useConfirm");
const { ToastContext } = await import("../../hooks/useToast");
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

const phone = (i: number, name = `Phone ${i}`) => ({
  id: `p${i}`,
  name,
  platform: "ios",
  lastUsedAt: i % 2 ? "2026-06-01T00:00:00Z" : null,
  createdAt: "2026-05-01T00:00:00Z",
});

function show(phones: object[]) {
  get.mockResolvedValue({ devices: phones });
  render(
    <ToastContext.Provider value={toast}>
      <ConfirmContext.Provider value={vi.fn().mockResolvedValue(true)}>
        <PhonesSettings />
      </ConfirmContext.Provider>
    </ToastContext.Provider>,
  );
}

const code = (ms = 300_000) => ({
  code: "482913",
  payload: '{"v":1}',
  expiresAt: new Date(Date.now() + ms).toISOString(),
});

beforeEach(() => {
  vi.clearAllMocks();
  mode = "server";
  inShell = false;
  invoke.mockImplementation(async (cmd: string) =>
    cmd === "companion_status"
      ? { keepSyncing: true, lastSyncedAt: null, autostart: false }
      : cmd === "companion_open_pairing"
        ? { addresses: ["192.168.1.20:4311"], certSha256: "a".repeat(64) }
        : undefined,
  );
});
afterEach(cleanup);

describe("PhonesSettings", () => {
  it("says so when no phone is paired", async () => {
    show([]);
    expect(await screen.findByText("No phone is paired yet.")).toBeTruthy();
  });

  it("removes a phone after confirming", async () => {
    show([phone(1)]);
    expect(await screen.findByText("Phone 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/companion/v1/devices/p1"));
  });

  it("holds 20 phones and a 60-character name without dropping any", async () => {
    show(Array.from({ length: 20 }, (_, i) => phone(i, i === 0 ? "n".repeat(60) : undefined)));
    await screen.findByText("Phone 19");
    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(20);
    expect(screen.getByTitle("n".repeat(60)).className).toContain("truncate");
  });

  it("shows a server pairing code with the page's own address and no certificate", async () => {
    post.mockResolvedValue(code());
    show([]);
    await screen.findByText("No phone is paired yet.");
    fireEvent.click(screen.getByRole("button", { name: "Connect a phone" }));
    expect(await screen.findByAltText("Pairing code to scan with Lifer on your phone")).toBeTruthy();
    expect(post).toHaveBeenCalledWith("/companion/v1/pair-codes", {
      addresses: [window.location.origin],
      certSha256: undefined,
    });
    expect(screen.getByText(/Valid for 4:5\d|Valid for 5:00/)).toBeTruthy();
    // The same code to type, grouped, and read digit by digit.
    expect(screen.getByLabelText("Code 4 8 2 9 1 3").textContent).toBe("482 913");
  });

  it("on the desktop asks the shell for addresses and the certificate, and asks it to recheck pairing", async () => {
    mode = "desktop";
    inShell = true;
    post.mockResolvedValue(code());
    show([phone(1)]);
    await screen.findByText("Phone 1");
    expect(invoke).toHaveBeenCalledWith("companion_set_paired");
    fireEvent.click(screen.getByRole("button", { name: "Connect a phone" }));
    await screen.findByAltText("Pairing code to scan with Lifer on your phone");
    expect(post).toHaveBeenCalledWith("/companion/v1/pair-codes", {
      addresses: ["192.168.1.20:4311"],
      certSha256: "a".repeat(64),
    });
  });

  it("offers a new code once the old one has expired", async () => {
    post.mockResolvedValueOnce(code(1500)).mockResolvedValueOnce(code());
    show([]);
    await screen.findByText("No phone is paired yet.");
    fireEvent.click(screen.getByRole("button", { name: "Connect a phone" }));
    await screen.findByAltText("Pairing code to scan with Lifer on your phone");
    expect(await screen.findByText("This code has expired.", {}, { timeout: 4000 })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show a new code" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("This code has expired.")).toBeNull());
  });

  it("confirms when a new phone appears while the code is showing", async () => {
    post.mockResolvedValue(code());
    show([phone(1)]);
    await screen.findByText("Phone 1");
    fireEvent.click(screen.getByRole("button", { name: "Connect a phone" }));
    await screen.findByAltText("Pairing code to scan with Lifer on your phone");
    get.mockResolvedValue({ devices: [phone(2, "Sam's iPhone"), phone(1)] });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 3200));
    });
    expect(await screen.findByText("Sam's iPhone is paired")).toBeTruthy();
    expect(screen.queryByAltText("Pairing code to scan with Lifer on your phone")).toBeNull();
  });

  it("shows the keep-syncing and start-at-login switches only on the desktop's own library", async () => {
    show([]);
    await screen.findByText("No phone is paired yet.");
    expect(screen.queryByRole("switch")).toBeNull();
    cleanup();
    mode = "desktop";
    inShell = true;
    show([]);
    const keep = await screen.findByRole("switch", { name: "Keep syncing with your phone when Lifer is closed" });
    expect(keep.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "Start at login" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(keep);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("companion_set_keep_syncing", { enabled: false }));
  });

  it("says phones pair with the server when a linked desktop shows the server's page", async () => {
    inShell = true;
    show([]);
    expect(await screen.findByText("Your phone connects to your server")).toBeTruthy();
  });
});
