// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CANADA = "00000000-0000-4000-8000-000000000001";
const spiders = {
  taxonId: 47118,
  name: "Araneae",
  rank: "order",
  commonName: "Spiders",
  iconicTaxon: "Arachnida",
  observationsCount: 1_200_000,
  thumbnailUrl: null,
};
const cattle = { ...spiders, taxonId: 9, name: "Bos taurus", rank: "species", commonName: "Domestic Cattle" };
const canada = { placeId: 6712, name: "Canada", displayName: "Canada", adminLevel: 0, regionId: CANADA };
const park = {
  placeId: 99,
  name: "Canada Park",
  displayName: "Canada Park, Ontario",
  adminLevel: null,
  regionId: null,
};
const preview = {
  count: 795,
  examples: [{ taxonId: 1, scientificName: "Araneus diadematus", commonName: "Cross Orbweaver" }],
  batches: 1,
  estimatedMinutes: 27,
};

const get = vi.fn();
const post = vi.fn();
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
  useRegions: () => ({ regions: [{ id: CANADA, name: "Canada" }], error: null, refresh: vi.fn() }),
}));

const { ApiError } = await import("../api/client");
const { default: AddSpeciesListModal } = await import("./AddSpeciesListModal");
const { ToastContext } = await import("../hooks/useToast");
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

beforeEach(() => {
  get.mockImplementation(async (path: string) =>
    path.includes("search/taxa")
      ? { results: [spiders, cattle] }
      : { results: path.includes("Canada") ? [park, canada] : [], inatUnavailable: null },
  );
  post.mockImplementation(async (path: string) =>
    path === "/species-lists/preview"
      ? preview
      : { created: true, list: { id: "l1", name: "Spiders of Canada", status: "queued" } },
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderModal(props: { regionId?: string; regionName?: string } = {}) {
  const onClose = vi.fn();
  render(
    <MemoryRouter>
      <ToastContext.Provider value={toast}>
        <AddSpeciesListModal {...props} onClose={onClose} />
      </ToastContext.Provider>
    </MemoryRouter>,
  );
  return { onClose };
}

const box = () => screen.getByRole("textbox", { name: "Group and place" });
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const searches = (kind: string) => get.mock.calls.map(([p]) => String(p)).filter((p) => p.includes(kind));

describe("AddSpeciesListModal", () => {
  it("turns a phrase into a group chip and a place chip, preferring a group and a Lifer region", async () => {
    renderModal();
    type("spiders of Canada");
    expect(await screen.findByRole("button", { name: "Group: Spiders, order Araneae" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Place: Canada" })).toBeTruthy();
    expect(searches("search/taxa")).toEqual(["/species-lists/search/taxa?q=spiders"]);
    expect(searches("search/places")).toEqual(["/species-lists/search/places?q=Canada"]);
  });

  it("searches once after typing settles, not on every key", async () => {
    renderModal();
    for (const text of ["s", "sp", "spi", "spid", "spider", "spiders"]) type(text);
    await screen.findByRole("button", { name: /^Group:/ });
    expect(searches("search/taxa")).toEqual(["/species-lists/search/taxa?q=spiders"]);
  });

  it("uses the Collection's region when the phrase names no place", async () => {
    renderModal({ regionId: CANADA, regionName: "Canada" });
    type("spiders");
    expect(await screen.findByRole("button", { name: "Place: Canada" })).toBeTruthy();
  });

  it("previews the list and adds it in the background, closing at once", async () => {
    const { onClose } = renderModal();
    type("spiders of Canada");
    const add = await screen.findByRole("button", { name: "Add 795 species to Canada" });
    expect(screen.getByText("Cross Orbweaver")).toBeTruthy();
    expect(screen.getByText(/About 27 minutes/)).toBeTruthy();
    fireEvent.click(add);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(post).toHaveBeenLastCalledWith("/species-lists", {
      taxonId: 47118,
      taxonName: "Spiders",
      taxonRank: "order",
      placeId: 6712,
      placeName: "Canada",
      nativeOnly: false,
      regionId: CANADA,
    });
    expect(toast.success).toHaveBeenCalledWith("Adding Spiders of Canada...");
  });

  it("previews again with native species only", async () => {
    renderModal();
    type("spiders of Canada");
    await screen.findByRole("button", { name: "Add 795 species to Canada" });
    fireEvent.click(screen.getByRole("switch", { name: "Native species only" }));
    await waitFor(() =>
      expect(post).toHaveBeenLastCalledWith(
        "/species-lists/preview",
        { taxonId: 47118, placeId: 6712, nativeOnly: true },
        expect.anything(),
      ),
    );
  });

  it("explains a big list instead of refusing it", async () => {
    post.mockResolvedValueOnce({ ...preview, count: 15_415, batches: 4 });
    renderModal();
    type("insects of Canada");
    expect(await screen.findByText(/added in 4 batches of 5,000 over time/)).toBeTruthy();
  });

  it("fills the group from a starter chip", async () => {
    renderModal({ regionId: CANADA, regionName: "Canada" });
    fireEvent.click(screen.getByRole("button", { name: "Butterflies and moths" }));
    expect(await screen.findByRole("button", { name: "Group: Butterflies and moths, order Lepidoptera" })).toBeTruthy();
    expect((box() as HTMLInputElement).value).toBe("Butterflies and moths");
  });

  it("asks for a group instead of searching for trees", async () => {
    renderModal({ regionId: CANADA, regionName: "Canada" });
    type("trees of Canada");
    expect(await screen.findByText(/isn't one group on iNaturalist/)).toBeTruthy();
    expect(searches("search/taxa")).toEqual([]);
  });

  it.each([
    ["offline", "You're offline. Try again when you're connected."],
    ["rate_limited", "iNaturalist is busy, try again in a few minutes."],
    ["refused", "iNaturalist is busy, try again in a few minutes."],
  ])("says what a %s preview means", async (code, message) => {
    post.mockRejectedValueOnce(new ApiError(503, "iNaturalist can't be reached right now", code));
    renderModal();
    type("spiders of Canada");
    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect((screen.getByRole("button", { name: "Add list" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the dialog open with the reason when adding is refused", async () => {
    const { onClose } = renderModal();
    type("spiders of Canada");
    const add = await screen.findByRole("button", { name: "Add 795 species to Canada" });
    post.mockRejectedValueOnce(new ApiError(400, "Pick the region to add this list to", "no_region"));
    fireEvent.click(add);
    expect((await screen.findByRole("alert")).textContent).toBe("Pick a place that has a Lifer region.");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("won't add to a place with no Lifer region", async () => {
    get.mockImplementation(async (path: string) =>
      path.includes("search/taxa") ? { results: [spiders] } : { results: [park], inatUnavailable: null },
    );
    renderModal();
    type("spiders of Canada Park");
    expect((await screen.findByRole("alert")).textContent).toBe("Pick a place that has a Lifer region.");
    expect((screen.getByRole("button", { name: "Add list" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
