// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollectionItem } from "@lifer/shared";

const patch = vi.fn().mockResolvedValue({});
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: { get: () => new Promise(() => {}), post: vi.fn(), put: vi.fn(), patch, delete: vi.fn() },
}));
// The real editor needs a loaded image to measure; this stand-in shows what it was opened with.
vi.mock("./CardCropEditor", () => ({
  default: (p: {
    initialX: number | null;
    initialY: number | null;
    initialSize: number | null;
    onSave: (c: object) => Promise<void>;
    onReset: () => Promise<void>;
  }) => (
    <div>
      <span>{`initial ${p.initialX} ${p.initialY} ${p.initialSize}`}</span>
      <button type="button" onClick={() => void p.onSave({ x: 1, y: 2, size: 30 })}>
        Save crop
      </button>
      <button type="button" onClick={() => void p.onReset()}>
        Reset crop
      </button>
    </div>
  ),
}));
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

const { default: SpeciesCard } = await import("./SpeciesCard");
const { ConfirmContext } = await import("../hooks/useConfirm");
const { ToastContext } = await import("../hooks/useToast");
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

afterEach(() => {
  cleanup();
  patch.mockClear();
});

const item = {
  speciesId: "s1",
  commonName: "Steller's Jay",
  scientificName: "Cyanocitta stelleri",
  state: "collected",
  taxonClass: "aves",
  isTarget: false,
  tier: null,
  localTier: null,
  // A trip card: the trip's own photo of the species, with that photo's crop.
  coverPhotoUrl: "/api/photos/trip-photo/thumb",
  cardCropX: 10,
  cardCropY: 20,
  cardCropSize: 40,
} as unknown as CollectionItem;

async function openEditor() {
  const onChanged = vi.fn();
  render(
    <ToastContext.Provider value={toast}>
      <ConfirmContext.Provider value={vi.fn().mockResolvedValue(false)}>
        <MemoryRouter>
          <SpeciesCard item={item} onChanged={onChanged} />
        </MemoryRouter>
      </ConfirmContext.Provider>
    </ToastContext.Provider>,
  );
  fireEvent.click(screen.getAllByRole("button", { name: /more/i })[0]);
  fireEvent.click(await screen.findByRole("menuitem", { name: /adjust/i }));
  return onChanged;
}

describe("SpeciesCard crop", () => {
  it("opens on the shown photo's crop and saves it for that photo, then reloads", async () => {
    const onChanged = await openEditor();
    expect(screen.getByText("initial 10 20 40")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save crop" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith("s1", "reload"));
    expect(patch).toHaveBeenCalledWith("/species/s1/card-crop", { x: 1, y: 2, size: 30, photoId: "trip-photo" });
  });

  it("resets the shown photo's crop", async () => {
    await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Reset crop" }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/species/s1/card-crop", { reset: true, photoId: "trip-photo" }),
    );
  });
});

describe("SpeciesCard remove from list", () => {
  it("takes off your own addition with an Undo that adds it back", async () => {
    const { api } = await import("../api/client");
    vi.mocked(api.delete).mockResolvedValue({});
    vi.mocked(api.put).mockResolvedValue({ ok: true, added: true, alreadyOnChecklist: false });
    const onChanged = vi.fn();
    const added = { ...item, userAddedRegion: { id: "r1", name: "Freedonia", kind: "region" } } as CollectionItem;
    render(
      <ToastContext.Provider value={toast}>
        <ConfirmContext.Provider value={vi.fn().mockResolvedValue(false)}>
          <MemoryRouter>
            <SpeciesCard item={added} onChanged={onChanged} />
          </MemoryRouter>
        </ConfirmContext.Provider>
      </ToastContext.Provider>,
    );
    fireEvent.click(screen.getAllByRole("button", { name: /more/i })[0]);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove from this list" }));
    await waitFor(() => expect(toast.show).toHaveBeenCalled());
    expect(api.delete).toHaveBeenCalledWith("/regions/r1/checklist-additions/s1");
    const [, options] = toast.show.mock.lastCall!;
    onChanged.mockClear();
    options.actions[0].onClick();
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith("s1", "reload"));
    expect(api.put).toHaveBeenCalledWith("/regions/r1/checklist-additions/s1");
  });
});

describe("SpeciesCard photo-filled layout", () => {
  function renderCard(props: { overlay?: boolean; photoCount?: number }) {
    render(
      <ToastContext.Provider value={toast}>
        <ConfirmContext.Provider value={vi.fn().mockResolvedValue(false)}>
          <MemoryRouter>
            <SpeciesCard item={{ ...item, photoCount: props.photoCount }} overlay={props.overlay} />
          </MemoryRouter>
        </ConfirmContext.Provider>
      </ToastContext.Provider>,
    );
  }

  it("counts your photos at the top right, outside the link, only on a photo-filled card", () => {
    renderCard({ overlay: true, photoCount: 1204 });
    const count = screen.getByRole("img", { name: "1,204 photos" });
    expect(count.textContent).toBe("1,204");
    expect(screen.getByRole("link").contains(count)).toBe(false);
    cleanup();
    renderCard({ overlay: false, photoCount: 14 });
    expect(screen.queryByRole("img", { name: "14 photos" })).toBeNull();
  });

  it("shows no count without photos", () => {
    renderCard({ overlay: true, photoCount: 0 });
    expect(screen.queryByRole("img", { name: /photos/ })).toBeNull();
  });
});
