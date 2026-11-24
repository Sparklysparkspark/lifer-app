// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAccountCaches } from "../lib/resource";

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
const toast = { error: vi.fn(), success: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };
vi.mock("../hooks/useToast", () => ({ useToast: () => toast }));

const { default: GalleryPage } = await import("./GalleryPage");

// jsdom has neither; the masonry grid and the infinite-scroll sentinel only need them to exist.
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
vi.stubGlobal("ResizeObserver", NoopObserver);
vi.stubGlobal("IntersectionObserver", NoopObserver);

const item = (id: string, commonName: string) => ({
  captureId: `c-${id}`,
  photoId: `p-${id}`,
  speciesId: `s-${id}`,
  commonName,
  scientificName: `Genus ${id}`,
  kind: "image",
  width: 600,
  height: 400,
  tags: [],
  qualityRating: null,
});

// Requests the test doesn't care about (tags, facets, settings) never answer.
function routeGets(routes: Record<string, (path: string) => unknown>) {
  get.mockImplementation((path: string) => {
    const base = path.split("?")[0];
    const handler = routes[base];
    return handler ? Promise.resolve(handler(path)) : new Promise(() => {});
  });
}

function UrlProbe() {
  return <output data-testid="url">{useLocation().search}</output>;
}

function renderGallery(entry = "/gallery") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/gallery"
          element={
            <>
              <GalleryPage />
              <UrlProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetAccountCaches();
  get.mockReset();
  post.mockReset();
  toast.error.mockReset();
});
afterEach(cleanup);

