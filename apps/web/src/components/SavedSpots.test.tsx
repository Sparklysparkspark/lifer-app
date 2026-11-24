// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const get = vi.fn().mockResolvedValue({ running: false, canUndo: false });
const post = vi.fn();
const patch = vi.fn();
const del = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    patch: (...a: unknown[]) => patch(...a),
    delete: (...a: unknown[]) => del(...a),
  },
}));
const toast = { show: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() };
vi.mock("../hooks/useToast", () => ({ useToast: () => toast }));

// The map itself needs WebGL; the form around it is what's tested here.
vi.mock("./PointPickerMap", () => ({ default: () => null }));
vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ features: [] }) }));

const { AddSpotModal, SavedSpotsList } = await import("./SavedSpots");

const NAME = "King Fisher Pond on the north side of the Cottonwood Island Nature Park trail, past the second bridge";
const spot = {
  id: "s1",
  name: NAME,
  lat: 53.9,
  lon: -122.75,
  regionId: null,
  regionName: "British Columbia",
  geoprivacy: "obscured" as const,
  radiusM: 100,
  locality: "British Columbia, Canada",
  localitySource: "region" as const,
  notes: null,
  origin: "map" as const,
  lastUsedAt: null,
  photoCount: 42,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderList() {
  const reload = vi.fn().mockResolvedValue(undefined);
  render(
    <MemoryRouter>
      <SavedSpotsList spots={[spot]} nearby={{ s1: 3 }} reload={reload} label="Saved spots" />
    </MemoryRouter>,
  );
  return reload;
}

async function edit() {
  fireEvent.contextMenu(screen.getByText(NAME));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
}

describe("SavedSpotsList", () => {
  it("removes a spot with an Undo that puts the same spot back", async () => {
    del.mockResolvedValue({ ok: true });
    post.mockResolvedValue({ ...spot, id: "s2" });
    const reload = renderList();
    fireEvent.contextMenu(screen.getByText(NAME));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove spot" }));
    await waitFor(() => expect(toast.show).toHaveBeenCalled());
    expect(del).toHaveBeenCalledWith("/saved-spots/s1");
    const [message, options] = toast.show.mock.calls[0];
    expect(message).toBe(`Removed ${NAME}.`);
    reload.mockClear();
    options.actions[0].onClick();
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/saved-spots", {
      name: NAME,
      lat: 53.9,
      lon: -122.75,
      regionId: null,
      geoprivacy: "obscured",
      radiusM: 100,
      notes: null,
      origin: "map",
    });
  });

  it("shows the locality, the photos near it that aren't in it, and the privacy", () => {
    renderList();
    expect(screen.getByText("British Columbia, Canada")).toBeTruthy();
    expect(screen.getByText("3 photos near here aren't in this place yet")).toBeTruthy();
    expect(screen.getByText("Hidden on iNaturalist")).toBeTruthy();
    expect(screen.getByText(NAME).className).not.toContain("truncate");
  });

  it("renames the photos too by default, and Undo puts both back", async () => {
    patch.mockResolvedValue({ ...spot, name: "Kingfisher Pond", relabelled: 42 });
    post.mockResolvedValue({ restored: 42, canUndo: false });
    renderList();
    await edit();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Kingfisher Pond" } });
    const box = screen.getByRole("checkbox", { name: "Also rename it on 42 photos" }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.change(screen.getByLabelText("Size"), { target: { value: "250" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toast.show).toHaveBeenCalled());
    expect(patch).toHaveBeenCalledWith("/saved-spots/s1", {
      name: "Kingfisher Pond",
      radiusM: 250,
      geoprivacy: "obscured",
      notes: null,
      renamePhotos: true,
    });
    const [message, options] = toast.show.mock.calls[0];
    expect(message).toBe("Renamed on 42 photos");
    options.actions[0].onClick();
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/saved-spots/s1", { name: NAME }));
    expect(post).toHaveBeenCalledWith("/captures/location/undo");
  });

  it("leaves the photos alone when unticked, and saves a typed locality", async () => {
    patch.mockResolvedValue({ ...spot, name: "Pond" });
    renderList();
    await edit();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Pond" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Also rename it on 42 photos" }));
    fireEvent.change(screen.getByLabelText("Town or area"), { target: { value: "Prince George" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0][1]).toEqual({
      name: "Pond",
      radiusM: 100,
      geoprivacy: "obscured",
      notes: null,
      locality: "Prince George",
    });
    expect(toast.show).not.toHaveBeenCalled();
  });

  it("works a typed locality out again: cleared and sent as null on save", async () => {
    const typed = { ...spot, locality: "Behind the mill", localitySource: "user" as const };
    patch.mockResolvedValue({
      ...typed,
      locality: "Prince George, British Columbia, Canada",
      localitySource: "gazetteer",
    });
    render(
      <MemoryRouter>
        <SavedSpotsList spots={[typed]} nearby={{}} reload={vi.fn().mockResolvedValue(undefined)} label="Saved spots" />
      </MemoryRouter>,
    );
    await edit();
    fireEvent.click(screen.getByRole("button", { name: "Work it out again" }));
    expect(screen.getByLabelText("Town or area")).toHaveProperty("value", "");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0][1]).toMatchObject({ locality: null });
  });
});

