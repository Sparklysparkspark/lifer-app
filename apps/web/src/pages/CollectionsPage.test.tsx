// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    put: vi.fn(),
    patch: vi.fn(),
    delete: (...a: unknown[]) => del(...a),
  },
}));

// jsdom has none; the trip card's text fitting only needs it to exist.
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", NoopObserver);

const { default: CollectionsPage, sortItems } = await import("./CollectionsPage");
const { ToastContext } = await import("../hooks/useToast");
const { default: i18n } = await import("../i18n");
const { resetAccountCaches } = await import("../lib/resource");

const album = {
  id: "a1",
  name: "Spring Marsh",
  description: null,
  coverPhotoId: null,
  coverLayout: "single",
  coverCropX: null,
  coverCropY: null,
  coverCropSize: null,
  quadSlots: [],
  createdAt: "2026-01-01T00:00:00Z",
  captureCount: 3,
};
const trip = {
  id: "t1",
  name: "Ridge Weekend",
  earliestTakenAt: null,
  latestTakenAt: null,
  processing: false,
  coverLayout: "single",
  coverPhotoUrl: null,
  coverCropX: null,
  coverCropY: null,
  coverCropSize: null,
  quadPhotoIds: [],
  captureCount: 5,
  speciesCount: 2,
};

const suggestion = (id: string, kind: string, label: string | null = null, name = "Lifers") => ({
  id,
  kind,
  label,
  name,
  rules: { version: 2, query: { q: "lifers", excludeVideo: "1", includeRaw: "0" } },
  photoCount: 12,
  previewPhotoIds: ["p1", "p2", "p3", "p4"],
});
let suggestions: ReturnType<typeof suggestion>[] = [];

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

function AlbumStub() {
  const state = useLocation().state as { justCreated?: boolean } | null;
  return <p>album page {state?.justCreated ? "just created" : ""}</p>;
}

function renderAt(path: string) {
  return render(
    <ToastContext.Provider value={toast}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/albums/:id" element={<AlbumStub />} />
          <Route path="*" element={<CollectionsPage />} />
        </Routes>
      </MemoryRouter>
    </ToastContext.Provider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  // The last lists are kept for the next visit; each test starts without them.
  resetAccountCaches();
  get.mockReset();
  post.mockReset();
  del.mockReset();
  suggestions = [];
  get.mockImplementation((path: string) =>
    Promise.resolve(
      path === "/albums"
        ? { albums: [album] }
        : path === "/albums/suggestions"
          ? { suggestions }
          : { trips: [trip], places: [] },
    ),
  );
  del.mockResolvedValue({});
});

