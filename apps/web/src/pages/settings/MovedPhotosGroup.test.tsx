// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const post = vi.fn();
const get = vi.fn();
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), put: vi.fn() },
}));
const toast = { show: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() };
vi.mock("../../hooks/useToast", () => ({ useToast: () => toast }));
// The picker falls back to the in-app browser outside the desktop app; not needed here.
vi.mock("../../lib/pickFolderNative", () => ({ pickFolderNative: async () => null }));

const { default: MovedPhotosGroup } = await import("./MovedPhotosGroup");
const { default: MovedPhotosReview } = await import("../../components/MovedPhotosReview");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const STATUS = {
  running: false,
  manual: false,
  notice: null,
  reviewCount: 2,
  proposals: [{ tripId: "t1", tripName: "Belize", folder: "/Photos/Belize 2026", found: 3, total: 3, announced: true }],
};

function answer(routes: Record<string, unknown>) {
  get.mockImplementation(async (url: string) => routes[url]);
}

describe("Settings > Storage > Moved photos", () => {
  it("lists the places, what's always included, and removes one", async () => {
    answer({
      "/moved-photos/settings": {
        auto: true,
        library: "/Lifer",
        tripFolders: 4,
        watched: [],
        places: [
          { path: "/Volumes/Photos/2025", available: true },
          { path: "/Volumes/Old/Archive", available: false },
        ],
      },
      "/moved-photos/status": STATUS,
      "/moved-photos/batches": {
        batches: [
          { id: "b1", createdAt: "2026-11-10T10:00:00Z", count: 12, undone: false, tripName: null, folder: null },
          { id: "b2", createdAt: "2026-11-09T10:00:00Z", count: 3, undone: true, tripName: null, folder: null },
        ],
      },
    });
    post.mockResolvedValue({ ok: true });
    render(
      <MemoryRouter>
        <MovedPhotosGroup />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Your library folder and trip folders are always included.")).toBeTruthy();
    expect(screen.getByText("Not found")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Look for moved photos automatically" })).toBeTruthy();
    // Matches to review, the trip offer, and the log with Undo on what isn't undone yet.
    expect(screen.getByText("2 photos have possible matches")).toBeTruthy();
    expect(screen.getByText("The Belize folder moved to /Photos/Belize 2026. Use it?")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
    expect(screen.getByText("Undone")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[1]);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/moved-photos/places/remove", { path: "/Volumes/Old/Archive" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/moved-photos/batches/b1/undo"));
  });
});

describe("Moved photos to review", () => {
  it("lists each candidate under where the photo was, and uses the one picked", async () => {
    answer({
      "/moved-photos/reviews": {
        total: 1,
        items: [
          {
            originalId: "o1",
            path: "/Photos/a.jpg",
            reason: "several",
            photoId: null,
            commonName: null,
            scientificName: null,
            candidates: [
              { path: "/Photos/One/a.jpg", size: 10 },
              { path: "/Photos/Two/a.jpg", size: 10 },
            ],
          },
        ],
      },
    });
    post.mockResolvedValue({ batchId: "b9" });
    render(
      <MemoryRouter>
        <MovedPhotosReview open onClose={() => {}} />
      </MemoryRouter>,
    );
    expect(await screen.findByText("/Photos/a.jpg")).toBeTruthy();
    const use = screen.getAllByRole("button", { name: "Use this" });
    expect(use).toHaveLength(2);
    fireEvent.click(use[1]);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/moved-photos/reviews/o1/use", { path: "/Photos/Two/a.jpg" }),
    );
    // The toast offers Undo for the choice.
    await waitFor(() => expect(toast.show).toHaveBeenCalled());
    const [message, options] = toast.show.mock.calls[0];
    expect(message).toBe("Found 1 moved photo");
    expect(options.actions[0].label).toBe("Undo");
  });
});
