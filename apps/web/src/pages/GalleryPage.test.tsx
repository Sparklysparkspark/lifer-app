// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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

function renderGallery(entry = "/gallery") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/gallery" element={<GalleryPage />} />
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
});
