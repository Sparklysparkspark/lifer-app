// @vitest-environment jsdom
// Setting a location in Lifer for sightings sent to iNaturalist without one: the states on a
// sighting, the one and many flows, offline, and the question when iNaturalist already has one.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };
vi.mock("../../hooks/useToast", () => ({ useToast: () => toast }));
// The place step itself has its own tests (components/PlaceStep.test.tsx).
const placeStep = vi.fn(async (_request: { captureIds: string[] }) => "placed" as "placed" | null);
vi.mock("../../hooks/usePlaceStep", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/usePlaceStep")>()),
  usePlaceStep: () => placeStep,
}));
vi.mock("../../lib/openExternal", () => ({ openExternal: vi.fn() }));
// The selection bar measures its buttons; jsdom has no ResizeObserver.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);

const { default: ObservationsTab } = await import("./ObservationsTab");
type Summary = import("./ObservationsTab").ObservationSummary;

const observation = (id: string, extra: Partial<Summary> = {}): Summary => ({
  observationId: id,
  speciesId: `s-${id}`,
  scientificName: `Species ${id} sci`,
  commonName: `Bird ${id}`,
  currentPhotoId: null,
  createdAt: "2026-06-05T10:00:00.000Z",
  confirmedAt: null,
  url: `https://www.inaturalist.org/observations/${id}`,
  editUrl: `https://www.inaturalist.org/observations/${id}/edit`,
  photoCount: 1,
  observedAt: "2026-06-04T10:00:00.000Z",
  latestAt: null,
  photoIds: [`p-${id}`],
  sentLocation: false,
  dateFromInat: false,
  captureIds: [`c-${id}`],
  noLocationOnInat: true,
  locationUpdate: null,
  ...extra,
});

const result = (r: object) => ({
  running: false,
  error: null,
  result: { updated: 0, waiting: 0, failed: 0, conflicts: 0, conflictIds: [], ...r },
});
const onChanged = vi.fn();

function Tab({ observations }: { observations: Summary[] }) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  return (
    <MemoryRouter>
      <div ref={setSlot} />
      <ObservationsTab mode="pending" observations={observations} barSlot={slot} onChanged={onChanged} />
    </MemoryRouter>
  );
}
const locationPosts = () => post.mock.calls.filter(([url]) => url === "/inaturalist/observations/location");
const menuOf = (name: string) => {
  fireEvent.contextMenu(screen.getByRole("option", { name }), { clientX: 30, clientY: 30 });
  return screen.getAllByRole("menuitem").map((i) => i.textContent);
};
const openWindow = async (name: string) => {
  fireEvent.keyDown(screen.getByRole("option", { name }), { key: "Enter" });
  return screen.findByRole("complementary");
};

beforeEach(() => {
  localStorage.clear();
  get.mockReset().mockResolvedValue(result({ updated: 1 }));
  post.mockReset().mockResolvedValue({ started: true });
  placeStep.mockReset().mockResolvedValue("placed");
  onChanged.mockReset();
  Object.values(toast).forEach((f) => f.mockReset());
});
afterEach(cleanup);

describe("a sighting sent without a location", () => {
  it("says iNaturalist has none in place of Needs a location, and offers Set location", () => {
    render(
      <Tab observations={[observation("1"), observation("2", { noLocationOnInat: false, sentLocation: true })]} />,
    );
    const card = screen.getByRole("option", { name: "Bird 1" });
    expect(within(card).getByText("No location on iNaturalist")).toBeTruthy();
    expect(within(card).queryByText("Needs a location")).toBeNull();
    expect(menuOf("Bird 1")).toContain("Set location");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(menuOf("Bird 2")).not.toContain("Set location");
  });

  it("files the photos under the chosen place, then sends it, with one toast when done", async () => {
    render(<Tab observations={[observation("1")]} />);
    const dialog = await openWindow("Bird 1");
    fireEvent.click(within(dialog).getByRole("button", { name: "Set location" }));
    await waitFor(() =>
      expect(placeStep).toHaveBeenCalledWith(expect.objectContaining({ captureIds: ["c-1"], send: false })),
    );
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/inaturalist/observations/location", { observationIds: ["1"] }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Location sent to iNaturalist."), { timeout: 3000 });
    expect(toast.show).toHaveBeenCalledWith("Sending locations to iNaturalist...", { durationMs: null });
    expect(toast.dismiss).toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
  });

  it("sends nothing when the place step is cancelled", async () => {
    placeStep.mockResolvedValue(null);
    render(<Tab observations={[observation("1")]} />);
    fireEvent.click(within(await openWindow("Bird 1")).getByRole("button", { name: "Set location" }));
    await waitFor(() => expect(placeStep).toHaveBeenCalled());
    expect(locationPosts()).toHaveLength(0);
  });

  it("keeps the location in Lifer and says it will be sent when online", async () => {
    post.mockResolvedValue({ started: false });
    render(<Tab observations={[observation("1")]} />);
    fireEvent.click(within(await openWindow("Bird 1")).getByRole("button", { name: "Set location" }));
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith("Location saved. It will be sent to iNaturalist when you're online."),
    );
    expect(get).not.toHaveBeenCalled();
  });
});

