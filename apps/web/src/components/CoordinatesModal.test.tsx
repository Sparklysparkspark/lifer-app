// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const post = vi.fn();
const get = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));
const toast = { show: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() };
vi.mock("../hooks/useToast", () => ({ useToast: () => toast }));

const { default: CoordinatesModal } = await import("./CoordinatesModal");

afterEach(() => vi.clearAllMocks());

function renderModal(props: Partial<Parameters<typeof CoordinatesModal>[0]> = {}) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(
    <MemoryRouter>
      <CoordinatesModal captureIds={["c1"]} suggestRegion={false} onSaved={onSaved} onClose={onClose} {...props} />
    </MemoryRouter>,
  );
  return { onSaved, onClose };
}

const field = () => screen.getByLabelText("Latitude and longitude");
const save = () => screen.getByRole("button", { name: "Save" });

describe("CoordinatesModal", () => {
  it("edits one photo's place name and region without touching its point", async () => {
    post.mockResolvedValue({ updated: 1 });
    get.mockResolvedValue({ regions: [], places: [], spots: [] });
    const { onSaved } = renderModal({ lat: 49.2, lon: -123.1, place: { label: "Old", regionId: null } });
    fireEvent.click(screen.getByRole("button", { name: "Edit name and region" }));
    fireEvent.change(screen.getByLabelText("Place name"), { target: { value: "Burnaby Lake" } });
    fireEvent.change(field(), { target: { value: "" } });
    fireEvent.click(save());
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/captures/coordinates", {
      captureIds: ["c1"],
      lat: null,
      lon: null,
      keepPoint: true,
      locationLabel: "Burnaby Lake",
    });
    expect(onSaved).toHaveBeenCalledWith({ lat: 49.2, lon: -123.1 }, null);
  });

  it("never sends the place name when it wasn't changed", async () => {
    post.mockResolvedValue({ updated: 1 });
    renderModal({ place: { label: "Kept", regionId: null } });
    fireEvent.change(field(), { target: { value: "49.2827, -123.1207" } });
    fireEvent.click(save());
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).not.toHaveProperty("locationLabel");
  });

  it("offers Undo after a save, through the shared location history", async () => {
    post.mockResolvedValue({ updated: 1, restored: 1 });
    const onUndone = vi.fn();
    const { onClose } = renderModal({ onUndone });
    fireEvent.change(field(), { target: { value: "49.2827, -123.1207" } });
    fireEvent.click(save());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const [message, opts] = toast.show.mock.calls[0] as [
      string,
      { actions: Array<{ label: string; onClick: () => void }> },
    ];
    expect(message).toBe("Coordinates saved");
    opts.actions.find((a) => a.label === "Undo")!.onClick();
    await waitFor(() => expect(onUndone).toHaveBeenCalled());
    expect(post).toHaveBeenLastCalledWith("/captures/location/undo");
  });

  it("offers Undo from the viewer too, putting the earlier point back on its copy", async () => {
    post.mockResolvedValue({ updated: 1, restored: 1 });
    const { onSaved, onClose } = renderModal({ lat: 10, lon: 20 });
    fireEvent.change(field(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear coordinates" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const opts = toast.show.mock.calls[0][1] as { actions: Array<{ label: string; onClick: () => void }> };
    opts.actions.find((a) => a.label === "Undo")!.onClick();
    await waitFor(() => expect(onSaved).toHaveBeenLastCalledWith({ lat: 10, lon: 20 }, null));
    expect(post).toHaveBeenLastCalledWith("/captures/location/undo");
  });

  it("explains unreadable input and keeps Save off", () => {
    renderModal();
    fireEvent.change(field(), { target: { value: "95, 10" } });
    expect(screen.getByText("Latitude must be between -90 and 90.")).toBeTruthy();
    expect(save().hasAttribute("disabled")).toBe(true);
  });

  it("saves a pasted Google Maps point", async () => {
    post.mockResolvedValue({ updated: 1 });
    const { onSaved, onClose } = renderModal();
    fireEvent.change(field(), { target: { value: `49°16'57.7"N 123°07'14.5"W` } });
    expect(screen.getByText("Reads as 49.28269, -123.12069")).toBeTruthy();
    fireEvent.click(save());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/captures/coordinates", {
      captureIds: ["c1"],
      lat: 49.282694,
      lon: -123.120694,
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith({ ok: true, lat: 49.282694, lon: -123.120694 }, null);
  });

  it("offers the region at the point and sets it only when ticked", async () => {
    post.mockResolvedValue({ updated: 1 });
    get.mockResolvedValue({ region: { id: "r1", name: "British Columbia" } });
    const { onSaved } = renderModal({ suggestRegion: true });
    fireEvent.change(field(), { target: { value: "49.2827, -123.1207" } });
    const box = await screen.findByRole("checkbox", { name: "Also set the region to British Columbia" });
    expect((box as HTMLInputElement).checked).toBe(false);
    fireEvent.click(box);
    fireEvent.click(save());
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    // In the same call as the point, so one Undo puts both back.
    expect(post).toHaveBeenCalledWith("/captures/coordinates", {
      captureIds: ["c1"],
      lat: 49.2827,
      lon: -123.1207,
      regionId: "r1",
    });
    expect(post).not.toHaveBeenCalledWith("/captures/location", expect.anything());
    expect(onSaved.mock.calls[0][1]).toEqual({ id: "r1", name: "British Columbia" });
  });

  it("clears a photo's coordinates", async () => {
    post.mockResolvedValue({ updated: 1 });
    const { onSaved } = renderModal({ lat: 10, lon: 20 });
    expect((field() as HTMLInputElement).value).toBe("10.00000, 20.00000");
    fireEvent.click(screen.getByRole("button", { name: "Clear coordinates" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(null, null));
    expect(post).toHaveBeenCalledWith("/captures/coordinates", { captureIds: ["c1"], lat: null, lon: null });
  });

  it("files the photos under a picked place, asking first about ones taken far away", async () => {
    const pond = {
      kind: "spot",
      id: "s1",
      name: "King Fisher Pond",
      detail: "British Columbia",
      lat: 53.9,
      lon: -122.75,
      regionId: "bc",
      bbox: null,
      group: "nearby",
      locality: null,
      geoprivacy: "open",
      radiusM: 100,
      distanceM: 30,
      recognised: true,
    };
    get.mockResolvedValue({ places: [pond], nextOffset: null });
    post.mockImplementation((url: string) =>
      Promise.resolve(url.endsWith("/far") ? { count: 2, km: 40 } : { ok: true, applied: 3 }),
    );
    const { onSaved, onClose } = renderModal({ captureIds: ["c1", "c2", "c3"] });
    fireEvent.focus(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByText("This looks like King Fisher Pond"));
    expect(screen.getByText("Files under King Fisher Pond. A photo's own GPS stays.")).toBeTruthy();
    fireEvent.click(save());
    expect(await screen.findByText("2 photos were taken up to 40 km from here. File them here anyway?")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "File here" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/saved-spots/s1/apply", {
      captureIds: ["c1", "c2", "c3"],
      moveOwnPoints: false,
      wait: true,
    });
    expect(post).not.toHaveBeenCalledWith("/captures/coordinates", expect.anything());
    expect(onSaved).toHaveBeenCalledWith({ lat: 53.9, lon: -122.75 }, { id: "bc", name: "British Columbia" });
    expect(toast.show).toHaveBeenCalledWith("3 photos filed under this spot", expect.anything());
  });
});
