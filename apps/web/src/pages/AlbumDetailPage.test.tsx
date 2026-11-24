// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", NoopObserver);
vi.stubGlobal("IntersectionObserver", NoopObserver);

const { default: AlbumDetailPage } = await import("./AlbumDetailPage");
const { ConfirmContext } = await import("../hooks/useConfirm");
const { ToastContext } = await import("../hooks/useToast");
const { resetAccountCaches } = await import("../lib/resource");

const photo = (id: string, commonName: string) => ({
  captureId: `c-${id}`,
  photoId: `p-${id}`,
  speciesId: `s-${id}`,
  commonName,
  scientificName: `${commonName} sci`,
  kind: "image",
  width: 3,
  height: 2,
  qualityRating: null,
  takenAt: null,
});

const species = (speciesId: string, commonName: string, taxonClass = "aves") => ({
  speciesId,
  commonName,
  scientificName: `${commonName} sci`,
  state: "collected",
  taxonClass,
  family: null,
  isTarget: false,
  tier: null,
  localTier: null,
});

const album = (id: string, name: string, rules: object | null = null) => ({
  id,
  name,
  description: null,
  coverPhotoId: null,
  coverPicked: false,
  coverLayout: "single",
  coverCropX: null,
  coverCropY: null,
  coverCropSize: null,
  quadSlots: [],
  items: [photo("a", "Mallard"), photo("b", "Snowy Owl")],
  rules,
  excludedCount: 0,
});

function serve({ fail = false, rules = null as object | null } = {}) {
  get.mockImplementation((path: string) => {
    const base = path.split("?")[0];
    if (fail && base.startsWith("/albums/")) return Promise.reject(new Error("boom"));
    if (base === "/albums/a1/species")
      return Promise.resolve({ items: [species("s-a", "Mallard"), species("s-b", "Snowy Owl", "mammalia")] });
    if (base === "/albums/a1") return Promise.resolve(album("a1", "Ducks", rules));
    if (base === "/albums/a2") return Promise.resolve(album("a2", "Owls"));
    return new Promise(() => {});
  });
}

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

function renderAt(path: string) {
  return render(
    <ToastContext.Provider value={toast}>
      <ConfirmContext.Provider value={vi.fn().mockResolvedValue(false)}>
        <MemoryRouter initialEntries={[path]}>
          <Link to="/albums/a2">Next album</Link>
          <Routes>
            <Route path="/albums/:id" element={<AlbumDetailPage />} />
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
  post.mockResolvedValue({});
  del.mockResolvedValue({});
  serve();
});
afterEach(cleanup);

async function selectAll() {
  await screen.findAllByRole("img");
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  fireEvent.click(screen.getByRole("button", { name: "Select all" }));
  expect(screen.getByText("2 selected")).toBeTruthy();
}

describe("AlbumDetailPage", () => {
  it("removes the selection in one go and offers an Undo that adds the photos back", async () => {
    renderAt("/albums/a1");
    await selectAll();
    fireEvent.click(screen.getByRole("button", { name: "Remove from album" }));
    await waitFor(() => expect(toast.show).toHaveBeenCalled());
    expect(del.mock.calls.map((c) => c[0])).toEqual(["/albums/a1/captures/c-a", "/albums/a1/captures/c-b"]);
    const [message, opts] = toast.show.mock.calls[0] as [
      string,
      { actions: Array<{ label: string; onClick: () => void }> },
    ];
    expect(message).toBe("Removed 2 photos from the album");
    opts.actions[0].onClick();
    expect(post).toHaveBeenCalledWith("/albums/a1/captures", { captureIds: ["c-a", "c-b"] });
  });

  it("excludes from a smart album with one request, and Undo restores the exclusions", async () => {
    serve({ rules: { query: {} } });
    renderAt("/albums/a1");
    await selectAll();
    fireEvent.click(screen.getByRole("button", { name: "Exclude from this album" }));
    await waitFor(() => expect(toast.show).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/albums/a1/exclusions", { captureIds: ["c-a", "c-b"] });
    const [, opts] = toast.show.mock.calls[0] as [string, { actions: Array<{ onClick: () => void }> }];
    opts.actions[0].onClick();
    expect(post).toHaveBeenLastCalledWith("/albums/a1/exclusions/restore", { captureIds: ["c-a", "c-b"] });
  });

  it("starts fresh on opening another album straight from this one", async () => {
    renderAt("/albums/a1");
    await selectAll();
    fireEvent.click(screen.getByText("Next album"));
    expect(await screen.findByDisplayValue("Owls")).toBeTruthy();
    expect(screen.queryByText("2 selected")).toBeNull();
  });

  it("lists its species with the Collection's toolbar, narrowed by the search and animal group", async () => {
    renderAt("/albums/a1?view=species&search=owl");
    expect(await screen.findByText("Snowy Owl")).toBeTruthy();
    expect(screen.queryByText("Mallard")).toBeNull();
    cleanup();
    renderAt("/albums/a1?view=species&taxon=aves");
    expect(await screen.findByText("Mallard")).toBeTruthy();
    expect(screen.queryByText("Snowy Owl")).toBeNull();
  });

  it("searches the album's photos by species name, as a trip does", async () => {
    renderAt("/albums/a1?search=owl");
    const imgs = await screen.findAllByRole("img");
    expect(imgs.map((i) => i.getAttribute("alt"))).toEqual(["Snowy Owl"]);
  });

  it("shows a load error as the shared empty state with Retry", async () => {
    serve({ fail: true });
    renderAt("/albums/a1");
    const retry = await screen.findByRole("button", { name: "Retry" });
    serve();
    fireEvent.click(retry);
    expect(await screen.findByDisplayValue("Ducks")).toBeTruthy();
  });

  it("rates from the viewer, as in the Gallery", async () => {
    renderAt("/albums/a1");
    const [first] = await screen.findAllByRole("img");
    fireEvent.click(first);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByRole("button", { name: "Rate 3 stars" }).length).toBeGreaterThan(0);
  });
});
