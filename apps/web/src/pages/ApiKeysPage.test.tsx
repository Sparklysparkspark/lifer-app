// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "../components/ConfirmProvider";
import { ToastProvider } from "../components/ToastProvider";

const get = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a), post: vi.fn(), delete: vi.fn() },
}));

const { default: ApiKeysPage } = await import("./ApiKeysPage");

const key = (id: string, permissions: string[], pluginId: string | null = null) => ({
  id,
  name: `Key ${id}`,
  permissions,
  pluginId,
  lastUsedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
});

function renderPage() {
  render(
    <MemoryRouter>
      <ToastProvider>
        <ConfirmProvider>
          <ApiKeysPage />
        </ConfirmProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => get.mockReset());

describe("ApiKeysPage", () => {
  it("lists only hand-made keys, with permissions in words", async () => {
    get.mockResolvedValue({
      keys: [
        key("mine", ["album.write", "gallery.read"]),
        key("desk", ["sync", "photos.read"]),
        key("phone", ["companion"]),
        key("app", ["userdata.read"], "com.example.app"),
      ],
    });
    renderPage();
    expect(await screen.findByText("Key mine")).toBeTruthy();
    expect(screen.getByText("Albums: Write, Gallery: Read")).toBeTruthy();
    expect(screen.queryByText("Key desk")).toBeNull();
    expect(screen.queryByText("Key phone")).toBeNull();
    expect(screen.queryByText("Key app")).toBeNull();
  });

  it("offers New key from the empty state", async () => {
    get.mockResolvedValue({ keys: [] });
    renderPage();
    await screen.findByText("No API keys yet");
    const buttons = screen.getAllByRole("button", { name: "New key" });
    fireEvent.click(buttons[buttons.length - 1]);
    expect(await screen.findByRole("button", { name: "Create key" })).toBeTruthy();
    expect(screen.queryByText("No API keys yet")).toBeNull();
  });
});