describe("the state of a location on its way", () => {
  it("shows waiting, sent with its time, and a failure with its plain reason and Retry", async () => {
    const now = new Date().toISOString();
    render(
      <Tab
        observations={[
          observation("1", { locationUpdate: { state: "waiting", at: now } }),
          observation("2", { noLocationOnInat: false, locationUpdate: { state: "sent", at: now } }),
          observation("3", { locationUpdate: { state: "failed", at: now, reason: "reconnect" } }),
        ]}
      />,
    );
    expect(within(screen.getByRole("option", { name: "Bird 1" })).getByText("Waiting to send")).toBeTruthy();
    expect(
      within(screen.getByRole("option", { name: "Bird 2" })).getByText(/^Location sent to iNaturalist /),
    ).toBeTruthy();
    const dialog = await openWindow("Bird 3");
    expect(within(dialog).getByText("Couldn't update iNaturalist: reconnect your account in Settings")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/inaturalist/observations/location", { observationIds: ["3"] }),
    );
  });

  it("asks before replacing a location placed on iNaturalist, and keeps it on Keep", async () => {
    render(
      <Tab
        observations={[
          observation("4", {
            noLocationOnInat: false,
            locationUpdate: { state: "conflict", at: new Date().toISOString() },
          }),
        ]}
      />,
    );
    const dialog = await openWindow("Bird 4");
    expect(
      within(dialog).getByText("iNaturalist already has a location for this sighting. Replace it with yours?"),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep iNaturalist's" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/inaturalist/observations/location", {
        observationIds: ["4"],
        conflict: "keep",
      }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Replace" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/inaturalist/observations/location", {
        observationIds: ["4"],
        conflict: "replace",
      }),
    );
  });
});

describe("many sightings at once", () => {
  it("sets one place for 200 selected sightings and reports per-sighting outcomes in one summary", async () => {
    const many = Array.from({ length: 200 }, (_, i) => observation(String(1000 + i)));
    get.mockResolvedValue(result({ updated: 196, waiting: 2, failed: 1, conflicts: 1, conflictIds: ["1007"] }));
    render(<Tab observations={many} />);
    fireEvent.click(await screen.findByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    fireEvent.click(await screen.findByRole("button", { name: "Set location" }));

    await waitFor(() => expect(placeStep).toHaveBeenCalled());
    expect(placeStep.mock.calls[0][0].captureIds).toHaveLength(200);
    await waitFor(() => expect(locationPosts()).toHaveLength(1));
    expect(locationPosts()[0][1].observationIds).toHaveLength(200);

    await waitFor(
      () =>
        expect(toast.show).toHaveBeenCalledWith(
          "Updated 196 of 199 on iNaturalist; 2 are waiting to retry; 1 couldn't be updated",
        ),
      { timeout: 3000 },
    );
    // The ones placed on iNaturalist since sending are a question, with both answers.
    const question = toast.show.mock.calls.find(([text]) => String(text).startsWith("iNaturalist already has"));
    expect(question?.[0]).toBe("iNaturalist already has a location for this sighting. Replace it with yours?");
    const actions = question?.[1].actions as Array<{ label: string; onClick: () => void }>;
    expect(actions.map((a) => a.label)).toEqual(["Replace", "Keep iNaturalist's"]);
    actions[0].onClick();
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/inaturalist/observations/location", {
        observationIds: ["1007"],
        conflict: "replace",
      }),
    );
  });
});
