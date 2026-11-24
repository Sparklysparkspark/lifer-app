// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "../components/ConfirmProvider";
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

const { default: HiddenSpeciesPage } = await import("./HiddenSpeciesPage");

const row = (speciesId: string, regionId: string, regionName: string, countryId: string, countryName: string) => ({
  speciesId,
  scientificName: `Sp ${speciesId}`,
  commonName: `Bird ${speciesId}`,
  referencePhoto: null,
  referenceThumbUrl: null,
  hiddenAt: "2026-01-01T00:00:00.000Z",
  regionId,
  regionName,
  countryId,
  countryName,
  isCountry: false,
});

const ontario = row("s1", "on", "Ontario", "ca", "Canada");
const texas = row("s2", "tx", "Texas", "us", "United States");

beforeEach(() => {
  get.mockReset().mockResolvedValue({ items: [ontario, texas] });
  post.mockReset().mockResolvedValue({ ok: true, count: 1 });
  del.mockReset().mockResolvedValue({ ok: true, count: 1 });
});
afterEach(cleanup);

function renderPage() {
  render(
    <MemoryRouter>
      <ToastProvider>
        <ConfirmProvider>
          <HiddenSpeciesPage />
        </ConfirmProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe("HiddenSpeciesPage", () => {
  it("unhides a province in one request, then falls back to the countries left, with Undo", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Canada (1)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Ontario (1)" }));
    get.mockResolvedValue({ items: [texas] });
    fireEvent.click(screen.getByRole("button", { name: "Unhide all shown" }));

    await vi.waitFor(() =>
      expect(del).toHaveBeenCalledWith("/regions/hidden-species/bulk", {
        items: [{ regionId: "on", speciesId: "s1" }],
      }),
    );
    expect(del).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("1 species is back on its checklist.")).toBeTruthy();
    // The emptied province and country are gone: back at all countries with Texas listed.
    expect(await screen.findByRole("link", { name: /Bird s2/ })).toBeTruthy();
    expect(screen.queryByText(/No hidden species match/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith("/regions/hidden-species/bulk", {
        items: [{ regionId: "on", speciesId: "s1" }],
      }),
    );
  });

  it("says no match only when a search hides everything", async () => {
    renderPage();
    await screen.findByRole("link", { name: /Bird s1/ });
    fireEvent.change(screen.getByRole("textbox", { name: "Search hidden or a region…" }), {
      target: { value: "zzz" },
    });
    expect(await screen.findByText('No hidden species match "zzz".')).toBeTruthy();
  });
});
