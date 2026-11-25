// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a) },
}));

vi.mock("../Lightbox", () => ({
  default: ({ slides, index }: { slides: Array<{ url: string }>; index: number }) => (
    <div role="dialog" data-testid="viewer">
      {index + 1} of {slides.length}: {slides[index].url}
    </div>
  ),
}));

// The shared picker, reduced to its result: the user picks Canada.
vi.mock("../SetRegionDialog", () => ({
  default: ({ count, onSet, onClose }: { count: number; onSet: (id: string, label: string) => void; onClose: () => void }) => (
    <div role="dialog" aria-label={`Set region of ${count}`}>
      <button
        onClick={() => {
          onSet("canada", "");
          onClose();
        }}
      >
        Pick Canada
      </button>
    </div>
  ),
}));

const { default: NeedsPlacingTray } = await import("./NeedsPlacingTray");

const group = (key: string, tripId: string | null, count: number) => ({
  key,
  tripId,
  tripName: tripId ? "Coast trip" : null,
  tripCount: 5,
  regionId: null,
  regionName: null,
  count,
  coverPhotoIds: ["c1"],
  from: null,
  to: null,
});

function serve() {
  get.mockImplementation((path: string) =>
    path.startsWith("/gallery/map/unplaced/photos")
      ? Promise.resolve({ captureIds: ["a", "b", "c", "d"], photoIds: ["pa", "pb", "pc", "pd"] })
      : Promise.resolve({ groups: [group("k1", "t1", 4), group("k2", null, 1)], nextCursor: null }),
  );
}

afterEach(() => vi.clearAllMocks());

function renderTray(onPlace = vi.fn(), onSetRegion = vi.fn().mockResolvedValue(true)) {
  render(
    <NeedsPlacingTray
      queryString="taxa=aves"
      counts={{ all: 5, region: 0, none: 5 }}
      pinDown
      notes={() => null}
      refreshKey={0}
      busy={false}
      onPlace={onPlace}
      onSetRegion={onSetRegion}
      onDragSource={() => {}}
    />,
  );
  return onPlace;
}

