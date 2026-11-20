// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const del = vi.fn();
const put = vi.fn();
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: {
    get: (...a: unknown[]) => get(...a),
    delete: (...a: unknown[]) => del(...a),
    put: (...a: unknown[]) => put(...a),
    post: vi.fn(),
  },
}));
vi.mock("../../hooks/useDeploymentMode", () => ({ useDeploymentMode: () => "desktop" }));
const plugin = {
  id: "com.example.birds",
  name: "Example Birds",
  page: { label: "Birds", icon: "", accent: "", surface: "default" },
  scopes: ["userdata.read"],
  capabilities: ["notifications"],
  approved: true,
};
vi.mock("../../lib/plugins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/plugins")>()),
  usePlugins: () => [plugin],
}));

const { default: ConnectedAppsSettings } = await import("./ConnectedAppsSettings");
const { noticesAllowed } = await import("../../lib/plugins");
const { ConfirmContext } = await import("../../hooks/useConfirm");
const { ToastContext } = await import("../../hooks/useToast");
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };
const confirm = vi.fn();

function show() {
  render(
    <MemoryRouter>
      <ToastContext.Provider value={toast}>
        <ConfirmContext.Provider value={confirm}>
          <ConnectedAppsSettings />
        </ConfirmContext.Provider>
      </ToastContext.Provider>
    </MemoryRouter>,
  );
}

const keys = [
  { id: "k1", name: "Example Birds", pluginId: plugin.id, permissions: ["userdata.read"], lastUsedAt: null },
  { id: "k2", name: "Other", pluginId: "com.example.other", permissions: ["userdata.read"], lastUsedAt: null },
];

beforeEach(() => {
  localStorage.clear();
  get.mockImplementation(async (path: string) => {
    if (path === "/api-keys") return { keys };
    if (path === "/changes/apps") return { changes: [] };
    if (path === "/plugins/v1/grants") return { grants: [] };
    throw new Error(`unexpected GET ${path}`);
  });
  del.mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("installed apps on the desktop", () => {
  it("turns an app's notices off and on", async () => {
    show();
    const notices = await screen.findByRole("switch", { name: "Notices from Example Birds" });
    expect(notices.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(notices);
    expect(noticesAllowed(plugin.id)).toBe(false);
    fireEvent.click(notices);
    expect(noticesAllowed(plugin.id)).toBe(true);
  });

  it("Remove confirms, then revokes only that app's keys and hides it", async () => {
    confirm.mockResolvedValue(true);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Remove Example Birds" }));
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
    expect(del).toHaveBeenCalledWith("/api-keys/k1");
    const sidebar = screen.getByRole("switch", { name: "Show Example Birds in the sidebar" });
    await waitFor(() => expect(sidebar.getAttribute("aria-checked")).toBe("false"));
  });

  it("Remove does nothing when cancelled", async () => {
    confirm.mockResolvedValue(false);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Remove Example Birds" }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(del).not.toHaveBeenCalled();
    const sidebar = screen.getByRole("switch", { name: "Show Example Birds in the sidebar" });
    expect(sidebar.getAttribute("aria-checked")).toBe("true");
  });
});

describe("open inside Lifer", () => {
  it("shows a switch only for apps that may ask, and the person can turn it off", async () => {
    plugin.capabilities.push("host.preference");
    const asker = keys[0];
    get.mockImplementation(async (path: string) => {
      if (path === "/api-keys") return { keys: [asker, keys[1]] };
      if (path === "/changes/apps") return { changes: [] };
      if (path === `/plugins/v1/apps/${plugin.id}/host-preference`) return { openInHost: true };
      throw new Error(`unexpected GET ${path}`);
    });
    put.mockResolvedValue({ openInHost: false });
    const pushed: unknown[] = [];
    const { onHostPreference } = await import("../../lib/hostPreference");
    const off = onHostPreference(plugin.id, (p) => pushed.push(p));
    show();
    const sw = await screen.findByRole("switch", { name: "Open Example Birds inside Lifer" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("switch", { name: "Open Other inside Lifer" })).toBeNull();
    fireEvent.click(sw);
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(`/plugins/v1/apps/${plugin.id}/host-preference`, { openInHost: false }),
    );
    expect(sw.getAttribute("aria-checked")).toBe("false");
    // The app's frame hears host.preference.changed.
    await waitFor(() => expect(pushed).toEqual([{ openInHost: false }]));
    off();
    plugin.capabilities.pop();
  });
});

describe("apps allowed from Lifer", () => {
  it("lists one waiting to connect, and Cancel withdraws it", async () => {
    let grants = [
      { pluginId: "com.example.new", name: "New App", scopes: ["userdata.read"], expiresAt: "2026-01-01T00:00:00Z" },
    ];
    get.mockImplementation(async (path: string) => {
      if (path === "/api-keys") return { keys: [] };
      if (path === "/changes/apps") return { changes: [] };
      if (path === "/plugins/v1/grants") return { grants };
      throw new Error(`unexpected GET ${path}`);
    });
    del.mockImplementation(async () => {
      grants = [];
      return { ok: true };
    });
    show();
    expect(await screen.findByText("Allowed. Connects the first time you open it from Lifer.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel allowing New App" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/plugins/v1/grants/com.example.new"));
    await waitFor(() => expect(screen.queryByText("New App")).toBeNull());
  });
});
