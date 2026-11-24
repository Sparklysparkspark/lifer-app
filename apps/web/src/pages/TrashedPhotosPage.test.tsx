// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", NoopObserver);
vi.stubGlobal("IntersectionObserver", NoopObserver);

const { default: TrashedPhotosPage } = await import("./TrashedPhotosPage");
const { ToastContext } = await import("../hooks/useToast");

const inAWeek = new Date(Date.now() + 6.5 * 24 * 60 * 60 * 1000).toISOString();
const trashed = (id: string, over: Record<string, unknown> = {}) => ({
  captureId: `c-${id}`,
  speciesId: `s-${id}`,
  speciesName: `Species ${id}`,
  deletedAt: "2026-11-20T00:00:00.000Z",
  pendingDeleteRaw: false,
  photoId: `p-${id}`,
  width: 3,
  height: 2,
  hasRawOriginal: false,
  kind: "image",
  durationSeconds: null,
  originalKind: "jpeg",
  purgesAt: inAWeek,
  ...over,
});

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

function renderTrash(items: unknown[]) {
  get.mockResolvedValue({ retentionDays: 7, items });
  return render(
    <ToastContext.Provider value={toast}>
      <MemoryRouter>
        <TrashedPhotosPage />
      </MemoryRouter>
    </ToastContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  post.mockResolvedValue({});
});
afterEach(cleanup);

describe("TrashedPhotosPage", () => {
  it("restores only the selected photos still shown in one request, then says where they went", async () => {
    post.mockResolvedValueOnce({ restored: 1, skipped: 0 });
    renderTrash([trashed("a"), trashed("v", { kind: "video" })]);
    await screen.findAllByRole("img");
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByText("2 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Video/ }));
    expect(await screen.findByText("1 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore selected" }));
    await waitFor(() => expect(toast.show).toHaveBeenCalled());
    expect(post.mock.calls).toEqual([["/trash/restore", { captureIds: ["c-v"] }]]);
    const [message, opts] = toast.show.mock.calls[0] as [string, { actions: Array<{ label: string }> }];
    expect(message).toBe("Restored 1 photo");
    expect(opts.actions.map((a) => a.label)).toEqual(["View"]);
  });

  it("restores a big selection in requests of 500, and counts a failed one", async () => {
    renderTrash(Array.from({ length: 501 }, (_, i) => trashed(String(i))));
    await screen.findAllByRole("img");
    post.mockResolvedValueOnce({ restored: 500, skipped: 0 }).mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore selected" }));
    await waitFor(() => expect(toast.show).toHaveBeenCalled());
    expect(post.mock.calls.map((c) => (c[1] as { captureIds: string[] }).captureIds.length)).toEqual([500, 1]);
    expect(toast.error).toHaveBeenCalledWith("Couldn't restore 1 photo. Try again.");
    expect(toast.show.mock.calls[0][0]).toBe("Restored 500 photos");
  });

  it("opens the menu of a tile with no photo file, since there's nothing to show full size", async () => {
    renderTrash([trashed("x", { photoId: null })]);
    const [tile] = await screen.findAllByTestId("photo-tile");
    fireEvent.click(tile.querySelector("button")!);
    expect(await screen.findByRole("menuitem", { name: "Restore" })).toBeTruthy();
  });

  it("names what happens to a RAW in one locale-joined line", async () => {
    localStorage.setItem("lifer:showPhotoLabels", "true");
    renderTrash([trashed("r", { hasRawOriginal: true, pendingDeleteRaw: true })]);
    expect(await screen.findByText(/^7 days left.+RAW will also be deleted$/)).toBeTruthy();
  });
});
