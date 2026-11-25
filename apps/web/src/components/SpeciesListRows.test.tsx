// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const CANADA = "00000000-0000-4000-8000-000000000001";
const list = (extra: object = {}) => ({
  id: "00000000-0000-4000-8000-0000000000aa",
  name: "Spiders of Canada",
  taxon: { id: 47118, name: "Spiders", rank: "order" },
  place: { id: 6712, name: "Canada" },
  regionId: CANADA,
  nativeOnly: false,
  sizeEstimate: 795,
  addedCount: 795,
  status: "done",
  lastError: null,
  nextBatchAt: null,
  capped: false,
  fetchingNow: false,
  photosReady: 795,
  hidden: false,
  targetListId: null,
  createdAt: "2026-11-25T00:00:00Z",
  updatedAt: "2026-11-25T00:00:00Z",
  lastRefreshedAt: null,
  ...extra,
});

const get = vi.fn();
const del = vi.fn();
const post = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    patch: vi.fn(),
    put: vi.fn(),
    delete: (...a: unknown[]) => del(...a),
  },
}));
vi.mock("../hooks/useRegions", () => ({
  useRegions: () => ({ regions: [{ id: CANADA, name: "Canada" }], error: null, refresh: vi.fn() }),
}));

const { SpeciesListRow } = await import("./SpeciesListRows");
const { default: SpeciesListsStatus } = await import("../pages/collection/SpeciesListsStatus");
const { ToastContext } = await import("../hooks/useToast");
const { ConfirmContext } = await import("../hooks/useConfirm");
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };
const confirm = vi.fn(async () => true);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

function wrap(ui: React.ReactNode) {
  return render(
    <MemoryRouter>
      <ToastContext.Provider value={toast}>
        <ConfirmContext.Provider value={confirm}>{ui}</ConfirmContext.Provider>
      </ToastContext.Provider>
    </MemoryRouter>,
  );
}

describe("SpeciesListRow", () => {
  it("offers Remove these targets only on a list that targets its species", async () => {
    const untargeted = list({ targetListId: null });
    post.mockResolvedValue({ list: untargeted });
    const onChanged = vi.fn();
    const { unmount } = wrap(<SpeciesListRow list={list() as never} onChanged={onChanged} onRemoved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    await screen.findByRole("menuitem", { name: "Remove list" });
    expect(screen.queryByRole("menuitem", { name: "Remove these targets" })).toBeNull();
    unmount();

    wrap(<SpeciesListRow list={list({ targetListId: CANADA }) as never} onChanged={onChanged} onRemoved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove these targets" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(untargeted));
    expect(post).toHaveBeenCalledWith(`/species-lists/${list().id}/untarget`);
    expect(toast.success).toHaveBeenCalledWith("The species of Spiders of Canada are no longer targets.");
  });

  it("removes after a confirm that names the exact consequence", async () => {
    del.mockResolvedValue({ removedSpecies: 783, kept: 12 });
    const onRemoved = vi.fn();
    wrap(<SpeciesListRow list={list() as never} onChanged={vi.fn()} onRemoved={onRemoved} />);
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove list" }));
    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith(list().id));
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Remove Spiders of Canada?",
        message: "Removes 795 species from Canada. Species you photographed or marked stay. This can't be undone.",
        danger: true,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith(
      "Removed Spiders of Canada. 12 species you photographed or marked stay.",
    );
  });

  it("keeps the list when the confirm is cancelled", async () => {
    confirm.mockResolvedValueOnce(false);
    wrap(<SpeciesListRow list={list() as never} onChanged={vi.fn()} onRemoved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove list" }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(del).not.toHaveBeenCalled();
  });

  it("shows progress while adding and the plain reason with Retry after a failure", () => {
    const { rerender } = wrap(
      <SpeciesListRow
        list={list({ status: "running", addedCount: 1200, sizeEstimate: 4000, photosReady: 0 }) as never}
        onChanged={vi.fn()}
        onRemoved={vi.fn()}
      />,
    );
    expect(screen.getByText("Adding: 1,200 of 4,000")).toBeTruthy();
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    rerender(
      <MemoryRouter>
        <ToastContext.Provider value={toast}>
          <ConfirmContext.Provider value={confirm}>
            <SpeciesListRow
              list={list({ status: "failed", lastError: "rate_limited" }) as never}
              onChanged={vi.fn()}
              onRemoved={vi.fn()}
            />
          </ConfirmContext.Provider>
        </ToastContext.Provider>
      </MemoryRouter>,
    );
    expect(screen.getByText("iNaturalist is busy, try again in a few minutes.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("SpeciesListsStatus", () => {
  it("polls while a list is being added and stops once none is", async () => {
    vi.useFakeTimers();
    get
      .mockResolvedValueOnce({ lists: [list({ status: "running", addedCount: 500, photosReady: 0 })] })
      .mockResolvedValue({ lists: [list()] });
    wrap(<SpeciesListsStatus regionId={CANADA} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText("Adding: 500 of 795")).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(get).toHaveBeenCalledTimes(2);
    // Done with every photo: the row leaves the Collection, a toast says so, and polling stops.
    expect(screen.queryByText(/Spiders of Canada/)).toBeNull();
    expect(toast.success).toHaveBeenCalledWith("Added Spiders of Canada: 795 species.");
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("doesn't poll while the window is hidden", async () => {
    vi.useFakeTimers();
    get.mockResolvedValue({ lists: [list({ status: "running", addedCount: 500 })] });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    wrap(<SpeciesListsStatus regionId={CANADA} />);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(get).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(get).toHaveBeenCalledTimes(2);
  });
});