describe("NeedsPlacingTray", () => {
  it("heads each trip once and lists the rest under Not in a trip", async () => {
    serve();
    renderTray();
    expect(await screen.findByText("Coast trip (5 photos)")).toBeTruthy();
    expect(screen.getByText("Not in a trip")).toBeTruthy();
    expect(screen.getByText("4 photos, no date")).toBeTruthy();
  });

  it("opens a clicked photo in the viewer, with ticks only in select mode", async () => {
    serve();
    renderTray();
    fireEvent.click((await screen.findAllByRole("button", { name: "Show photos" }))[0]);
    await waitFor(() => expect(screen.getAllByTestId("photo-tile")).toHaveLength(4));
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    fireEvent.click(screen.getAllByTestId("photo-tile")[2].querySelector("button")!);
    expect(screen.getByTestId("viewer").textContent).toBe("3 of 4: /api/photos/pc/display");
  });

  it("previews from the row's thumbnail stack", async () => {
    serve();
    renderTray();
    fireEvent.click((await screen.findAllByRole("button", { name: "Preview photo 1" }))[0]);
    expect(await screen.findByTestId("viewer")).toBeTruthy();
  });

  it("ticks a range in select mode and places only the ticked photos", async () => {
    serve();
    const onPlace = renderTray();
    fireEvent.click((await screen.findAllByRole("button", { name: "Show photos" }))[0]);
    await waitFor(() => expect(screen.getAllByTestId("photo-tile")).toHaveLength(4));
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    const boxes = screen.getAllByRole("checkbox");
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[2], { shiftKey: true });
    expect(screen.queryByTestId("viewer")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Place 3 photos here" }));
    expect(await onPlace.mock.calls[0][0].ids()).toEqual(["a", "b", "c"]);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: "Place 4 photos here" })).toHaveLength(1);
  });

  it("enters select mode with a Cmd-click instead of previewing", async () => {
    serve();
    renderTray();
    fireEvent.click((await screen.findAllByRole("button", { name: "Show photos" }))[0]);
    await waitFor(() => expect(screen.getAllByTestId("photo-tile")).toHaveLength(4));
    fireEvent.click(screen.getAllByTestId("photo-tile")[1].querySelector("button")!, { metaKey: true });
    expect(screen.queryByTestId("viewer")).toBeNull();
    // The ticked photo, beside the other group's single photo.
    expect(screen.getAllByRole("button", { name: "Place 1 photo here" })).toHaveLength(2);
    expect(screen.getAllByRole("checkbox")).toHaveLength(4);
  });

  it("fetches a whole group's ids only when it is placed", async () => {
    serve();
    const onPlace = renderTray();
    fireEvent.click((await screen.findAllByRole("button", { name: "Place 1 photo here" }))[0]);
    expect(get.mock.calls.some((c) => String(c[0]).includes("unplaced/photos"))).toBe(false);
    await onPlace.mock.calls[0][0].ids();
    expect(String(get.mock.calls.find((c) => String(c[0]).includes("unplaced/photos"))?.[0])).toContain("key=k2");
  });

  it("changes the region of one row's photos only", async () => {
    serve();
    const onSetRegion = vi.fn().mockResolvedValue(true);
    renderTray(vi.fn(), onSetRegion);
    fireEvent.click((await screen.findAllByRole("button", { name: "Change region" }))[1]);
    fireEvent.click(screen.getByRole("button", { name: "Pick Canada" }));
    await waitFor(() => expect(onSetRegion).toHaveBeenCalledWith(["a", "b", "c", "d"], { id: "canada", label: "" }));
    const fetched = get.mock.calls.map((c) => String(c[0])).filter((p) => p.includes("unplaced/photos"));
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toContain("key=k2");
  });

  it("changes the region of the ticked photos when some are ticked", async () => {
    serve();
    const onSetRegion = vi.fn().mockResolvedValue(true);
    renderTray(vi.fn(), onSetRegion);
    fireEvent.click((await screen.findAllByRole("button", { name: "Show photos" }))[0]);
    await waitFor(() => expect(screen.getAllByTestId("photo-tile")).toHaveLength(4));
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    fireEvent.click(screen.getAllByRole("button", { name: "Change region" })[0]);
    expect(screen.getByRole("dialog", { name: "Set region of 1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pick Canada" }));
    await waitFor(() => expect(onSetRegion).toHaveBeenCalledWith(["b"], { id: "canada", label: "" }));
  });

  it("offers Place all and Change region for a trip once all its groups are loaded", async () => {
    get.mockImplementation((path: string) =>
      path.startsWith("/gallery/map/unplaced/photos")
        ? Promise.resolve({ captureIds: [path.includes("key=k1") ? "a" : "b"], photoIds: ["pa"] })
        : Promise.resolve({ groups: [group("k1", "t1", 2), group("k2", "t1", 3)], nextCursor: null }),
    );
    const onPlace = vi.fn();
    const onSetRegion = vi.fn().mockResolvedValue(true);
    renderTray(onPlace, onSetRegion);
    fireEvent.click(await screen.findByRole("button", { name: "Place 5 photos here" }));
    expect(await onPlace.mock.calls[0][0].ids()).toEqual(["a", "b"]);
    // Two rows and the trip heading.
    const changes = screen.getAllByRole("button", { name: "Change region" });
    expect(changes).toHaveLength(3);
    fireEvent.click(changes[0]);
    fireEvent.click(screen.getByRole("button", { name: "Pick Canada" }));
    await waitFor(() => expect(onSetRegion).toHaveBeenCalledWith(["a", "b"], { id: "canada", label: "" }));
  });

  it("leaves trip-wide actions off while part of the trip is on a later page", async () => {
    serve();
    renderTray();
    await screen.findByText("Coast trip (5 photos)");
    // One per row; none on the heading of a trip with a photo not loaded.
    expect(screen.getAllByRole("button", { name: "Change region" })).toHaveLength(2);
  });
});
