// @vitest-environment jsdom
// The picker never reads an unknown pack list as "nothing downloaded", and offline it still
// offers the installed countries.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { RegionSummary } from "@lifer/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PackStatusEntry } from "../lib/packIndex";

const region = (id: string, name: string, parentId: string | null, scoped = true) =>
  ({ id, name, parentId, hasScopedChecklist: scoped, hasChildren: false }) as RegionSummary;
const REGIONS = [
  region("world", "World", null, false),
  region("na", "North America", "world", false),
  region("ca", "Canada", "na"),
  region("us", "United States of America", "na"),
  region("mb", "Manitoba", "ca"),
  region("ny", "New York", "us"),
];
vi.mock("../hooks/useRegions", () => ({
  useRegions: () => ({ regions: REGIONS, loading: false, error: null, refresh: vi.fn() }),
}));
let index: { packs: PackStatusEntry[] | null; error: unknown; indexUnavailable: boolean };
vi.mock("../lib/packIndex", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/packIndex")>()),
  usePackIndex: () => ({ ...index, freeBytes: null, loading: false, refresh: vi.fn() }),
}));
const { default: RegionBrowser } = await import("./RegionBrowser");

function renderPicker() {
  render(
    <MemoryRouter>
      <RegionBrowser regionId={null} onChange={vi.fn()} />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe("RegionBrowser without the published pack list", () => {
  it("neither says nothing is downloaded nor offers every region when the list couldn't load", () => {
    index = { packs: null, error: new Error("503"), indexUnavailable: false };
    renderPicker();
    expect(screen.queryByText(/No region is downloaded yet/)).toBeNull();
    // Nor does it offer every region in the meantime.
    fireEvent.change(screen.getByRole("combobox", { name: "Search regions" }), { target: { value: "New York" } });
    expect(screen.queryByText(/New York/)).toBeNull();
  });

  it("offline, offers the installed countries from this computer", () => {
    const canada = {
      id: "ca-aves",
      type: "region",
      region: "Canada",
      taxon: "aves",
      downloaded: true,
    } as PackStatusEntry;
    index = { packs: [canada], error: null, indexUnavailable: true };
    renderPicker();
    expect(screen.queryByText(/No region is downloaded yet/)).toBeNull();
    const search = screen.getByRole("combobox", { name: "Search regions" });
    fireEvent.change(search, { target: { value: "Manitoba" } });
    expect(screen.getAllByText(/Manitoba/).length).toBeGreaterThan(0);
    fireEvent.change(search, { target: { value: "New York" } });
    expect(screen.queryByText(/New York/)).toBeNull();
  });
});
