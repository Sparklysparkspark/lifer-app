// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetAccountCaches } from "../lib/resource";
import CommandPalette from "./CommandPalette";
import BackToCollectionLink from "./BackToCollectionLink";

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();
const patch = vi.fn();
const del = vi.fn();

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    put: (...a: unknown[]) => put(...a),
    patch: (...a: unknown[]) => patch(...a),
    delete: (...a: unknown[]) => del(...a),
  },
}));

function respond(path: string): unknown {
  if (path === "/trips") return { trips: [] };
  if (path === "/albums") return { albums: [] };
  if (path === "/regions") return { regions: [] };
  if (path === "/settings") return { deploymentMode: "server", dataDir: "/data", libraryRoots: [] };
  if (path.startsWith("/species?")) {
    return { results: [{ id: "sp-1", scientific_name: "Ardea herodias", common_name: "Great Blue Heron" }] };
  }
  if (path.startsWith("/gallery/search?")) return { items: [] };
  throw new Error(`unexpected GET ${path}`);
}

function SpeciesPage() {
  const { id } = useParams();
  return <p>Species page {id}</p>;
}

function renderPalette(onClose = vi.fn()) {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<CommandPalette onClose={onClose} />} />
        <Route path="/species/:id" element={<SpeciesPage />} />
      </Routes>
    </MemoryRouter>,
  );
  return onClose;
}

beforeEach(() => {
  resetAccountCaches();
  localStorage.clear();
  vi.clearAllMocks();
  get.mockImplementation((path: string) => Promise.resolve(respond(path)));
  Element.prototype.scrollIntoView = vi.fn();
});

describe("CommandPalette", () => {
  it("searches species and photos as the user types, then opens the chosen species", async () => {
    const onClose = renderPalette();

    fireEvent.change(screen.getByRole("combobox", { name: "Search Lifer" }), { target: { value: "heron" } });

    const option = await screen.findByRole("option", { name: /Great Blue Heron/ });
    const urls = get.mock.calls.map((c) => c[0] as string);
    expect(urls).toContain("/species?q=heron");
    expect(urls.some((u) => u.startsWith("/gallery/search?") && u.includes("q=heron"))).toBe(true);

    fireEvent.click(option);

    expect(onClose).toHaveBeenCalled();
    expect(await screen.findByText("Species page sp-1")).toBeTruthy();
  });

  it("opens the highlighted result with the keyboard", async () => {
    renderPalette();
    const input = screen.getByRole("combobox", { name: "Search Lifer" });

    fireEvent.change(input, { target: { value: "heron" } });
    const listbox = screen.getByRole("listbox", { name: "Results" });
    await waitFor(() => expect(within(listbox).getByRole("option", { name: /Great Blue Heron/ })).toBeTruthy());

    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText("Species page sp-1")).toBeTruthy();
  });

  it("lets the species it opens go back to the page the palette was opened on", async () => {
    function GalleryAt() {
      const { search } = useLocation();
      return <p>Gallery {search}</p>;
    }
    render(
      <MemoryRouter initialEntries={["/gallery?q=water"]}>
        <Routes>
          <Route
            path="/gallery"
            element={
              <>
                <GalleryAt />
                <CommandPalette onClose={vi.fn()} />
              </>
            }
          />
          <Route path="/species/:id" element={<BackToCollectionLink />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Search Lifer" }), { target: { value: "heron" } });
    fireEvent.click(await screen.findByRole("option", { name: /Great Blue Heron/ }));
    // MemoryRouter keeps no browser history, so this exercises the no-history fallback.
    fireEvent.click(await screen.findByRole("button", { name: "← Gallery" }));

    expect(await screen.findByText("Gallery ?q=water")).toBeTruthy();
  });
});