describe("AddSpotModal", () => {
  it("keeps the coordinates when a town is picked for the metadata", async () => {
    get.mockImplementation(async (url: string) =>
      String(url).startsWith("/places/locate")
        ? {
            places: [
              {
                kind: "town",
                id: "1",
                name: "Prince George",
                detail: "British Columbia, Canada",
                lat: 53.917,
                lon: -122.75,
                regionId: null,
                bbox: null,
                group: null,
                locality: "Prince George, British Columbia, Canada",
                geoprivacy: null,
                radiusM: null,
                distanceM: null,
                recognised: false,
              },
            ],
            nextOffset: null,
          }
        : { running: false, canUndo: false },
    );
    render(<AddSpotModal onClose={vi.fn()} onAdded={vi.fn()} initialPoint={{ lat: 54.00162, lon: -122.6984 }} />);
    const coords = screen.getByLabelText("Latitude and longitude") as HTMLInputElement;
    const before = coords.value;
    const town = screen.getByRole("combobox", { name: "Town or area" });
    fireEvent.focus(town);
    fireEvent.change(town, { target: { value: "prince" } });
    fireEvent.click(await screen.findByRole("option", { name: "Prince George, British Columbia, Canada" }));
    expect(coords.value).toBe(before);
  });

  it("finds a town for Town or area, which fills the text only, leaves the pin alone until asked and names an unnamed place", async () => {
    get.mockImplementation(async (url: string) =>
      String(url).startsWith("/places/locate")
        ? {
            places: [
              {
                kind: "town",
                id: "6113335",
                name: "Prince George",
                detail: "British Columbia, Canada",
                lat: 53.917,
                lon: -122.75,
                regionId: null,
                bbox: null,
                group: null,
                locality: "Prince George, British Columbia, Canada",
                geoprivacy: null,
                radiusM: null,
                distanceM: null,
                recognised: false,
              },
            ],
            nextOffset: null,
          }
        : { running: false, canUndo: false },
    );
    post.mockImplementation(async (_url: string, body: object) => ({ id: "n1", ...body }));
    render(<AddSpotModal onClose={vi.fn()} onAdded={vi.fn()} />);
    const town = screen.getByRole("combobox", { name: "Town or area" });
    expect(screen.getByText("Left empty, Lifer fills it in from the point")).toBeTruthy();
    fireEvent.focus(town);
    fireEvent.change(town, { target: { value: "prince" } });
    fireEvent.click(await screen.findByRole("option", { name: "Prince George, British Columbia, Canada" }));
    expect((town as HTMLInputElement).value).toBe("Prince George, British Columbia, Canada");
    expect(screen.getByText("From Lifer's town list")).toBeTruthy();
    const coords = screen.getByLabelText("Latitude and longitude") as HTMLInputElement;
    expect(coords.value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Move the pin here" }));
    expect(coords.value).toMatch(/^53\.917/);
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Prince George");
    // Free text is still the user's own.
    fireEvent.change(town, { target: { value: "Near Prince George" } });
    expect(screen.getByText("Typed by you")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).toMatchObject({ locality: "Near Prince George", lat: 53.917, lon: -122.75 });
  });
});
