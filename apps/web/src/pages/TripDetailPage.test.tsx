// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionItem } from "@lifer/shared";

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

// jsdom has neither; the cards and grid only need them to exist.
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", NoopObserver);
vi.stubGlobal("IntersectionObserver", NoopObserver);

const { default: TripDetailPage } = await import("./TripDetailPage");
const { ConfirmContext } = await import("../hooks/useConfirm");
const { ToastContext } = await import("../hooks/useToast");
const { resetAccountCaches } = await import("../lib/resource");

const trip = {
  id: "t1",
  name: "Marsh weekend",
  description: null,
  sourceFolder: "/cards/marsh",
  destinationFolder: "/library/marsh",
  coverCaptureId: null,
  coverCropX: null,
  coverCropY: null,
  coverCropSize: null,
};

function species(speciesId: string, commonName: string, taxonClass = "aves"): CollectionItem {
  return {
    speciesId,
    commonName,
    scientificName: `${commonName} sci`,
    state: "collected",
    taxonClass,
    family: null,
    isTarget: false,
    tier: null,
    localTier: null,
  } as CollectionItem;
}

function photo(captureId: string, commonName: string, originalKind = "jpeg", speciesId = "a") {
  return {
    photoId: `p-${captureId}`,
    captureId,
    speciesId,
    commonName,
    scientificName: `${commonName} sci`,
    takenAt: null,
    qualityRating: null,
    hasRaw: originalKind === "raw",
    originalKind,
    width: 3,
    height: 2,
  };
}

// Answers by exact path or prefix; anything unlisted (job polls, volumes) never resolves.
function serve({ empty = false, fail = false, kind = "jpeg" } = {}) {
  const answers: Array<[string, unknown]> = [
    [
      "/trips/t1/photos",
      { items: empty ? [] : [photo("c1", "Marsh Robin", kind), photo("c2", "Ridge Jay", kind, "b")] },
    ],
    ["/trips/t1/species", { items: empty ? [] : [species("a", "Marsh Robin"), species("b", "Ridge Jay", "mammalia")] }],
    ["/trips/t1/summary", { speciesCount: 0, liferCount: 0, rareCount: 0, endemicCount: 0 }],
    ["/trips/t1", trip],
    ["/settings", { deploymentMode: "server", dataDir: "/library", libraryRoots: [] }],
  ];
  get.mockImplementation((path: string) => {
    if (fail && path === "/trips/t1") return Promise.reject(new Error("boom"));
    const hit = answers.find(([prefix]) => path === prefix || path.startsWith(`${prefix}?`));
    return hit ? Promise.resolve(hit[1]) : new Promise(() => {});
  });
}

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

// Where a species card leads, and what it carried there.
function SpeciesStub() {
  const { pathname, search, state } = useLocation();
  return <p>{`${pathname}${search} back to ${(state as { backLabel?: string } | null)?.backLabel}`}</p>;
}

function renderAt(path: string) {
  return render(
    <ToastContext.Provider value={toast}>
      <ConfirmContext.Provider value={vi.fn().mockResolvedValue(false)}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/trips/:id" element={<TripDetailPage />} />
            <Route path="/species/:id" element={<SpeciesStub />} />
          </Routes>
        </MemoryRouter>
      </ConfirmContext.Provider>
    </ToastContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAccountCaches();
  localStorage.clear();
  post.mockReturnValue(new Promise(() => {}));
  serve();
});