describe("GalleryPage", () => {
  it("lists the library's photos on load", async () => {
    routeGets({
      "/gallery": () => ({
        items: [item("a", "Great Blue Heron"), item("b", "Snowy Owl")],
        nextCursor: null,
        total: 2,
      }),
    });
    renderGallery();
    expect(await screen.findByRole("img", { name: "Great Blue Heron" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Snowy Owl" })).toBeTruthy();
    const listing = get.mock.calls.map((c) => c[0] as string).find((p) => p.startsWith("/gallery?"));
    expect(listing).toMatch(/limit=200/);
    expect(get.mock.calls.some((c) => (c[0] as string).startsWith("/gallery/search"))).toBe(false);
  });

  it("opens again on the last photos at once while it reloads them", async () => {
    routeGets({ "/gallery": () => ({ items: [item("a", "Great Blue Heron")], nextCursor: null, total: 1 }) });
    const first = renderGallery();
    await screen.findByRole("img", { name: "Great Blue Heron" });
    first.unmount();

    routeGets({});
    renderGallery();
    expect(screen.getByRole("img", { name: "Great Blue Heron" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: /loading/i })).toBeNull();
    expect(get.mock.calls.filter((c) => (c[0] as string).startsWith("/gallery?")).length).toBe(2);
  });

  it("searches as you type and shows what the search found", async () => {
    routeGets({
      "/gallery": () => ({ items: [item("a", "Great Blue Heron")], nextCursor: null, total: 1 }),
      "/gallery/search": () => ({ items: [item("o", "Snowy Owl")], pending: false, interpretation: null }),
    });
    renderGallery();
    await screen.findByRole("img", { name: "Great Blue Heron" });

    fireEvent.change(screen.getByRole("textbox", { name: "Search your photos by what's in them" }), {
      target: { value: "owl" },
    });

    expect(await screen.findByRole("img", { name: "Snowy Owl" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Great Blue Heron" })).toBeNull();
    const searches = get.mock.calls.map((c) => c[0] as string).filter((p) => p.startsWith("/gallery/search?"));
    expect(searches.length).toBeGreaterThan(0);
    expect(searches.every((p) => new URLSearchParams(p.split("?")[1]).get("q") === "owl")).toBe(true);
  });

  it("starts with the search from the URL", async () => {
    routeGets({
      "/gallery/search": () => ({ items: [item("o", "Snowy Owl")], pending: false, interpretation: null }),
    });
    renderGallery("/gallery?q=owl");
    expect(await screen.findByRole("img", { name: "Snowy Owl" })).toBeTruthy();
    expect(get.mock.calls.some((c) => (c[0] as string).startsWith("/gallery?"))).toBe(false);
  });

  it("groups photos by the chosen Group, offering Rarity here only with a region filter", async () => {
    localStorage.clear();
    routeGets({
      "/gallery": () => ({
        items: [
          { ...item("a", "Snowy Owl"), tier: "rare", localTier: "common" },
          { ...item("b", "Mallard"), tier: "common", localTier: null },
        ],
        nextCursor: null,
        total: 2,
      }),
    });
    renderGallery();
    await screen.findByRole("img", { name: "Snowy Owl" });
    // Grouping is how photos show, so it's in View, not Filters.
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    const group = () => screen.getByRole<HTMLSelectElement>("combobox", { name: "Group" });
    const options = () => [...group().options].map((o) => o.textContent);
    expect(options()).toEqual(["No grouping", "Region", "Broad group", "Family group", "Rarity"]);
    fireEvent.change(group(), { target: { value: "tier" } });
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Rare", "Common"]);
    expect(screen.getByRole("button", { name: "View (1)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Filters" })).toBeTruthy();
    cleanup();

    renderGallery("/gallery?regionId=00000000-0000-4000-8000-000000000001");
    await screen.findByRole("img", { name: "Snowy Owl" });
    fireEvent.click(screen.getByRole("button", { name: "View (1)" }));
    expect(options()).toContain("Rarity here");
    fireEvent.change(group(), { target: { value: "localTier" } });
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Common"]);
    localStorage.clear();
  });
});

describe("GalleryPage Filters from Stats", () => {
  const params = (prefix: string) =>
    get.mock.calls
      .map((c) => c[0] as string)
      .filter((p) => p.startsWith(prefix))
      .map((p) => new URLSearchParams(p.split("?")[1]));
  const lastListing = () => params("/gallery?").at(-1)!;

  beforeEach(() =>
    routeGets({
      "/gallery": () => ({ items: [item("a", "Mallard")], nextCursor: null, total: 1 }),
      "/gallery/search": () => ({ items: [item("m", "Mallard")], pending: false, interpretation: null }),
    }),
  );

  it("shows a Stats filter in the Filters panel, not as a chip, and clears it there", async () => {
    // An old link's single shotKind reads as the framing it stands for.
    renderGallery("/gallery?shotKind=portrait&tier=rare&missingDate=1");
    await screen.findByRole("img", { name: "Mallard" });
    expect([lastListing().get("framing"), lastListing().get("shotKind")]).toEqual(["close", null]);
    expect(screen.queryByRole("button", { name: /Remove filter/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Filters (3)" }));
    const close = screen.getByRole("button", { name: "Close" });
    expect(close.getAttribute("aria-pressed")).toBe("true");
    const rareTier = () => within(screen.getByRole("group", { name: "Rarity" })).getByRole("button", { name: "Rare" });
    expect(rareTier().getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "Missing a date" }).checked).toBe(true);

    fireEvent.click(close);
    fireEvent.click(rareTier());
    fireEvent.click(screen.getByRole("checkbox", { name: "Missing a date" }));
    expect(screen.getByRole("button", { name: "Filters" })).toBeTruthy();
    expect(screen.getByTestId("url").textContent).toBe("");
    const last = lastListing();
    expect([last.get("framing"), last.get("tier"), last.get("missingDate")]).toEqual([null, null, null]);
  });

  it("takes several values for one filter from the URL, and keeps them in the request", async () => {
    renderGallery("/gallery?regionId=r-bc&regionId=r-ab&tag=a&tag=b");
    await screen.findByRole("img", { name: "Mallard" });
    expect(lastListing().getAll("regionId")).toEqual(["r-bc", "r-ab"]);
    expect(lastListing().getAll("tag")).toEqual(["a", "b"]);
    // One badge per filter, however many values it holds.
    fireEvent.click(screen.getByRole("button", { name: "Filters (2)" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove filter: a" }));
    await vi.waitFor(() => expect(lastListing().getAll("tag")).toEqual(["b"]));
    expect(screen.getByTestId("url").textContent).toContain("tag=b");
  });

  it("filters by a place name from the URL and clears it in the Filters panel", async () => {
    renderGallery("/gallery?place=Pigeon%20Lake");
    await screen.findByRole("img", { name: "Mallard" });
    expect(lastListing().get("place")).toBe("Pigeon Lake");

    fireEvent.click(screen.getByRole("button", { name: "Filters (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove filter: Pigeon Lake" }));
    expect(screen.getByRole("button", { name: "Filters" })).toBeTruthy();
    expect(screen.getByTestId("url").textContent).toBe("");
    await vi.waitFor(() => expect(lastListing().get("place")).toBeNull());
  });

  it("filters by a star rating range, or by unrated on its own", async () => {
    renderGallery();
    await screen.findByRole("img", { name: "Mallard" });
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "3 stars" }));
    fireEvent.pointerUp(screen.getByRole("button", { name: "3 stars" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "4 stars" }));
    await vi.waitFor(() =>
      expect([lastListing().get("ratingMin"), lastListing().get("ratingMax")]).toEqual(["3", "4"]),
    );
    expect(screen.getByRole("button", { name: "Filters (1)" })).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: "Unrated" }));
    await vi.waitFor(() => expect(lastListing().get("unrated")).toBe("1"));
    expect(lastListing().get("ratingMin")).toBeNull();
  });

  it("keeps rating, Animals and dates in the address, so Back returns to the same view", async () => {
    renderGallery();
    await screen.findByRole("img", { name: "Mallard" });
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Unrated" }));
    await vi.waitFor(() => expect(screen.getByTestId("url").textContent).toBe("?unrated=1"));
    cleanup();

    renderGallery("/gallery?ratingMin=4&taxa=aves,mammalia&dateFrom=2025-06-01&dateTo=2025-06-30");
    await screen.findByRole("img", { name: "Mallard" });
    const last = lastListing();
    expect([last.get("ratingMin"), last.get("taxa"), last.get("dateFrom"), last.get("dateTo")]).toEqual([
      "4",
      "aves,mammalia",
      "2025-06-01",
      "2025-06-30",
    ]);
  });

  it("sets a shot type that a search narrows within", async () => {
    renderGallery();
    await screen.findByRole("img", { name: "Mallard" });
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    // Within a group the choices are alternatives; the groups combine.
    fireEvent.click(screen.getByRole("button", { name: "Flying" }));
    fireEvent.click(screen.getByRole("button", { name: "Behaviour" }));
    fireEvent.click(screen.getByRole("button", { name: "Environmental" }));
    expect(screen.getByRole("button", { name: "Filters (1)" })).toBeTruthy();
    expect(screen.getByTestId("url").textContent).toBe("?action=flying%2Cbehavior&framing=environmental");

    fireEvent.change(screen.getByRole("textbox", { name: "Search your photos by what's in them" }), {
      target: { value: "mallard" },
    });
    await screen.findByRole("img", { name: "Mallard" });
    await vi.waitFor(() => expect(params("/gallery/search?").length).toBeGreaterThan(0));
    const search = params("/gallery/search?").at(-1)!;
    expect([search.get("q"), search.get("action"), search.get("framing")]).toEqual([
      "mallard",
      "flying,behavior",
      "environmental",
    ]);
  });
});

describe("GalleryPage fixing photos missing a region", () => {
  beforeEach(() => {
    toast.show.mockReset();
    routeGets({
      "/gallery": () => ({ items: [item("a", "Mallard"), item("b", "Snowy Owl")], nextCursor: null, total: 2 }),
      "/regions": () => ({
        regions: [
          { id: "r-world", name: "World", parentId: null },
          { id: "r-ak", name: "Alaska", parentId: "r-world" },
        ],
      }),
    });
  });

  it("opens from Stats in select mode with a note, but not from the plain No region filter", async () => {
    renderGallery("/gallery?regionId=uncategorized&fix=region");
    await screen.findByRole("img", { name: "Mallard" });
    expect(screen.getByText("Select the photos taken in one place, then choose Set region.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByText("2 selected")).toBeTruthy();
    cleanup();

    renderGallery("/gallery?regionId=uncategorized");
    await screen.findByRole("img", { name: "Mallard" });
    expect(screen.queryByText("Select the photos taken in one place, then choose Set region.")).toBeNull();
  });

  it("sets the region of the selection, offering an Undo that puts the old regions back", async () => {
    post.mockResolvedValue({ updated: 2 });
    renderGallery("/gallery?regionId=uncategorized&fix=region");
    await screen.findByRole("img", { name: "Mallard" });
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    fireEvent.click(screen.getByRole("button", { name: "Set region" }));
    fireEvent.click(await screen.findByRole("button", { name: "Browse by region →" }));
    fireEvent.click(await screen.findByRole("button", { name: "Alaska" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Set region" }));

    await vi.waitFor(() => expect(toast.show).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/captures/location", { captureIds: ["c-a", "c-b"], regionId: "r-ak" });
    const [message, opts] = toast.show.mock.calls[0] as [
      string,
      { actions: Array<{ label: string; onClick: () => void }> },
    ];
    expect(message).toBe("Region set on 2 photos");
    expect(opts.actions.map((a) => a.label)).toEqual(["Undo"]);
    opts.actions[0].onClick();
    expect(post).toHaveBeenLastCalledWith("/captures/location", { captureIds: ["c-a", "c-b"], regionId: null });
  });
});

describe("GalleryPage selection and deleting", () => {
  beforeEach(() => {
    toast.show.mockReset();
    routeGets({
      "/gallery": () => ({ items: [item("a", "Mallard"), item("b", "Snowy Owl")], nextCursor: null, total: 2 }),
      "/gallery/search": () => ({ items: [], pending: false, interpretation: null }),
    });
  });

  it("deletes the selection at once, with a toast that can undo it, and no confirm", async () => {
    post.mockResolvedValue({});
    renderGallery("/gallery?regionId=uncategorized&fix=region");
    await screen.findByRole("img", { name: "Mallard" });
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await vi.waitFor(() => expect(toast.show).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/captures/batch-delete", { captureIds: ["c-a", "c-b"], deleteRaw: false });
    const [message, opts] = toast.show.mock.calls[0] as [
      string,
      { actions: Array<{ label: string; onClick: () => void }> },
    ];
    expect(message).toBe("Moved 2 to Trash");
    expect(opts.actions.map((a) => a.label)).toEqual(["View", "Undo"]);
    opts.actions[1].onClick();
    expect(post).toHaveBeenCalledWith("/trash/c-a/restore", {});
    expect(post).toHaveBeenCalledWith("/trash/c-b/restore", {});
  });

  it("clears the selection when the search or filters change, so nothing unseen is acted on", async () => {
    routeGets({
      "/gallery": () => ({ items: [item("a", "Mallard"), item("b", "Snowy Owl")], nextCursor: null, total: 2 }),
      "/gallery/search": () => ({ items: [item("b", "Snowy Owl")], pending: false, interpretation: null }),
    });
    renderGallery("/gallery?regionId=uncategorized&fix=region");
    await screen.findByRole("img", { name: "Mallard" });
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByText("2 selected")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Search your photos by what's in them" }), {
      target: { value: "owl" },
    });
    await vi.waitFor(() => expect(screen.getByText("0 selected")).toBeTruthy());
  });

  it("Clear search clears the search alone, keeping the filters", async () => {
    renderGallery("/gallery?q=zzz&tag=a");
    await screen.findByText('No photos match "zzz"');
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeTruthy();
    // The last one is the empty state's; the first is the search box's own.
    fireEvent.click(screen.getAllByRole("button", { name: "Clear search" }).at(-1)!);
    await vi.waitFor(() => expect(screen.getByTestId("url").textContent).toBe("?tag=a"));
  });
});