describe("CollectionsPage", () => {
  it("shows one side at a time, switched at the top and kept in the address", async () => {
    renderAt("/albums?view=albums");
    expect((await screen.findByText("Spring Marsh")).closest("a")?.getAttribute("href")).toBe("/albums/a1");
    expect(screen.queryByText("Ridge Weekend")).toBeNull();
    const albumsPill = screen.getByRole("button", { name: i18n.t("nav.albums") });
    expect(albumsPill.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("nav.trips") }));
    await screen.findByText("Ridge Weekend");
    expect(screen.queryByText("Spring Marsh")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: i18n.t("nav.trips") })).toBeTruthy();
    // Trips has its own actions; album ones are gone.
    expect(screen.getByRole("button", { name: i18n.t("trips.list.startTrip") })).toBeTruthy();
    expect(screen.queryByRole("button", { name: i18n.t("albums.list.newAlbum") })).toBeNull();
  });

  it("remembers the last side across launches", async () => {
    renderAt("/albums?view=trips");
    await screen.findByText("Ridge Weekend");
    expect(localStorage.getItem("lifer:albumsPageView")).toBe('"trips"');
    cleanup();
    renderAt("/albums");
    await screen.findByText("Ridge Weekend");
    expect(screen.queryByText("Spring Marsh")).toBeNull();
  });

  it("searches and sorts each side on its own, with hundreds of albums", async () => {
    const many = Array.from({ length: 300 }, (_, i) => ({
      ...album,
      id: `a${i}`,
      name: `Album ${i}`,
      createdAt: new Date(Date.UTC(2020, 0, 1 + i)).toISOString(),
    }));
    get.mockImplementation((path: string) =>
      Promise.resolve(path === "/albums" ? { albums: many } : { trips: [trip], places: [] }),
    );
    renderAt("/albums?view=albums");
    await screen.findByText("Album 299");
    // Newest first by default.
    const names = () => screen.getAllByRole("link").map((l) => l.textContent);
    expect(names()[0]).toContain("Album 299");
    fireEvent.change(screen.getByLabelText(i18n.t("albums.sections.searchAlbums")), {
      target: { value: "album 29" },
    });
    expect(screen.getByText("Album 299")).toBeTruthy();
    expect(screen.queryByText("Album 4")).toBeNull();
    // Switching sides drops the search.
    fireEvent.click(screen.getByRole("button", { name: i18n.t("nav.trips") }));
    await screen.findByText("Ridge Weekend");
    expect((screen.getByLabelText(i18n.t("albums.sections.searchTrips")) as HTMLInputElement).value).toBe("");
  });

  it("sorts by name, count and date with undated items newest", () => {
    const items = [
      { name: "b", captureCount: 1, d: "2024-01-01" },
      { name: "A10", captureCount: 5, d: null },
      { name: "A2", captureCount: 5, d: "2023-01-01" },
    ];
    const date = (i: (typeof items)[number]) => i.d;
    expect(sortItems(items, "title", date).map((i) => i.name)).toEqual(["A2", "A10", "b"]);
    expect(sortItems(items, "count", date).map((i) => i.name)).toEqual(["A2", "A10", "b"]);
    expect(sortItems(items, "newest", date).map((i) => i.name)).toEqual(["A10", "b", "A2"]);
    expect(sortItems(items, "oldest", date).map((i) => i.name)).toEqual(["A2", "b", "A10"]);
  });

  it("creates an unnamed album at once and opens it to be named", async () => {
    get.mockResolvedValue({ albums: [], suggestions: [] });
    post.mockResolvedValue({ id: "new1" });
    renderAt("/albums");
    // The header has New album, so the empty state has no second one.
    expect(await screen.findAllByRole("button", { name: i18n.t("albums.list.newAlbum") })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("albums.list.newAlbum") }));
    await screen.findByText("album page just created");
    expect(post).toHaveBeenCalledWith("/albums", {});
  });

  it("keeps a trip form's Cancel in the form, leaving the section buttons as they are", async () => {
    renderAt("/albums?view=trips");
    await screen.findByText("Ridge Weekend");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("trips.list.startTrip") }));
    expect(screen.getByLabelText(i18n.t("trips.start.startDate"))).toBeTruthy();
    expect(screen.getByRole("button", { name: i18n.t("trips.list.importTrip") })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: i18n.t("common.cancel") }));
    expect(screen.queryByLabelText(i18n.t("trips.start.startDate"))).toBeNull();
    expect(screen.getByRole("button", { name: i18n.t("trips.list.startTrip") })).toBeTruthy();
  });

  it("offers a retry when the albums don't load, saying the server couldn't be reached", async () => {
    // Only the first albums request fails; suggestions load on their own.
    const loaded = get.getMockImplementation()!;
    let offline = true;
    get.mockImplementation((path: string) => {
      if (path !== "/albums" || !offline) return loaded(path);
      offline = false;
      return Promise.reject(new TypeError("Failed to fetch"));
    });
    renderAt("/albums");
    await screen.findByText(i18n.t("errors.user.network"));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("common.retry") }));
    await screen.findByText("Spring Marsh");
  });

  it("keeps showing the albums already loaded when a later load fails", async () => {
    renderAt("/albums");
    await screen.findByText("Spring Marsh");
    cleanup();
    get.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")));
    renderAt("/albums");
    expect(screen.getByText("Spring Marsh")).toBeTruthy();
    await waitFor(() => expect(get.mock.calls.filter(([path]) => path === "/albums")).toHaveLength(2));
    expect(screen.queryByText(i18n.t("albums.list.loadFailed"))).toBeNull();
  });

  it("deletes an album after confirming, then reloads the list", async () => {
    renderAt("/albums");
    await screen.findByText("Spring Marsh");
    get.mockResolvedValue({ albums: [], suggestions: [] });

    fireEvent.click(screen.getByRole("button", { name: i18n.t("ui.moreOptions") }));
    fireEvent.click(screen.getByRole("menuitem", { name: i18n.t("common.delete") }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      [...dialog.querySelectorAll("button")].find((b) => b.textContent === i18n.t("common.delete")) as HTMLElement,
    );

    await waitFor(() => expect(del).toHaveBeenCalledWith("/albums/a1"));
    await screen.findByText(i18n.t("albums.empty.title"));
  });

  it("keeps suggestions off the Albums page, empty or not", async () => {
    suggestions = [suggestion("lifers", "lifers")];
    renderAt("/albums");
    await screen.findByText("Spring Marsh");
    expect(screen.queryByRole("heading", { name: i18n.t("albums.suggestions.title") })).toBeNull();

    get.mockImplementation((path: string) => Promise.resolve(path === "/albums" ? { albums: [] } : { suggestions }));
    renderAt("/albums");
    await screen.findByText(i18n.t("albums.empty.title"));
    expect(screen.queryByRole("heading", { name: i18n.t("albums.suggestions.title") })).toBeNull();
    expect(get).not.toHaveBeenCalledWith("/albums/suggestions", expect.anything());
  });

  it("creates a suggested album from New smart album, then opens it to be named", async () => {
    suggestions = [suggestion("lifers", "lifers")];
    post.mockResolvedValue({ id: "new2" });
    renderAt("/albums");
    await screen.findByText("Spring Marsh");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("albums.smart.newSmartAlbum") }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: i18n.t("albums.suggestions.createNamed", { name: i18n.t("albums.suggestions.names.lifers") }),
      }),
    );
    await screen.findByText("album page just created");
    expect(post).toHaveBeenCalledWith("/albums", {
      name: i18n.t("albums.suggestions.names.lifers"),
      rules: suggestions[0].rules,
    });
  });
});
