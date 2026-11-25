// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BC = "00000000-0000-4000-8000-000000000001";
const ONTARIO = "00000000-0000-4000-8000-000000000002";
const LIST = "00000000-0000-4000-8000-000000000009";
const raptors = {
  group: "raptors",
  count: 23,
  examples: [{ speciesId: LIST, scientificName: "Strix varia", commonName: "Barred Owl" }],
};
const fungi = {
  taxonId: 47170,
  name: "Fungi",
  rank: "kingdom",
  commonName: "Mushrooms",
  iconicTaxon: "Fungi",
  observationsCount: 1,
  thumbnailUrl: null,
};
const bcPlace = {
  placeId: 7085,
  name: "British Columbia",
  displayName: "British Columbia",
  adminLevel: 1,
  regionId: BC,
};
const done = { listId: LIST, createdList: true, addedSpeciesIds: [LIST], checklistSpeciesIds: [] };

const get = vi.fn();
const post = vi.fn();
let inatOn = true;
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock("../hooks/useRegions", () => ({
  useRegions: () => ({
    regions: [
      { id: BC, name: "British Columbia", aliases: ["BC"] },
      { id: ONTARIO, name: "Ontario", aliases: [] },
    ],
    error: null,
    refresh: vi.fn(),
  }),
}));
vi.mock("../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useSettings")>()),
  useSettings: () => ({ settings: { anyTaxaSearchEnabled: inatOn }, loading: false, error: null }),
}));

const { default: AddTargetsModal } = await import("./AddTargetsModal");
const { ToastContext } = await import("../hooks/useToast");
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

beforeEach(() => {
  inatOn = true;
  get.mockImplementation(async (path: string) => {
    if (path === "/target-lists") return { lists: [] };
    if (path.startsWith("/collection/targets/by-group"))
      return path.includes("q=mushrooms") ? { group: null, count: null, examples: [] } : raptors;
    if (path.includes("search/taxa")) return { results: [fungi] };
    return { results: [bcPlace], inatUnavailable: null };
  });
  post.mockImplementation(async (path: string) =>
    path === "/species-lists/preview"
      ? { count: 412, examples: [], batches: 1, estimatedMinutes: 14 }
      : path === "/species-lists"
        ? { created: true, list: { id: "l1", name: "Mushrooms of British Columbia" } }
        : done,
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderModal(props: { regionId?: string; regionName?: string } = {}) {
  const onClose = vi.fn();
  const onChanged = vi.fn();
  render(
    <MemoryRouter>
      <ToastContext.Provider value={toast}>
        <AddTargetsModal {...props} onClose={onClose} onChanged={onChanged} />
      </ToastContext.Provider>
    </MemoryRouter>,
  );
  return { onClose, onChanged };
}

const type = (text: string) =>
  fireEvent.change(screen.getByRole("textbox", { name: "Group and place" }), { target: { value: text } });
const calls = (fn: typeof get, part: string) => fn.mock.calls.map(([p]) => String(p)).filter((p) => p.includes(part));

describe("Target a group", () => {
  it("targets a catalog group in a place named by its alias, with Undo, and never asks iNaturalist", async () => {
    const { onClose, onChanged } = renderModal();
    type("raptors of BC");
    const add = await screen.findByRole("button", { name: "Add 23 targets" });
    expect(screen.getByText("Targets 23 species you haven't photographed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Place: British Columbia" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "New list named raptors of BC" })).toBeTruthy();
    expect(calls(get, "by-group")).toEqual([`/collection/targets/by-group?q=raptors&regionId=${BC}`]);
    fireEvent.click(add);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/collection/targets/by-group", {
      q: "raptors",
      regionId: BC,
      includePhotographed: false,
      name: "raptors of BC",
    });
    expect(onChanged).toHaveBeenCalled();
    const [message, options] = toast.show.mock.calls[0];
    expect(message).toBe("Added 1 target to raptors of BC");
    options.actions[0].onClick();
    await waitFor(() => expect(post).toHaveBeenLastCalledWith("/target-lists/import/undo", done));
    expect(calls(get, "search/")).toEqual([]);
  });

  it("uses the region in view when the phrase names no place, and can include photographed species", async () => {
    renderModal({ regionId: ONTARIO, regionName: "Ontario" });
    type("owls");
    expect(await screen.findByRole("button", { name: "Place: Ontario" })).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Include species I've already photographed" }));
    await waitFor(() =>
      expect(calls(get, "by-group").at(-1)).toBe(
        `/collection/targets/by-group?q=owls&regionId=${ONTARIO}&includePhotographed=1`,
      ),
    );
  });

  it("adds a group only iNaturalist has as a list whose species become targets", async () => {
    const { onClose } = renderModal();
    type("mushrooms of BC");
    const add = await screen.findByRole("button", { name: "Add 412 targets" });
    expect(screen.getByText(/412 species on iNaturalist/)).toBeTruthy();
    fireEvent.click(add);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/species-lists", {
      taxonId: 47170,
      taxonName: "Mushrooms",
      taxonRank: "kingdom",
      placeId: 7085,
      placeName: "British Columbia",
      regionId: BC,
      targets: { name: "mushrooms of BC", photographed: false },
    });
    toast.show.mock.calls[0][1].actions[0].onClick();
    await waitFor(() => expect(post).toHaveBeenLastCalledWith("/species-lists/l1/untarget"));
  });

  it("says what to turn on when the group needs iNaturalist and its search is off", async () => {
    inatOn = false;
    renderModal({ regionId: BC, regionName: "British Columbia" });
    type("mushrooms");
    expect(await screen.findByText(/no group called “mushrooms”/)).toBeTruthy();
    expect(calls(get, "search/")).toEqual([]);
    expect((screen.getByRole("button", { name: "Add targets" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the Import a list tab", () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Import a list" }));
    expect(screen.getByText("Drop a CSV of species here")).toBeTruthy();
  });
});
