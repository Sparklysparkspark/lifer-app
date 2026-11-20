// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));
vi.mock("./PhonesSettings", () => ({ default: () => null }));
vi.mock("./ConnectedAppsSettings", () => ({ default: () => null }));

const { default: IntegrationsSettings } = await import("./IntegrationsSettings");
const { ConfirmContext } = await import("../../hooks/useConfirm");
const { ToastContext } = await import("../../hooks/useToast");
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

function show() {
  render(
    <MemoryRouter>
      <ToastContext.Provider value={toast}>
        <ConfirmContext.Provider value={vi.fn().mockResolvedValue(true)}>
          <IntegrationsSettings />
        </ConfirmContext.Provider>
      </ToastContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  get.mockImplementation(async (path: string) => {
    if (path === "/inaturalist/status") return { available: false, connected: false, username: null };
    if (path === "/assistant/setup")
      return {
        available: true,
        command: "/Applications/Lifer.app/node",
        script: "/Applications/Lifer.app/mcp/lifer-mcp.mjs",
        url: "http://127.0.0.1:4310",
      };
    throw new Error(`unexpected GET ${path}`);
  });
  post.mockResolvedValue({ token: "lifer_abc123" });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("assistant setup on the desktop app", () => {
  it("makes a key with the assistant permissions and shows the config with the real paths", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Set up" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, body] = post.mock.calls[0];
    expect(path).toBe("/api-keys");
    expect(body.permissions).toEqual(
      expect.arrayContaining(["gallery.read", "species.read", "album.read", "album.write", "collection.read"]),
    );
    expect(body.permissions).not.toContain("photos.write");
    await waitFor(() => expect(document.querySelector("pre")).not.toBeNull());
    const config = JSON.parse(document.querySelector("pre")?.textContent ?? "{}");
    expect(config.mcpServers.lifer).toEqual({
      command: "/Applications/Lifer.app/node",
      args: ["/Applications/Lifer.app/mcp/lifer-mcp.mjs"],
      env: { LIFER_URL: "http://127.0.0.1:4310", LIFER_API_KEY: "lifer_abc123" },
    });
  });

  it("links to the API keys page", async () => {
    show();
    expect((await screen.findByRole("link", { name: /API keys/ })).getAttribute("href")).toBe("/settings/api-keys");
  });
});

describe("assistant setup on a server", () => {
  it("keeps the manual snippet, since the assistant runs on the owner's own computer", async () => {
    get.mockImplementation(async (path: string) => {
      if (path === "/inaturalist/status") return { available: false, connected: false, username: null };
      return { available: false, command: null, script: null, url: null };
    });
    show();
    expect(await screen.findByText(/paste your API key here/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set up" })).toBeNull();
  });
});
