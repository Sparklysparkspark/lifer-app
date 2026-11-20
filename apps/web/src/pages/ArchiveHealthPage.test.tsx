// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));
vi.mock("../hooks/useDeploymentMode", () => ({ useDeploymentMode: () => "server" }));

const { default: ArchiveHealthPage } = await import("./ArchiveHealthPage");
const { ToastContext } = await import("../hooks/useToast");
const { ConfirmContext } = await import("../hooks/useConfirm");
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };
const confirm = vi.fn();

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);

const item = (i: number) => ({
  id: `id-${i}`,
  path: `/data/originals/${i}.jpg`,
  problem: "missing",
  photoId: null,
  captureId: null,
  speciesId: null,
  commonName: null,
  scientificName: null,
});

function renderPage() {
  render(
    <ToastContext.Provider value={toast}>
      <ConfirmContext.Provider value={confirm}>
        <MemoryRouter>
          <ArchiveHealthPage />
        </MemoryRouter>
      </ConfirmContext.Provider>
    </ToastContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // The list shows the first 2,000 of 3,500.
  get.mockResolvedValue({ total: 3500, items: Array.from({ length: 2000 }, (_, i) => item(i)) });
  post.mockResolvedValue({ ignored: 3500 });
});
afterEach(cleanup);

describe("ArchiveHealthPage Ignore all", () => {
  it("confirms with the whole count, not just the files shown", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Ignore all" }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(String(confirm.mock.calls[0][0].title)).toContain("3,500");
  });

  it("ignores nothing when cancelled", async () => {
    confirm.mockResolvedValue(false);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Ignore all" }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(post).not.toHaveBeenCalled();
  });

  it("ignores them all and reloads the list", async () => {
    confirm.mockResolvedValue(true);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Ignore all" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/originals/health/ignore-all"));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(get).toHaveBeenCalledTimes(2);
  });
});
