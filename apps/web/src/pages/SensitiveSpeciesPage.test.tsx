// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const put = vi.fn();
const del = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: {
    get: (...a: unknown[]) => get(...a),
    put: (...a: unknown[]) => put(...a),
    delete: (...a: unknown[]) => del(...a),
  },
}));

const { default: SensitiveSpeciesPage } = await import("./SensitiveSpeciesPage");
const { ToastContext } = await import("../hooks/useToast");
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

const row = (id: string, commonName: string, extra: object = {}) => ({
  id,
  commonName,
  scientificName: `${commonName} sci`,
  iucnStatus: null,
  reason: "ebird",
  removed: false,
  areas: [],
  ...extra,
});

function serve(species: unknown[], enabled = true) {
  get.mockImplementation((path: string) =>
    Promise.resolve(path.endsWith("/list") ? { species } : { sensitiveSpecies: { enabled } }),
  );
}

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);

function renderPage() {
  render(
    <ToastContext.Provider value={toast}>
      <MemoryRouter>
        <SensitiveSpeciesPage />
      </MemoryRouter>
    </ToastContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  put.mockResolvedValue({ ok: true, enabled: true });
  del.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

describe("SensitiveSpeciesPage", () => {
  it("says why each species is listed, and keeps ones marked not sensitive in their own section", async () => {
    serve([
      row("1", "Burrowing Owl", { reason: "iucn", iucnStatus: "EN" }),
      row("2", "Gyrfalcon"),
      row("3", "Snowy Owl", { reason: "added" }),
      row("4", "Whooping Crane", { reason: "iucn", iucnStatus: "CR", removed: true }),
    ]);
    renderPage();
    await screen.findByRole("link", { name: "Burrowing Owl" });
    expect(screen.getByText(/IUCN Endangered/)).toBeTruthy();
    expect(screen.getByText(/On eBird's sensitive list/)).toBeTruthy();
    expect(screen.getByText(/Added by you/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Locations hidden" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Marked not sensitive" })).toBeTruthy();
  });

  it("names the areas of a species eBird lists only in some places", async () => {
    serve([
      row("1", "Common Goldeneye", { areas: ["England-GB"] }),
      row("2", "Ural Owl", { areas: ["Ontario-CA", "Mexico", "Alberta-CA", "Yukon-CA"] }),
    ]);
    renderPage();
    await screen.findByRole("link", { name: "Common Goldeneye" });
    expect(screen.getByText("On eBird's sensitive list in England, GB")).toBeTruthy();
    expect(screen.getByText("On eBird's sensitive list in Ontario, CA + 3 more")).toBeTruthy();
  });

  it("removes and restores from the row menu", async () => {
    serve([row("1", "Gyrfalcon"), row("2", "Whooping Crane", { removed: true })]);
    renderPage();
    await screen.findByRole("link", { name: "Gyrfalcon" });
    const menus = () => screen.getAllByRole("button", { name: "More options" });

    fireEvent.click(menus()[0]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark as not sensitive" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/settings/sensitive-species/1"));

    fireEvent.click(menus()[1]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Treat as sensitive again" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith("/settings/sensitive-species/2"));
  });

  it("filters by common or scientific name, and says when nothing matches", async () => {
    serve([row("1", "Gyrfalcon"), row("2", "Snowy Owl")]);
    renderPage();
    await screen.findByRole("link", { name: "Gyrfalcon" });
    const search = screen.getByLabelText("Search species");
    fireEvent.change(search, { target: { value: "owl sci" } });
    expect(screen.queryByRole("link", { name: "Gyrfalcon" })).toBeNull();
    expect(screen.getByRole("link", { name: "Snowy Owl" })).toBeTruthy();
    fireEvent.change(search, { target: { value: "zebra" } });
    expect(screen.getByText("No species match zebra")).toBeTruthy();
  });

  it("shows thousands of species a page at a time", async () => {
    serve(Array.from({ length: 3000 }, (_, i) => row(String(i), `Species ${String(i).padStart(4, "0")}`)));
    renderPage();
    await screen.findByRole("link", { name: "Species 0000" });
    expect(screen.getAllByRole("link", { name: /^Species / })).toHaveLength(200);
    expect(screen.getByRole("button", { name: /Show 200 more/ })).toBeTruthy();
  });

  it("says when the feature is off and turns it back on", async () => {
    serve([row("1", "Gyrfalcon")], false);
    renderPage();
    await screen.findByText(/Hiding locations is turned off/);
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith("/settings/sensitive-species", { enabled: true }));
    await waitFor(() => expect(screen.queryByText(/Hiding locations is turned off/)).toBeNull());
  });

  it("explains the empty list", async () => {
    serve([]);
    renderPage();
    expect(await screen.findByText("No sensitive species yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add species" }));
    expect(await screen.findByRole("dialog", { name: "Add a sensitive species" })).toBeTruthy();
  });
});
