// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    patch: (...a: unknown[]) => patch(...a),
  },
}));
vi.mock("../hooks/useReviewCount", () => ({ refreshReviewCount: vi.fn() }));
// The picker's search is out of scope: one click picks a fixed species.
vi.mock("../components/SpeciesPicker", () => ({
  default: ({ onSelect, ariaLabel }: { onSelect: (r: object) => void; ariaLabel: string }) => (
    <button
      onClick={() => onSelect({ id: "sp-gull", commonName: "Glaucous Gull", scientificName: "Larus hyperboreus" })}
    >
      {ariaLabel}
    </button>
  ),
}));
const openViewer = vi.fn();
vi.mock("../components/Lightbox", () => ({ useLightbox: () => ({ open: openViewer, node: null }) }));

const { default: ReviewPage } = await import("./ReviewPage");
const { ToastContext } = await import("../hooks/useToast");

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };
const encounter = (id: string, name: string) => ({
  speciesId: `sp-${id}`,
  scientificName: name,
  commonName: name,
  regionId: null,
  captureIds: [`cap-${id}`],
  photoIds: [`photo-${id}`],
  count: 1,
  earliestTakenAt: null,
  latestTakenAt: null,
  lowestPercent: 90,
  coverPhotoId: `photo-${id}`,
  possibleLifer: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  get.mockImplementation((path: string) =>
    path === "/identifications/suggested"
      ? Promise.resolve({
          suggestedCount: 2,
          confirmedCount: 0,
          encounterCount: 2,
          encounters: [encounter("a", "Osprey"), encounter("b", "Merlin")],
        })
      : Promise.resolve({ suggestions: [] }),
  );
  post.mockResolvedValue({ ok: true, confirmed: 1 });
  patch.mockResolvedValue({});
});
afterEach(() => vi.useRealTimers());

function renderPage() {
  return render(
    <ToastContext.Provider value={toast}>
      <MemoryRouter>
        <ReviewPage />
      </MemoryRouter>
    </ToastContext.Provider>,
  );
}
const lastToastUndo = () => vi.mocked(toast.show).mock.calls.at(-1)![1]!.actions![0].onClick;

describe("ReviewPage", () => {
  it("confirms at once on screen, sends it only once Undo has passed, and Undo brings it back", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm 1 photo" }));
    expect(screen.getByRole("heading", { name: "Merlin" })).toBeTruthy();
    expect(vi.mocked(toast.show).mock.calls.at(-1)![0]).toBe("Confirmed 1 photo as Osprey");
    act(() => lastToastUndo()());
    expect(screen.getByRole("heading", { name: "Osprey" })).toBeTruthy();

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Confirm 1 photo" }));
    expect(post).not.toHaveBeenCalled();
    await act(async () => void vi.advanceTimersByTime(8000));
    expect(post).toHaveBeenCalledWith("/identifications/confirm", { captureIds: ["cap-a"] });
  });

  it("files a sighting as any species from the picker", async () => {
    renderPage();
    const other = await screen.findByRole("button", { name: "Another species" });
    vi.useFakeTimers();
    fireEvent.click(other);
    expect(vi.mocked(toast.show).mock.calls.at(-1)![0]).toBe("Filed 1 photo as Glaucous Gull");
    await act(async () => void vi.advanceTimersByTime(8000));
    expect(patch).toHaveBeenCalledWith(expect.stringContaining("cap-a"), { speciesId: "sp-gull" });
  });

  it("opens the shown photo full size", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Osprey" }));
    expect(openViewer).toHaveBeenCalledWith([expect.objectContaining({ url: "/api/photos/photo-a/display" })], 0);
  });

  it("when the loaded sightings are done but more wait, sends the last decision and loads the next ones", async () => {
    get.mockImplementation((path: string) =>
      path === "/identifications/suggested"
        ? Promise.resolve({
            suggestedCount: 3,
            confirmedCount: 0,
            encounterCount: 3,
            encounters: [encounter("a", "Osprey")],
          })
        : Promise.resolve({ suggestions: [] }),
    );
    renderPage();
    expect(await screen.findByText("2 more sightings after these")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm 1 photo" }));
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith("/identifications/confirm", { captureIds: ["cap-a"] }));
    await vi.waitFor(() => expect(get.mock.calls.filter((c) => c[0] === "/identifications/suggested")).toHaveLength(2));
  });
});
