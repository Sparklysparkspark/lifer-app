// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const post = vi.fn();
const get = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));
const toast = { show: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() };
vi.mock("../hooks/useToast", () => ({ useToast: () => toast }));
const pick = vi.fn(async (_start?: string): Promise<string | null> => null);
vi.mock("../lib/pickFolderNative", () => ({ pickFolderNative: (start?: string) => pick(start) }));

const { default: MovedPhotosTray } = await import("./MovedPhotosTray");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const idle = {
  running: false,
  phase: null,
  processed: null,
  total: null,
  error: null,
  cancelled: false,
  cancelRequested: false,
  result: null,
  manual: false,
  reviewCount: 0,
};

describe("MovedPhotosTray", () => {
  it("shows one quiet toast for relinked photos, whose Undo puts them back", async () => {
    get.mockResolvedValue({ ...idle, notice: { batchId: "b1", count: 3 }, proposals: [] });
    post.mockResolvedValue({ ok: true, undone: true });
    render(
      <MemoryRouter>
        <MovedPhotosTray />
      </MemoryRouter>,
    );
    await waitFor(() => expect(toast.show).toHaveBeenCalledTimes(1));
    const [message, options] = toast.show.mock.calls[0];
    expect(message).toBe("Found 3 moved photos");
    // Marked as shown, so it isn't shown again.
    expect(post).toHaveBeenCalledWith("/moved-photos/ack", { batchIds: ["b1"], tripIds: [] });
    options.actions.find((a: { label: string }) => a.label === "Undo").onClick();
    await waitFor(() => expect(post).toHaveBeenCalledWith("/moved-photos/batches/b1/undo"));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith("Put back where it was"));
  });

  it("offers a trip's moved folder with Use it and Not now", async () => {
    get.mockResolvedValue({
      ...idle,
      notice: null,
      proposals: [{ tripId: "t1", tripName: "Belize", folder: "/P/Belize 2026", found: 3, total: 3, announced: false }],
    });
    post.mockResolvedValue({ batchId: "b2", count: 0 });
    render(
      <MemoryRouter>
        <MovedPhotosTray />
      </MemoryRouter>,
    );
    await waitFor(() => expect(toast.show).toHaveBeenCalledTimes(1));
    const [message, options] = toast.show.mock.calls[0];
    expect(message).toBe("The Belize folder moved to /P/Belize 2026. Use it?");
    expect(options.durationMs).toBeNull();
    expect(options.actions.map((a: { label: string }) => a.label)).toEqual(["Use it", "Not now"]);
    options.actions[0].onClick();
    await waitFor(() => expect(post).toHaveBeenCalledWith("/moved-photos/trip-folders/t1/use"));
  });

  it("after a look that found nothing, offers to add where the missing photos' folder went", async () => {
    const { MOVED_PHOTOS_LOOK_STARTED } = await import("../hooks/useMovedPhotos");
    const running = { ...idle, running: true, manual: true, notice: null, proposals: [] };
    get.mockResolvedValueOnce(running);
    get.mockResolvedValue({
      ...running,
      running: false,
      result: { relinked: 0, proposals: 0, review: 0, unreadableFolders: 0, missingFolder: "/Users/ana/Trips/Belize" },
    });
    render(
      <MemoryRouter>
        <MovedPhotosTray />
      </MemoryRouter>,
    );
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new Event(MOVED_PHOTOS_LOOK_STARTED));
    await waitFor(() => expect(toast.show).toHaveBeenCalledTimes(1));
    const [message, options] = toast.show.mock.calls[0];
    expect(message).toBe(
      "No moved photos found. Moved a folder? Add its new parent folder so Lifer can find your photos again.",
    );
    pick.mockResolvedValueOnce("/Volumes/home/Trips");
    post.mockResolvedValue({ added: true, path: "/Volumes/home/Trips", coveredBy: null, contains: [], started: true });
    options.actions[0].onClick();
    await waitFor(() => expect(post).toHaveBeenCalledWith("/moved-photos/look", { manual: true }));
    expect(pick).toHaveBeenCalledWith("/Users/ana/Trips");
  });
});
