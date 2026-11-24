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
// Stands in for the native folder dialog; null is a cancel.
const pick = vi.fn(async (_start?: string): Promise<string | null> => null);
vi.mock("../../lib/pickFolderNative", () => ({ pickFolderNative: (start?: string) => pick(start) }));

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
  it("shows a few moved trip folders, then the rest on request", async () => {
    const proposals = Array.from({ length: 7 }, (_, i) => ({
      ...STATUS.proposals[0],
      tripId: `t${i}`,
      tripName: `Trip ${i}`,
    }));
    answer({
      "/moved-photos/settings": { auto: true, library: "/Lifer", trips: [], watched: [], places: [] },
      "/moved-photos/status": { ...STATUS, proposals },
      "/moved-photos/batches": { batches: [] },
    });
    render(
      <MemoryRouter>
        <MovedPhotosGroup />
      </MemoryRouter>,
    );
    expect(await screen.findAllByRole("button", { name: "Use it" })).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Show 4 more" }));
    expect(screen.getAllByRole("button", { name: "Use it" })).toHaveLength(7);
  });

  it("lists the places, what's always included, and removes one", async () => {
    answer({
      "/moved-photos/settings": {
        auto: true,
        library: "/Lifer",
        trips: ["/Trips/Belize", "/Trips/Peru"],
        watched: ["/Watched"],
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
    expect(await screen.findByText("Places where photos live (2 added)")).toBeTruthy();
    expect(screen.getByText("Not found")).toBeTruthy();
    // The folders always searched sit behind one line until shown.
    expect(
      screen.getByText(/^Also searched: your library folder, 2 trip folders,? and 1 watched folder$/),
    ).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Always searched" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByRole("list", { name: "Always searched" }).querySelectorAll("li")).toHaveLength(4);
    expect(screen.getByRole("switch", { name: "Look for moved photos automatically" })).toBeTruthy();
    // Matches to review, the trip offer, and the log with Undo on what isn't undone yet.
    expect(screen.getByText("2 photos have possible matches")).toBeTruthy();
    expect(screen.getByText("The Belize folder moved to /Photos/Belize 2026. Use it?")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
    expect(screen.getByText("Undone")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove /Volumes/Old/Archive" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/moved-photos/places/remove", { path: "/Volumes/Old/Archive" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/moved-photos/batches/b1/undo"));
  });
});

function renderWith(places: string[], status: object = STATUS) {
  answer({
    "/moved-photos/settings": {
      auto: true,
      library: "/Lifer",
      trips: [],
      watched: [],
      places: places.map((path) => ({ path, available: true })),
    },
    "/moved-photos/status": status,
    "/moved-photos/batches": { batches: [] },
  });
  render(
    <MemoryRouter>
      <MovedPhotosGroup />
    </MemoryRouter>,
  );
}

describe("Places where photos live", () => {
  it("filters a long list, and each row names its full path", async () => {
    renderWith(Array.from({ length: 12 }, (_, i) => `/Volumes/home/Photos/Trip ${i + 1}`));
    const list = await screen.findByRole("list", { name: "Folders you added" });
    expect(list.querySelectorAll("li")).toHaveLength(12);
    expect(list.querySelector("[title='/Volumes/home/Photos/Trip 3']")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Filter Folders you added" }), {
      target: { value: "trip 1" },
    });
    // Trip 1, 10, 11 and 12.
    expect(list.querySelectorAll("li")).toHaveLength(4);
    fireEvent.change(screen.getByRole("textbox", { name: "Filter Folders you added" }), { target: { value: "zzz" } });
    expect(screen.getByText("No folders match")).toBeTruthy();
  });

  it("says a folder is already covered and adds nothing", async () => {
    renderWith(["/Volumes/home/Family Trips"]);
    pick.mockResolvedValueOnce("/Volumes/home/Family Trips/Belize 2026");
    post.mockResolvedValueOnce({
      added: false,
      path: "/Volumes/home/Family Trips/Belize 2026",
      coveredBy: "/Volumes/home/Family Trips",
      contains: [],
    });
    fireEvent.click(await screen.findByRole("button", { name: "Add folder" }));
    expect(await screen.findByText("Already covered by /Volumes/home/Family Trips")).toBeTruthy();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("offers to merge folders a parent covers, merges by default, and Undo splits them again", async () => {
    const kids = ["/P/Family Trips/Belize", "/P/Family Trips/Peru", "/P/Family Trips/Chile"];
    renderWith(kids);
    pick.mockResolvedValueOnce("/P/Family Trips");
    post.mockResolvedValueOnce({ added: false, path: "/P/Family Trips", coveredBy: null, contains: kids });
    fireEvent.click(await screen.findByRole("button", { name: "Add folder" }));
    expect(
      await screen.findByText("This also covers 3 folders you added before. Merge them into this one?"),
    ).toBeTruthy();
    const merge = screen.getByRole("button", { name: "Merge" });
    expect(document.activeElement).toBe(merge);
    post.mockResolvedValueOnce({ added: true, path: "/P/Family Trips", coveredBy: null, contains: kids });
    fireEvent.click(merge);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/moved-photos/places", { path: "/P/Family Trips", merge: true }),
    );
    await waitFor(() => expect(toast.show).toHaveBeenCalled());
    const [message, options] = toast.show.mock.calls[0];
    expect(message).toBe("Merged 3 folders into the new one");
    post.mockResolvedValue({ ok: true });
    options.actions[0].onClick();
    await waitFor(() => expect(post).toHaveBeenCalledWith("/moved-photos/places", { path: kids[2] }));
    expect(post).toHaveBeenCalledWith("/moved-photos/places/remove", { path: "/P/Family Trips" });
  });

  it("puts back every folder it can on Undo, and names the ones it couldn't", async () => {
    const kids = ["/P/Family Trips/Belize", "/P/Family Trips/Peru", "/P/Family Trips/Chile"];
    renderWith(["/P/Family Trips"]);
    pick.mockResolvedValueOnce("/P/Family Trips");
    post.mockResolvedValueOnce({ added: true, path: "/P/Family Trips", coveredBy: null, contains: kids });
    fireEvent.click(await screen.findByRole("button", { name: "Add folder" }));
    await waitFor(() => expect(toast.show).toHaveBeenCalled());
    post.mockImplementation(async (_url: string, body?: { path: string }) => {
      if (body?.path === kids[0]) throw new Error("gone");
      return { ok: true };
    });
    toast.show.mock.calls[0][1].actions[0].onClick();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Put back 2 folders. Couldn't put back Belize"));
    expect(post).toHaveBeenCalledWith("/moved-photos/places", { path: kids[2] });
  });

  it("suggests adding where missing photos went, picks from the old parent, adds and looks", async () => {
    renderWith([], {
      ...STATUS,
      reviewCount: 0,
      proposals: [],
      result: { missingFolder: "/Users/ana/Pictures/Family Trips/Belize 2026" },
    });
    expect(
      await screen.findByText("Moved a folder? Add its new parent folder so Lifer can find your photos again."),
    ).toBeTruthy();
    pick.mockResolvedValueOnce("/Volumes/home/Family Trips");
    post.mockResolvedValue({ added: true, path: "/Volumes/home/Family Trips", coveredBy: null, contains: [] });
    fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/moved-photos/look", { manual: true }));
    expect(pick).toHaveBeenCalledWith("/Users/ana/Pictures/Family Trips");
    expect(post).toHaveBeenCalledWith("/moved-photos/places", { path: "/Volumes/home/Family Trips", merge: true });
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
