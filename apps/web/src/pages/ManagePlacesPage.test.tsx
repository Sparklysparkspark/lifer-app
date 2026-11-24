// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "../components/ToastProvider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));

const { default: ManagePlacesPage } = await import("./ManagePlacesPage");

const place = (name: string, count: number, regionName: string | null) => ({
  name,
  count,
  regionId: regionName ? "r-1" : null,
  regionName,
  countryName: null,
  lastUsedAt: "2026-01-01T00:00:00.000Z",
  inRegion: false,
});

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  get.mockResolvedValue({ places: [place("Pigeon Lake", 42, "Alberta"), place("Pigeon lake", 3, null)] });
  post.mockResolvedValue({ updated: 1 });
});
afterEach(cleanup);
// The "⋯" menu measures its panel; jsdom has no ResizeObserver.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);

// Row actions live in each row's "⋯" menu.
function openRowMenu(index: number, item: string) {
  fireEvent.click(screen.getAllByRole("button", { name: "More options" })[index]);
  fireEvent.click(screen.getByRole("menuitem", { name: item }));
}

function renderPage() {
  render(
    <MemoryRouter>
      <ToastProvider>
        <ManagePlacesPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe("ManagePlacesPage", () => {
  it("lists each place with its region and count, linking to its photos", async () => {
    renderPage();
    const link = await screen.findByRole("link", { name: "Pigeon Lake" });
    expect(link.getAttribute("href")).toBe("/gallery?place=Pigeon%20Lake");
    expect(screen.getByText("Alberta")).toBeTruthy();
    expect(screen.getByText("42 photos")).toBeTruthy();
  });

  it("renames straight away to a new name", async () => {
    renderPage();
    await screen.findByRole("link", { name: "Pigeon Lake" });
    openRowMenu(0, "Rename");
    const input = screen.getByRole("textbox", { name: "New name for Pigeon Lake" });
    fireEvent.change(input, { target: { value: "Pigeon Lake Park" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith("/places/rename", { from: "Pigeon Lake", to: "Pigeon Lake Park" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reports how many photos changed and, once moved, how many files followed", async () => {
    post.mockResolvedValue({ updated: 3, movingFiles: true });
    get.mockImplementation((p: string) =>
      Promise.resolve(
        p === "/places/file-moves/status"
          ? { running: false, moved: 3, failed: 1 }
          : { places: [place("Pigeon Lake", 42, "Alberta")] },
      ),
    );
    renderPage();
    await screen.findByRole("link", { name: "Pigeon Lake" });
    openRowMenu(0, "Rename");
    const input = screen.getByRole("textbox", { name: "New name for Pigeon Lake" });
    fireEvent.change(input, { target: { value: "Sylvan Lake" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("Renamed on 3 photos; moved 3 files, 1 couldn't be moved.")).toBeTruthy();
  });

  it("asks before merging into a name already in use", async () => {
    renderPage();
    await screen.findByRole("link", { name: "Pigeon lake" });
    openRowMenu(1, "Rename");
    const input = screen.getByRole("textbox", { name: "New name for Pigeon lake" });
    fireEvent.change(input, { target: { value: "Pigeon Lake" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText('Merge "Pigeon lake" into "Pigeon Lake"?')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Merge" }));
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith("/places/rename", { from: "Pigeon lake", to: "Pigeon Lake" }),
    );
  });

  it("confirms a remove with the photo count, keeping regions", async () => {
    renderPage();
    await screen.findByRole("link", { name: "Pigeon Lake" });
    openRowMenu(0, "Remove");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText('Remove "Pigeon Lake" from 42 photos?')).toBeTruthy();
    expect(within(dialog).getByText("Their regions stay.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove name" }));
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith("/places/remove", { name: "Pigeon Lake" }));
  });
  it("keeps saved spots on screen when no photo has a place name yet", async () => {
    get.mockImplementation((p: string) =>
      Promise.resolve(
        p === "/saved-spots"
          ? { spots: [{ id: "s1", name: "Home pond", lat: 1, lon: 2, radiusM: 100, photoCount: 0, locality: null }] }
          : p === "/saved-spots/suggestions"
            ? { suggestions: [] }
            : { places: [] },
      ),
    );
    renderPage();
    expect(await screen.findByText("No photos have a place name yet.")).toBeTruthy();
    expect(screen.getByText("Saved spots")).toBeTruthy();
    expect(screen.queryByText(/No places match/)).toBeNull();
  });

  it("offers Add spot from the empty state", async () => {
    get.mockImplementation((p: string) =>
      Promise.resolve(
        p === "/saved-spots" ? { spots: [] } : p === "/saved-spots/suggestions" ? { suggestions: [] } : { places: [] },
      ),
    );
    renderPage();
    expect(await screen.findByText("No place names yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add spot" })).toBeTruthy();
  });

  it("says no match only for a search, in place of the place-name list", async () => {
    renderPage();
    await screen.findByRole("link", { name: "Pigeon Lake" });
    fireEvent.change(screen.getByRole("textbox", { name: "Search places…" }), { target: { value: "zzz" } });
    expect(await screen.findByText('No places match "zzz".')).toBeTruthy();
  });
});
