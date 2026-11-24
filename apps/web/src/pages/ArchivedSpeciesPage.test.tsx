// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ToastProvider";

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    delete: (...a: unknown[]) => del(...a),
  },
}));
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);

const { default: ArchivedSpeciesPage } = await import("./ArchivedSpeciesPage");

const item = (speciesId: string) => ({
  speciesId,
  scientificName: `Anas ${speciesId}`,
  commonName: `Duck ${speciesId}`,
  taxonClass: "aves",
  family: "Anatidae",
  referencePhoto: null,
  referenceThumbUrl: null,
  archivedAt: "2026-01-01T00:00:00.000Z",
});

beforeEach(() => {
  get.mockReset().mockResolvedValue({ items: [item("a"), item("b")], families: [] });
  post.mockReset().mockResolvedValue({ ok: true, archived: 2 });
  del.mockReset().mockResolvedValue({ ok: true, unarchived: 2 });
});
afterEach(cleanup);

describe("ArchivedSpeciesPage", () => {
  it("unarchives a family at once, with no confirm, and Undo archives the same species again", async () => {
    render(
      <MemoryRouter>
        <ToastProvider>
          <ArchivedSpeciesPage />
        </ToastProvider>
      </MemoryRouter>,
    );
    await screen.findByRole("link", { name: /Duck a/ });
    const sectionMenus = screen.getAllByRole("button", { name: /More options/ });
    fireEvent.click(sectionMenus[0]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Unarchive all" }));
    await vi.waitFor(() => expect(del).toHaveBeenCalledWith("/archive/bulk", { speciesIds: ["a", "b"] }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByText("2 species are back in your collection.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith("/archive/bulk", { speciesIds: ["a", "b"] }));
  });
});