describe("TripDetailPage", () => {
  it("shows the trip and its species once everything has loaded", async () => {
    renderAt("/trips/t1");
    expect(await screen.findByDisplayValue("Marsh weekend")).toBeTruthy();
    expect(screen.getByText("Marsh Robin")).toBeTruthy();
    expect(screen.getByText("Ridge Jay")).toBeTruthy();
  });

  it("narrows the species by the search in the URL", async () => {
    renderAt("/trips/t1?search=jay");
    expect(await screen.findByText("Ridge Jay")).toBeTruthy();
    expect(screen.queryByText("Marsh Robin")).toBeNull();
  });

  it("filters the species as the Collection does, by animal group from the URL", async () => {
    renderAt("/trips/t1?taxon=mammalia");
    expect(await screen.findByText("Ridge Jay")).toBeTruthy();
    expect(screen.queryByText("Marsh Robin")).toBeNull();
    expect(screen.getByText("Showing 1 of 2")).toBeTruthy();
  });

  it("opens a species card with the trip, so its page leads with this trip's photos", async () => {
    renderAt("/trips/t1");
    fireEvent.click(await screen.findByText("Ridge Jay"));
    expect(await screen.findByText("/species/b?trip=t1 back to Marsh weekend")).toBeTruthy();
  });

  it("filters the photos by species picked in Filters, listed with their photo counts", async () => {
    renderAt("/trips/t1?view=gallery");
    expect(await screen.findAllByRole("img")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    const picker = screen.getByRole("group", { name: "Species" });
    expect(within(picker).getAllByText("1")).toHaveLength(2);
    fireEvent.click(within(picker).getByRole("checkbox", { name: /Ridge Jay/ }));
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(1));
    expect(screen.getByRole("img").getAttribute("alt")).toBe("Ridge Jay");
  });

  it("shows only the species picked in the photo filters", async () => {
    renderAt("/trips/t1?view=gallery&species=a");
    const imgs = await screen.findAllByRole("img");
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute("alt")).toBe("Marsh Robin");
  });

  it("offers a retry when the trip can't load, and shows it once it does", async () => {
    serve({ fail: true });
    renderAt("/trips/t1");
    const retry = await screen.findByRole("button", { name: "Retry" });
    serve();
    fireEvent.click(retry);
    expect(await screen.findByDisplayValue("Marsh weekend")).toBeTruthy();
  });

  it("switches from species to the trip's photo grid", async () => {
    renderAt("/trips/t1");
    await screen.findByDisplayValue("Marsh weekend");
    fireEvent.click(screen.getByRole("button", { name: /View/ }));
    fireEvent.click(within(screen.getByRole("group", { name: "Show" })).getByRole("button", { name: "Photos" }));
    expect(await screen.findAllByRole("img")).toHaveLength(2);
    expect(screen.queryByText("No photos match these filters")).toBeNull();
  });

  it("lists a trip of RAW-only photos by default", async () => {
    serve({ kind: "raw" });
    renderAt("/trips/t1?view=gallery");
    expect(await screen.findAllByRole("img")).toHaveLength(2);
  });

  it("lists the RAW photos not edited yet from the URL, asking the server which have no edit linked", async () => {
    // A saved "hide RAW files" preset doesn't empty the backlog.
    localStorage.setItem("lifer:tripRawFiles", JSON.stringify("hide"));
    serve({ kind: "raw" });
    const answer = get.getMockImplementation()!;
    get.mockImplementation((path: string) =>
      path.startsWith("/gallery/ids?") ? Promise.resolve({ captureIds: ["c2"] }) : answer(path),
    );
    renderAt("/trips/t1?view=gallery&unedited=1");
    await waitFor(() => expect(screen.getAllByRole("img").map((i) => i.getAttribute("alt"))).toEqual(["Ridge Jay"]));
    const ids = get.mock.calls.map((c) => c[0] as string).find((p) => p.startsWith("/gallery/ids?"))!;
    const params = new URLSearchParams(ids.split("?")[1]);
    expect([params.get("tripId"), params.get("unedited"), params.get("includeRaw")]).toEqual(["t1", "1", null]);
  });

  it("narrows the species to those with only RAW photos so far, marked on the card", async () => {
    const answer = get.getMockImplementation()!;
    get.mockImplementation((path: string) =>
      path === "/trips/t1/species"
        ? Promise.resolve({ items: [{ ...species("a", "Marsh Robin"), rawOnly: true }, species("b", "Ridge Jay")] })
        : answer(path),
    );
    renderAt("/trips/t1?rawOnly=1");
    expect(await screen.findByText("Marsh Robin")).toBeTruthy();
    expect(screen.getByText("RAW only")).toBeTruthy();
    expect(screen.queryByText("Ridge Jay")).toBeNull();
  });

  it("explains a saved 'hide RAW files' that empties the trip, and shows them on request", async () => {
    localStorage.setItem("lifer:tripRawFiles", JSON.stringify("hide"));
    serve({ kind: "raw" });
    renderAt("/trips/t1?view=gallery");
    expect(await screen.findByText("Photos with only a RAW file are hidden.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show all photos" }));
    expect(await screen.findAllByRole("img")).toHaveLength(2);
  });

  it("drops the selection on moving to another trip, so Delete can't reach photos out of view", async () => {
    // The second trip answers with the first one's data, under its own id.
    const answer = get.getMockImplementation()!;
    get.mockImplementation((path: string) => answer(path.replace("/trips/t2", "/trips/t1")));
    render(
      <ToastContext.Provider value={toast}>
        <ConfirmContext.Provider value={vi.fn().mockResolvedValue(false)}>
          <MemoryRouter initialEntries={["/trips/t1?view=gallery"]}>
            <Link to="/trips/t2?view=gallery">Next trip</Link>
            <Routes>
              <Route path="/trips/:id" element={<TripDetailPage />} />
            </Routes>
          </MemoryRouter>
        </ConfirmContext.Provider>
      </ToastContext.Provider>,
    );
    await screen.findAllByRole("img");
    fireEvent.keyDown(window, { key: "a", ctrlKey: true });
    expect(await screen.findByText("2 selected")).toBeTruthy();
    fireEvent.click(screen.getByText("Next trip"));
    await screen.findAllByRole("img");
    expect(screen.queryByText("2 selected")).toBeNull();
  });

  it("keeps only visible photos selected, and Remove from trip says so with an Undo", async () => {
    post.mockResolvedValue({});
    renderAt("/trips/t1?view=gallery");
    await screen.findAllByRole("img");
    fireEvent.keyDown(window, { key: "a", ctrlKey: true });
    expect(await screen.findByText("2 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "Species" })).getByRole("checkbox", { name: /Ridge Jay/ }),
    );
    expect(await screen.findByText("1 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove from trip" }));
    await waitFor(() => expect(toast.show).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/trips/t1/captures/remove", { captureIds: ["c2"] });
    const [message, opts] = toast.show.mock.calls[0] as [
      string,
      { actions: Array<{ label: string; onClick: () => void }> },
    ];
    expect(message).toBe("Removed 1 photo from the trip. Its file is moving out of the trip folder.");
    opts.actions[0].onClick();
    expect(post).toHaveBeenLastCalledWith("/trips/t1/captures", { captureIds: ["c2"] });
  });

  it("deletes the selection at once with an Undo toast, asking nothing", async () => {
    post.mockResolvedValue({});
    renderAt("/trips/t1?view=gallery");
    await screen.findAllByRole("img");
    fireEvent.keyDown(window, { key: "a", ctrlKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "Delete selected" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(toast.show).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/captures/batch-delete", { captureIds: ["c1", "c2"], deleteRaw: false });
    const [message, opts] = toast.show.mock.calls[0] as [string, { actions: Array<{ label: string }> }];
    expect(message).toBe("Moved 2 to Trash");
    expect(opts.actions.map((a) => a.label)).toEqual(["View", "Undo"]);
  });

  it("starts a folder scan from an empty trip", async () => {
    serve({ empty: true });
    renderAt("/trips/t1");
    const scanButtons = await screen.findAllByRole("button", { name: "Scan folder" });
    fireEvent.click(scanButtons[0]);
    await waitFor(() => expect(post).toHaveBeenCalledWith("/trips/t1/scan", {}));
  });
});
