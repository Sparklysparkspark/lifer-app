// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    patch: (...a: unknown[]) => patch(...a),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

const { default: TripSuggestions } = await import("./TripSuggestions");
const { default: TripDatesBar } = await import("./TripDatesBar");
const { ToastContext } = await import("../../hooks/useToast");
const { localIsoDate } = await import("@lifer/shared");

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };
const trip = {
  id: "t1",
  name: "Costa Rica 2026",
  description: null,
  sourceFolder: "/lib/Trips/Costa Rica 2026",
  destinationFolder: "/lib/Trips/Costa Rica 2026",
  coverCaptureId: null,
  coverCropX: null,
  coverCropY: null,
  coverCropSize: null,
  coverLayout: "single" as const,
  startDate: "2026-05-03",
  endDate: "2026-05-10",
  regionId: null,
  activeOverride: null,
};
const item = (captureId: string) => ({
  captureId,
  photoId: `p-${captureId}`,
  takenAt: "2026-05-04T12:00:00Z",
  scientificName: "Pharomachrus mocinno",
  commonName: "Resplendent Quetzal",
});
const wrap = (ui: React.ReactNode) => render(<ToastContext.Provider value={toast}>{ui}</ToastContext.Provider>);

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue({ changed: 1, movingFiles: true });
  patch.mockResolvedValue({ ok: true });
});

describe("TripSuggestions", () => {
  it("notes the photos taken during the trip and adds only the ones picked", async () => {
    get.mockResolvedValueOnce({ items: [item("c1"), item("c2")] }).mockResolvedValue({ items: [item("c2")] });
    const onChanged = vi.fn();
    wrap(<TripSuggestions trip={trip} onChanged={onChanged} />);
    expect(await screen.findByText(/2 photos taken during Costa Rica 2026 .* aren't in this trip/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    fireEvent.click(screen.getByRole("button", { name: "Add 1 to trip" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/trips/t1/captures", { captureIds: ["c1"] });
  });

  it("dismisses the picked photos instead of adding them", async () => {
    get.mockResolvedValueOnce({ items: [item("c1")] }).mockResolvedValue({ items: [] });
    wrap(<TripSuggestions trip={trip} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss 1" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/trips/t1/suggestions/dismiss", { captureIds: ["c1"] }));
  });
});

describe("TripDatesBar", () => {
  it("ends an open trip today, or marks it inactive", async () => {
    const onChanged = vi.fn();
    wrap(<TripDatesBar trip={{ ...trip, startDate: "2020-01-01", endDate: null }} onChanged={onChanged} />);
    expect(screen.getByText("Active")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "End trip" }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/trips/t1", { endDate: localIsoDate(), activeOverride: null }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark inactive" }));
    await waitFor(() => expect(patch).toHaveBeenLastCalledWith("/trips/t1", { activeOverride: false }));
  });

  it("offers to mark a past trip active again", async () => {
    wrap(<TripDatesBar trip={trip} onChanged={vi.fn()} />);
    expect(screen.queryByText("Active")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Mark active" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/trips/t1", { activeOverride: true }));
  });
});
