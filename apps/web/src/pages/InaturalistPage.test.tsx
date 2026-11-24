// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));
const status = { current: { available: true, connected: true, username: "birder" } as unknown };
vi.mock("../hooks/useInatStatus", () => ({ useInatStatus: () => status.current }));
vi.mock("../components/AppSidebar", () => ({ useSidebarLayout: () => false }));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };
vi.mock("../hooks/useToast", () => ({ useToast: () => toast }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => async () => true }));
const sendBatch = vi.fn(async (_target: unknown, _opts?: unknown) => true);
vi.mock("../hooks/useSendToInat", () => ({ useSendToInat: () => sendBatch }));
// The place step itself has its own tests (components/PlaceStep.test.tsx).
const placeStep = vi.fn(async (_request: unknown) => "placed" as const);
vi.mock("../hooks/usePlaceStep", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/usePlaceStep")>()),
  usePlaceStep: () => placeStep,
}));
// The check for photos already on iNaturalist has its own tests (inaturalist/ExistingObservations.test.tsx).
vi.mock("../hooks/useExistingCheck", () => ({
  useExistingCheck: () => ({ status: null, start: vi.fn(), cancel: vi.fn(), cancelling: false }),
}));
const opened = vi.fn();
vi.mock("../lib/openExternal", () => ({ openExternal: (url: string) => opened(url) }));
// The selection bar measures its buttons; jsdom has no ResizeObserver.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);

const { default: InaturalistPage } = await import("./InaturalistPage");
const { resetAccountCaches } = await import("../lib/resource");

const capture = (id: string, hasLocation = false) => ({ id, currentPhotoId: null as string | null, hasLocation });
const sighting = (name: string, captures: ReturnType<typeof capture>[], extra: object = {}) => ({
  speciesId: `s-${name}`,
  commonName: name,
  scientificName: `${name} sci`,
  earliestTakenAt: "2026-06-04T10:00:00.000Z",
  latestTakenAt: "2026-06-04T10:30:00.000Z",
  matched: true,
  captures,
  ...extra,
});
const observation = (id: string, name: string, extra: object = {}) => ({
  observationId: id,
  speciesId: `s-${name}`,
  scientificName: `${name} sci`,
  commonName: name,
  currentPhotoId: null,
  createdAt: "2026-06-05T10:00:00.000Z",
  confirmedAt: null,
  url: `https://www.inaturalist.org/observations/${id}`,
  editUrl: `https://www.inaturalist.org/observations/${id}/edit`,
  photoCount: 2,
  observedAt: "2026-06-04T10:00:00.000Z",
  latestAt: null,
  photoIds: [`p-${id}a`, `p-${id}b`],
  sentLocation: false,
  dateFromInat: false,
  ...extra,
});

let lists: { sightings: unknown[]; ignored: unknown[]; pending: unknown[]; completed: unknown[] };
// Most tests here are about the cards themselves, so they start from the flat list; the species
// tests switch By species on.
const groupBy = (mode: "species" | "none") =>
  localStorage.setItem("lifer:inaturalist-view-group", JSON.stringify(mode));
// Select mode, as the toolbar's Select turns on: only then do clicks select cards.
async function selectMode() {
  const button = await screen.findByRole("button", { name: "Select" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
}
// The toolbar's Filters panel, where each tab's filters live.
const openFilters = () => fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
beforeEach(() => {
  localStorage.clear();
  // Each test starts from its own lists, not the last test's kept copy.
  resetAccountCaches();
  status.current = { available: true, connected: true, username: "birder" };
  lists = { sightings: [], ignored: [], pending: [], completed: [] };
  get.mockReset().mockImplementation(async (url: string) => {
    if (url.startsWith("/inaturalist/import?ignored=true")) return { clusters: lists.ignored, ignoredCount: 4 };
    if (url.startsWith("/inaturalist/import")) return { clusters: lists.sightings, ignoredCount: 4 };
    if (url === "/inaturalist/pending") return { observations: lists.pending };
    return { observations: lists.completed };
  });
  post.mockReset().mockResolvedValue({ checked: 0, completed: 0, notes: {}, updated: 1 });
  sendBatch.mockClear();
  opened.mockReset();
  Object.values(toast).forEach((f) => f.mockReset());
});
afterEach(cleanup);

// Shows the address, so tests can see the open species and Back.
function Address() {
  const location = useLocation();
  return <output data-testid="address">{location.search}</output>;
}
const address = () => screen.getByTestId("address").textContent;
const renderPage = (path = "/inaturalist") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <InaturalistPage />
      <Address />
    </MemoryRouter>,
  );
const checks = () => post.mock.calls.filter(([url]) => url === "/inaturalist/pending/check").length;

describe("InaturalistPage", () => {
  it("opens on what's left to finish and checks iNaturalist by itself", async () => {
    lists.sightings = [sighting("Osprey", [capture("c1")])];
    lists.pending = [observation("1", "Merlin")];
    post.mockResolvedValueOnce({ checked: 1, completed: 0, notes: { "1": "Needs a location on iNaturalist." } });
    renderPage();
    expect(await screen.findByText("Merlin")).toBeTruthy();
    expect(screen.getByRole("button", { name: "To finish 1" }).getAttribute("aria-pressed")).toBe("true");
    expect(await screen.findByText("Needs a location on iNaturalist.")).toBeTruthy();
    expect(checks()).toBe(1);
    expect(screen.queryByRole("button", { name: /confirm/i })).toBeNull();
  });

  it("checks again when the window comes back, and says when one is finished", async () => {
    lists.pending = [observation("1", "Merlin")];
    renderPage("/inaturalist?tab=pending");
    await screen.findByText("Merlin");
    await waitFor(() => expect(checks()).toBe(1));
    post.mockResolvedValueOnce({ checked: 1, completed: 1, notes: {} });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("1 observation finished on iNaturalist."));
    expect(checks()).toBe(2);
  });

  it("selects sightings on the grid, with Shift for a range, and sends each as one observation", async () => {
    lists.sightings = [
      sighting("Osprey", [capture("c1"), capture("c2")]),
      sighting("Loon", [capture("c3", true)]),
      sighting("Merlin", [capture("c4", true)]),
    ];
    renderPage("/inaturalist?tab=import");
    await selectMode();
    const osprey = await screen.findByRole("option", { name: "Osprey" });
    fireEvent.click(osprey);
    expect(osprey.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("1 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: "Merlin" }), { shiftKey: true });
    expect(screen.getByText("3 selected")).toBeTruthy();
    // A Cmd-click takes one back out, and another click puts it back.
    fireEvent.click(screen.getByRole("option", { name: "Loon" }), { metaKey: true });
    expect(screen.getByText("2 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: "Loon" }));
    fireEvent.click(screen.getByRole("button", { name: "Send 3 sightings" }));
    await waitFor(() =>
      expect(sendBatch).toHaveBeenCalledWith(
        { groups: [["c1", "c2"], ["c3"], ["c4"]] },
        expect.objectContaining({ ignoreExistingGuard: false }),
      ),
    );
  });

  it("sets a place for sightings without a location, then sends them, in one step", async () => {
    const looksLike = { id: "p1", name: "King Fisher Pond", locality: null, geoprivacy: "obscured" };
    lists.sightings = [
      sighting("Osprey", [capture("c1"), capture("c2")], { looksLike, geoprivacy: "private" }),
      sighting("Loon", [capture("c3", true)]),
    ];
    renderPage("/inaturalist?tab=import");
    await selectMode();
    const osprey = await screen.findByRole("option", { name: "Osprey" });
    // The card says how it will be sent, and No location yet is a quiet Set place.
    expect(within(osprey).getByText("Will be sent private")).toBeTruthy();
    expect(within(osprey).getByRole("button", { name: "Set place" })).toBeTruthy();
    expect(
      within(screen.getByRole("option", { name: "Loon" })).queryByRole("button", { name: "Set place" }),
    ).toBeNull();
    fireEvent.click(osprey);
    fireEvent.click(screen.getByRole("button", { name: "Set place and send" }));
    await waitFor(() => expect(sendBatch).toHaveBeenCalledWith({ groups: [["c1", "c2"]] }, expect.anything()));
    expect(placeStep).toHaveBeenCalledWith(
      expect.objectContaining({ captureIds: ["c1", "c2"], send: true, looksLike }),
    );
  });

  it("sends exactly the ticked photos from a sighting's own window", async () => {
    lists.sightings = [sighting("Osprey", [capture("c1"), capture("c2"), capture("c3")])];
    renderPage("/inaturalist?tab=import");
    fireEvent.keyDown(await screen.findByRole("option", { name: "Osprey" }), { key: "Enter" });
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        "These photos have no location. Choose a place, or add it on iNaturalist after sending.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Include photo 2 of 3" }));
    expect(within(dialog).getByText(/2 of 3 photos/)).toBeTruthy();
    expect(within(dialog).getByText("Left out")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Send 2 photos" }));
    await waitFor(() =>
      expect(sendBatch).toHaveBeenCalledWith(
        { groups: [["c1", "c3"]] },
        expect.objectContaining({ ignoreExistingGuard: false }),
      ),
    );
  });

  it("ignores just the left-out photos, with Undo", async () => {
    lists.sightings = [sighting("Osprey", [capture("c1"), capture("c2")])];
    renderPage("/inaturalist?tab=import");
    fireEvent.keyDown(await screen.findByRole("option", { name: "Osprey" }), { key: "Enter" });
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Include photo 1 of 2" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Ignore 1 left-out photo" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/inaturalist/ignore", { captureIds: ["c1"], ignored: true }),
    );
    expect(toast.show).toHaveBeenCalledWith(
      "Ignored 1 photo.",
      expect.objectContaining({ actions: expect.any(Array) }),
    );
  });

  describe("sighting window place", () => {
    const placeBox = () => screen.queryByPlaceholderText("Choose a place, e.g. King Fisher Pond");
    async function openWindow(captures: ReturnType<typeof capture>[], extra: object = {}) {
      lists.sightings = [sighting("Iguana", captures, extra)];
      renderPage("/inaturalist?tab=import");
      fireEvent.click(await screen.findByRole("option", { name: "Iguana" }));
      return screen.findByRole("dialog");
    }

    it("says the photo's own location will be sent, with Change place for a named one", async () => {
      const dialog = await openWindow([capture("c1", true)], {
        placeName: "Belize",
        point: { lat: 17.25, lon: -88.76 },
      });
      const line = within(dialog).getByText("Location: from your photo, near Belize");
      expect(placeBox()).toBeNull();
      // The place shows once, in the location line.
      expect(within(dialog).queryByText("Belize")).toBeNull();
      expect(within(dialog).getByRole("button", { name: "Send 1 photo" }).hasAttribute("disabled")).toBe(false);
      // The exact point is a focus away, in its tooltip.
      expect(line.getAttribute("tabindex")).toBe("0");

      fireEvent.click(within(dialog).getByRole("button", { name: "Change place" }));
      expect(placeBox()).toBeTruthy();
      expect(within(dialog).queryByRole("button", { name: "Change place" })).toBeNull();
    });

    it("says how many photos have a location when only some do, and keeps Change place", async () => {
      const dialog = await openWindow([capture("c1", true), capture("c2", true), capture("c3")], {
        placeName: "Belize",
      });
      expect(within(dialog).getByText("Location: from 2 of 3 photos, near Belize")).toBeTruthy();
      expect(placeBox()).toBeNull();
      expect(within(dialog).getByRole("button", { name: "Change place" })).toBeTruthy();
    });

    it("asks for a place when no photo has a location, and still sends without one", async () => {
      const dialog = await openWindow([capture("c1")]);
      expect(
        within(dialog).getByText("This photo has no location. Choose a place, or add it on iNaturalist after sending."),
      ).toBeTruthy();
      expect(placeBox()).toBeTruthy();
      expect(within(dialog).queryByRole("button", { name: "Change place" })).toBeNull();
      fireEvent.click(within(dialog).getByRole("button", { name: "Send 1 photo" }));
      await waitFor(() => expect(sendBatch).toHaveBeenCalledWith({ groups: [["c1"]] }, expect.anything()));
    });

    it("opens a photo full size over the window, and Esc closes only the viewer", async () => {
      const dialog = await openWindow([
        { id: "c1", currentPhotoId: "p1", hasLocation: true },
        { id: "c2", currentPhotoId: "p2", hasLocation: true },
        { id: "c3", currentPhotoId: "p3", hasLocation: true },
      ]);
      const shownImage = () =>
        screen
          .getAllByRole("dialog")
          .map((d) => d.querySelector("img[src$='/display']")?.getAttribute("src"))
          .find(Boolean);
      const thumb = within(dialog).getByRole("button", { name: "View photo 2 of 3" });
      fireEvent.click(thumb);
      await waitFor(() => expect(shownImage()).toBe("/api/photos/p2/display"));
      // Viewing a photo doesn't leave it out.
      expect(within(dialog).getByRole("button", { name: "Send 3 photos" })).toBeTruthy();
      fireEvent.keyDown(document, { key: "ArrowRight" });
      await waitFor(() => expect(shownImage()).toBe("/api/photos/p3/display"));
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
      expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Send 3 photos" })).toBeTruthy();
      expect(document.activeElement).toBe(thumb);
    });
  });

  it("can't send a species with no iNaturalist match", async () => {
    lists.sightings = [sighting("Loon", [capture("c3", true)], { matched: false })];
    renderPage("/inaturalist?tab=import");
    await selectMode();
    expect(await screen.findByText("Can't be sent yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: "Loon" }));
    expect(screen.getByRole("button", { name: "Send 0 sightings" })).toBeTruthy();
  });

  it("restores ignored sightings from the Ignored view", async () => {
    lists.sightings = [sighting("Osprey", [capture("c1")])];
    lists.ignored = [sighting("Gull", [capture("g1"), capture("g2")])];
    renderPage("/inaturalist?tab=import");
    await selectMode();
    await screen.findByRole("textbox", { name: "Search species" });
    openFilters();
    fireEvent.change(screen.getByRole("combobox", { name: "Show" }), { target: { value: "ignored" } });
    fireEvent.click(await screen.findByRole("option", { name: "Gull" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore 1 sighting" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/inaturalist/ignore", { captureIds: ["g1", "g2"], ignored: false }),
    );
  });

  it("sends ignored sightings on purpose from the Ignored view", async () => {
    lists.ignored = [sighting("Gull", [capture("g1"), capture("g2")])];
    renderPage("/inaturalist?tab=import");
    await screen.findByRole("textbox", { name: "Search species" });
    openFilters();
    fireEvent.change(screen.getByRole("combobox", { name: "Show" }), { target: { value: "ignored" } });
    fireEvent.keyDown(await screen.findByRole("option", { name: "Gull" }), { key: "Enter" });
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Include photo 2 of 2" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Send 1 photo" }));
    await waitFor(() =>
      expect(sendBatch).toHaveBeenCalledWith(
        { groups: [["g1"]] },
        expect.objectContaining({ ignoreExistingGuard: false }),
      ),
    );
  });

  it("holds a sighting that may already be on iNaturalist in place, with Check and Send anyway", async () => {
    lists.sightings = [sighting("Osprey", [capture("c1")])];
    sendBatch.mockImplementationOnce(async (_target, opts) => {
      (opts as { onMaybeOnInat: (g: string[][]) => void }).onMaybeOnInat([["c1"]]);
      return false;
    });
    renderPage("/inaturalist?tab=import");
    fireEvent.contextMenu(await screen.findByRole("option", { name: "Osprey" }), { clientX: 40, clientY: 40 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Send to iNaturalist" }));
    const notice = (await screen.findByText("This looks like it may already be on iNaturalist.")).closest(
      "[role=status]",
    ) as HTMLElement;
    fireEvent.click(within(notice).getByRole("button", { name: "Send anyway" }));
    await waitFor(() =>
      expect(sendBatch).toHaveBeenLastCalledWith(
        { groups: [["c1"]] },
        expect.objectContaining({ ignoreExistingGuard: true }),
      ),
    );
  });

  it("offers Unlink from iNaturalist only on observations found there", async () => {
    lists.completed = [observation("7", "Osprey", { foundOnInat: true }), observation("8", "Loon")];
    post.mockResolvedValue({ unlinked: 1, kept: 0 });
    renderPage("/inaturalist?tab=completed");
    fireEvent.contextMenu(await screen.findByRole("option", { name: "Loon" }), { clientX: 40, clientY: 40 });
    expect(screen.queryByRole("menuitem", { name: "Unlink from iNaturalist" })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.contextMenu(screen.getByRole("option", { name: "Osprey" }), { clientX: 40, clientY: 40 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Unlink from iNaturalist" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/inaturalist/matches/unlink", { observationId: "7" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Unlinked. The photo is back in To send."));
  });

  it("offers Preview, Select, Send and Ignore on right-click, and selects all with Mod+A", async () => {
    lists.sightings = [sighting("Osprey", [capture("c1")]), sighting("Loon", [capture("c2")])];
    renderPage("/inaturalist?tab=import");
    const osprey = await screen.findByRole("option", { name: "Osprey" });
    fireEvent.contextMenu(osprey, { clientX: 40, clientY: 40 });
    const items = screen.getAllByRole("menuitem").map((i) => i.textContent);
    // No location yet: Set place leads.
    expect(items).toEqual([
      "Set place",
      "Choose photos",
      "Preview",
      "Select",
      "Send to iNaturalist",
      "Ignore sighting",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Send to iNaturalist" }));
    await waitFor(() =>
      expect(sendBatch).toHaveBeenCalledWith(
        { groups: [["c1"]] },
        expect.objectContaining({ ignoreExistingGuard: false }),
      ),
    );
    fireEvent.keyDown(screen.getByRole("option", { name: "Loon" }), { key: "a", ctrlKey: true });
    expect(screen.getByText("2 selected")).toBeTruthy();
  });

  describe("deselecting", () => {
    const three = () => [
      sighting("Osprey", [capture("c1")]),
      sighting("Loon", [capture("c2")]),
      sighting("Merlin", [capture("c3")]),
    ];
    const isSelected = (name: string) => screen.getByRole("option", { name }).getAttribute("aria-selected") === "true";
    async function selectTwo() {
      lists.sightings = three();
      renderPage("/inaturalist?tab=import");
      await selectMode();
      fireEvent.click(await screen.findByRole("option", { name: "Osprey" }));
      fireEvent.click(screen.getByRole("option", { name: "Loon" }));
      expect(screen.getByText("2 selected")).toBeTruthy();
    }

    it("toggles a selected card off with a click, also after a Shift range", async () => {
      lists.sightings = three();
      renderPage("/inaturalist?tab=import");
      await selectMode();
      fireEvent.click(await screen.findByRole("option", { name: "Osprey" }));
      fireEvent.click(screen.getByRole("option", { name: "Merlin" }), { shiftKey: true });
      expect(screen.getByText("3 selected")).toBeTruthy();
      fireEvent.click(screen.getByRole("option", { name: "Loon" }));
      expect(isSelected("Loon")).toBe(false);
      expect(screen.getByText("2 selected")).toBeTruthy();
    });

    it("opens on double-click without changing the selection", async () => {
      lists.sightings = three();
      renderPage("/inaturalist?tab=import");
      await selectMode();
      const osprey = await screen.findByRole("option", { name: "Osprey" });
      // A real double-click: two clicks (detail 1, then 2), then dblclick.
      fireEvent.click(osprey, { detail: 1 });
      fireEvent.click(osprey, { detail: 2 });
      fireEvent.doubleClick(osprey, { detail: 2 });
      expect(await screen.findByRole("dialog")).toBeTruthy();
      expect(isSelected("Osprey")).toBe(false);
    });

    it("clears with the Clear selection button", async () => {
      await selectTwo();
      fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
      expect(screen.queryByText("2 selected")).toBeNull();
      expect(isSelected("Osprey")).toBe(false);
    });

    it("clears with a click on the grid's gaps or the page background", async () => {
      await selectTwo();
      fireEvent.click(screen.getByRole("listbox"));
      expect(screen.queryByText(/selected/)).toBeNull();
      fireEvent.click(screen.getByRole("option", { name: "Osprey" }));
      fireEvent.click(screen.getByRole("main"));
      expect(isSelected("Osprey")).toBe(false);
    });

    it("clears with Esc or Mod+Shift+A, but not while a sighting is open", async () => {
      await selectTwo();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByText("2 selected")).toBeNull();
      fireEvent.click(screen.getByRole("option", { name: "Osprey" }));
      fireEvent.keyDown(document, { key: "A", ctrlKey: true, shiftKey: true });
      expect(isSelected("Osprey")).toBe(false);
      fireEvent.click(screen.getByRole("option", { name: "Loon" }));
      fireEvent.keyDown(screen.getByRole("option", { name: "Loon" }), { key: "Enter" });
      await screen.findByRole("dialog");
      fireEvent.keyDown(document, { key: "Escape" });
      expect(isSelected("Loon")).toBe(true);
    });

    it("keeps only the cards a search still shows, and clears on a tab switch", async () => {
      await selectTwo();
      fireEvent.change(screen.getByRole("textbox", { name: "Search species" }), { target: { value: "loo" } });
      expect(screen.getByText("1 selected")).toBeTruthy();
      fireEvent.change(screen.getByRole("textbox", { name: "Search species" }), { target: { value: "" } });
      expect(isSelected("Osprey")).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: /^To finish/ }));
      fireEvent.click(screen.getByRole("button", { name: /^To send/ }));
      expect(isSelected("Loon")).toBe(false);
    });

    it("clears after a send", async () => {
      await selectTwo();
      fireEvent.click(screen.getByRole("button", { name: "Send 2 sightings" }));
      await waitFor(() => expect(sendBatch).toHaveBeenCalled());
      expect(screen.queryByText("2 selected")).toBeNull();
    });
  });

  describe("picture preview", () => {
    const viewer = () => screen.getByRole("dialog");
    const shownImage = () => viewer().querySelector("img")?.getAttribute("src");

    it("shows a sighting's photos from the magnifier, Space or Enter, not its window", async () => {
      lists.sightings = [
        sighting("Osprey", [
          { id: "c1", currentPhotoId: "p1", hasLocation: false },
          { id: "c2", currentPhotoId: "p2", hasLocation: false },
        ]),
      ];
      renderPage("/inaturalist?tab=import");
      fireEvent.click((await screen.findAllByRole("button", { name: "Preview" }))[0]);
      await waitFor(() => expect(shownImage()).toBe("/api/photos/p1/display"));
      expect(screen.queryByRole("button", { name: /Send \d+ photo/ })).toBeNull();
      // Arrow keys step through the photos, and Esc closes back to the grid.
      fireEvent.keyDown(document, { key: "ArrowRight" });
      await waitFor(() => expect(shownImage()).toBe("/api/photos/p2/display"));
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(screen.getByRole("option", { name: "Osprey" })).toBeTruthy();

      fireEvent.keyDown(screen.getByRole("option", { name: "Osprey" }), { key: " " });
      await waitFor(() => expect(shownImage()).toBe("/api/photos/p1/display"));
    });

    it("opens the window from the menu's Choose photos and from a double-click", async () => {
      lists.sightings = [sighting("Osprey", [capture("c1"), capture("c2")])];
      renderPage("/inaturalist?tab=import");
      fireEvent.contextMenu(await screen.findByRole("option", { name: "Osprey" }), { clientX: 30, clientY: 30 });
      fireEvent.click(screen.getByRole("menuitem", { name: "Choose photos" }));
      expect(await screen.findByRole("button", { name: "Send 2 photos" })).toBeTruthy();
    });

    it("falls back to iNaturalist's picture when an observation has no photo here", async () => {
      lists.completed = [observation("7", "Merlin", { photoIds: [], inatPhotoId: "555" })];
      renderPage("/inaturalist?tab=completed");
      fireEvent.keyDown(await screen.findByRole("option", { name: "Merlin" }), { key: " " });
      await waitFor(() => expect(shownImage()).toBe("/api/inaturalist/observations/7/photos/555"));
    });
  });

  describe("To send cards", () => {
    const photos = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, currentPhotoId: `p${i + 1}`, hasLocation: false }));
    const shownImage = () =>
      screen
        .getAllByRole("dialog")
        .map((d) => d.querySelector("img[src$='/display']")?.getAttribute("src"))
        .find(Boolean);

    it("opens a sighting's window with a plain click and with Enter", async () => {
      lists.sightings = [sighting("Osprey", [capture("c1"), capture("c2")])];
      renderPage("/inaturalist?tab=import");
      fireEvent.click(await screen.findByRole("option", { name: "Osprey" }));
      expect(await screen.findByRole("button", { name: "Send 2 photos" })).toBeTruthy();
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      fireEvent.keyDown(screen.getByRole("option", { name: "Osprey" }), { key: "Enter" });
      expect(await screen.findByRole("button", { name: "Send 2 photos" })).toBeTruthy();
    });

    it("stretches cards to one row height and clamps long text to two lines", async () => {
      const long = "Very long name ".repeat(20).trim();
      lists.sightings = [sighting(long, [capture("c1")], { placeName: "A place ".repeat(30).trim() })];
      renderPage("/inaturalist?tab=import");
      const card = await screen.findByRole("option", { name: long });
      expect(screen.getByRole("listbox").className).not.toContain("items-start");
      expect(card.className).toContain("h-full");
      expect(within(card).getByText(long).className).toContain("line-clamp-2");
      expect(within(card).getByText(/^A place/).className).toContain("line-clamp-2");
    });

    it("shows only cards with more than three photos a +N tile, opening every photo", async () => {
      lists.sightings = [sighting("Osprey", photos(8)), sighting("Loon", photos(3))];
      renderPage("/inaturalist?tab=import");
      await screen.findByRole("option", { name: "Loon" });
      expect(screen.getAllByRole("button", { name: /^Show all/ })).toHaveLength(1);
      const tile = screen.getByRole("button", { name: "Show all 8 photos" });
      fireEvent.click(tile);
      const grid = await screen.findByRole("dialog");
      expect(within(grid).getByText("8 photos")).toBeTruthy();
      const thumbs = within(grid).getAllByRole("button", { name: /^View photo/ });
      expect(thumbs).toHaveLength(8);
      // Not the card's own click: no sighting window opened.
      expect(screen.queryByRole("button", { name: "Send 8 photos" })).toBeNull();

      // Arrows move between the photos.
      thumbs[0].focus();
      fireEvent.keyDown(thumbs[0], { key: "ArrowRight" });
      expect(document.activeElement).toBe(thumbs[1]);

      // A photo opens in the viewer at that photo; Esc backs out one layer at a time.
      fireEvent.click(within(grid).getByRole("button", { name: "View photo 3 of 8" }));
      await waitFor(() => expect(shownImage()).toBe("/api/photos/p3/display"));
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(document.activeElement).toBe(tile);
    });

    it("opens the photo grid from +N in select mode without selecting the card", async () => {
      lists.sightings = [sighting("Osprey", photos(5))];
      renderPage("/inaturalist?tab=import");
      await selectMode();
      fireEvent.click(await screen.findByRole("button", { name: "Show all 5 photos" }));
      expect(await screen.findByRole("dialog")).toBeTruthy();
      expect(screen.getByRole("option", { name: "Osprey" }).getAttribute("aria-selected")).toBe("false");
    });

    it("asks the server for the Gallery's RAW filters and counts them as filters", async () => {
      lists.sightings = [sighting("Osprey", [capture("c1")])];
      renderPage("/inaturalist?tab=import");
      await screen.findByRole("option", { name: "Osprey" });
      openFilters();
      fireEvent.click(screen.getByRole("button", { name: "With RAW" }));
      await waitFor(() => expect(get).toHaveBeenCalledWith("/inaturalist/import?onlyHasRaw=1"));
      expect(screen.getByRole("button", { name: /^Filters/ }).textContent).toContain("1");
      // Kept for next time, as the Gallery keeps its own.
      expect(localStorage.getItem("lifer:inatEditedRaw")).toBe('"with"');
    });
  });

  it("filters sightings by species name", async () => {
    lists.sightings = [sighting("Osprey", [capture("c1")]), sighting("Loon", [capture("c2")])];
    renderPage("/inaturalist?tab=import");
    await screen.findByText("Osprey");
    fireEvent.change(screen.getByRole("textbox", { name: "Search species" }), { target: { value: "loo" } });
    expect(screen.queryByText("Osprey")).toBeNull();
    expect(screen.getByText("Loon")).toBeTruthy();
  });

  it("shows completed cards with their place, and where the data came from only as a filter", async () => {
    lists.completed = [
      observation("1", "Merlin", { sentLocation: true, placeName: "Pigeon Lake, Alberta" }),
      observation("2", "Kestrel"),
      observation("3", "Osprey", { dateFromInat: true }),
    ];
    renderPage("/inaturalist?tab=completed");
    await selectMode();
    expect(await screen.findByText("Pigeon Lake, Alberta")).toBeTruthy();
    // Provenance is low-value on a card face.
    expect(screen.queryByText(/Location placed on iNaturalist|Location from the photo/)).toBeNull();
    // One selected card can be opened on iNaturalist; nothing on Completed works in bulk.
    fireEvent.click(screen.getByRole("option", { name: "Kestrel" }));
    fireEvent.click(screen.getByRole("button", { name: "View on iNaturalist" }));
    expect(opened).toHaveBeenCalledWith("https://www.inaturalist.org/observations/2");
    fireEvent.click(screen.getByRole("option", { name: "Merlin" }));
    expect(screen.queryByRole("button", { name: "View on iNaturalist" })).toBeNull();
    // The date filter keeps only the one dated from iNaturalist, and the button counts it.
    openFilters();
    fireEvent.change(screen.getByRole("combobox", { name: "Date" }), { target: { value: "inat" } });
    expect(screen.queryByRole("option", { name: "Kestrel" })).toBeNull();
    expect(screen.getByRole("option", { name: "Osprey" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Filters (1)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.getByRole("option", { name: "Kestrel" })).toBeTruthy();
  });

  it("selects every card or none from the Select menu", async () => {
    lists.completed = [observation("1", "Merlin"), observation("2", "Kestrel")];
    renderPage("/inaturalist?tab=completed");
    await screen.findByRole("option", { name: "Merlin" });
    // No ticks until Select turns select mode on.
    expect(screen.queryByRole("checkbox", { name: "Select photo" })).toBeNull();
    await selectMode();
    expect(screen.getAllByRole("checkbox", { name: "Select photo" })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Select every observation (2)" }));
    expect(screen.getByText("2 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Select none" }));
    expect(screen.queryByText("2 selected")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("checkbox", { name: "Select photo" })).toBeNull();
  });

  it("previews a card's pictures with a plain click outside select mode", async () => {
    lists.completed = [observation("1", "Merlin")];
    renderPage("/inaturalist?tab=completed");
    fireEvent.click(await screen.findByRole("option", { name: "Merlin" }));
    await waitFor(() =>
      expect(screen.getByRole("dialog").querySelector("img")?.getAttribute("src")).toBe("/api/photos/p-1a/display"),
    );
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it("checks the selected To finish observations now, and filters by what's missing", async () => {
    lists.pending = [observation("1", "Merlin"), observation("2", "Kestrel", { sentLocation: true, observedAt: null })];
    renderPage("/inaturalist?tab=pending");
    await selectMode();
    await screen.findByRole("option", { name: "Merlin" });
    await waitFor(() => expect(checks()).toBe(1));
    fireEvent.click(screen.getByRole("option", { name: "Kestrel" }));
    fireEvent.click(screen.getByRole("button", { name: "Check 1 now" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/inaturalist/pending/check", { observationIds: ["2"] }));
    fireEvent.contextMenu(screen.getByRole("option", { name: "Merlin" }), { clientX: 30, clientY: 30 });
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Details",
      "Preview",
      "Select",
      "Open on iNaturalist",
      "Check now",
    ]);
    openFilters();
    fireEvent.change(screen.getByRole("combobox", { name: "Needs" }), { target: { value: "date" } });
    expect(screen.queryByRole("option", { name: "Merlin" })).toBeNull();
    expect(screen.getByRole("option", { name: "Kestrel" })).toBeTruthy();
  });

  it("opens an observation's photos in the same window", async () => {
    lists.completed = [observation("1", "Merlin", { sentLocation: true })];
    renderPage("/inaturalist?tab=completed");
    fireEvent.keyDown(await screen.findByRole("option", { name: "Merlin" }), { key: "Enter" });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Location from the photo")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "View on iNaturalist" }));
    expect(opened).toHaveBeenCalledWith("https://www.inaturalist.org/observations/1");
  });

  it("points to Settings when no account is connected", async () => {
    status.current = { available: true, connected: false, username: null };
    renderPage();
    expect(await screen.findByRole("button", { name: "Open Settings" })).toBeTruthy();
    expect(get).not.toHaveBeenCalled();
  });

  it("lists every observation by default, one card each", async () => {
    lists.pending = [observation("1", "Merlin"), observation("2", "Merlin")];
    renderPage("/inaturalist?tab=pending");
    await screen.findAllByRole("option", { name: "Merlin" });
    expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(2);
  });

  describe("by species", () => {
    beforeEach(() => groupBy("species"));
    // The card list's options, not the filter menus' ones.
    const cards = () => within(screen.getByRole("listbox")).getAllByRole("option");
    const finish = () => [
      observation("1", "Merlin"),
      observation("2", "Kestrel", { sentLocation: true, observedAt: null }),
      observation("3", "Merlin"),
    ];

    it("shows one card per species with its counts", async () => {
      lists.pending = finish();
      renderPage("/inaturalist?tab=pending");
      const merlin = await screen.findByRole("option", { name: "Merlin" });
      expect(cards()).toHaveLength(2);
      expect(within(merlin).getByText("2 observations, 4 photos")).toBeTruthy();
      expect(within(merlin).getByText("2 need a location")).toBeTruthy();
      expect(within(screen.getByRole("option", { name: "Kestrel" })).getByText("1 needs a date")).toBeTruthy();
    });

    it("opens a species on click, selects it in select mode, and goes back with the link or Esc", async () => {
      lists.pending = finish();
      renderPage("/inaturalist?tab=pending");
      await selectMode();
      const merlin = await screen.findByRole("option", { name: "Merlin" });
      fireEvent.click(merlin);
      expect(merlin.getAttribute("aria-selected")).toBe("true");
      expect(address()).not.toContain("species=");
      fireEvent.click(merlin);
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      // Outside select mode a click goes into the species.
      fireEvent.click(merlin);
      expect(address()).toContain("species=s-Merlin");
      expect(screen.getByRole("heading", { name: "Merlin" })).toBeTruthy();
      // Inside the species, its cards lead with the date, not the repeated name.
      expect(cards().map((o) => o.getAttribute("aria-label"))).toEqual([
        "2 photos, Jun 4, 2026",
        "2 photos, Jun 4, 2026",
      ]);
      fireEvent.click(screen.getByRole("button", { name: "All species" }));
      await waitFor(() => expect(address()).not.toContain("species="));
      expect(cards()).toHaveLength(2);

      fireEvent.keyDown(screen.getByRole("option", { name: "Kestrel" }), { key: "Enter" });
      expect(address()).toContain("species=s-Kestrel");
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(address()).not.toContain("species="));
    });

    it("selects species with Cmd-click and counts their observations for Check now", async () => {
      lists.pending = finish();
      renderPage("/inaturalist?tab=pending");
      fireEvent.click(await screen.findByRole("option", { name: "Merlin" }), { metaKey: true });
      fireEvent.click(screen.getByRole("option", { name: "Kestrel" }), { metaKey: true });
      expect(screen.getByText("2 species, 3 observations selected")).toBeTruthy();
      expect(address()).not.toContain("species=");
      fireEvent.click(screen.getByRole("button", { name: "Check 3 now" }));
      await waitFor(() =>
        expect(post).toHaveBeenCalledWith("/inaturalist/pending/check", { observationIds: ["1", "2", "3"] }),
      );
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByText(/species, .* selected/)).toBeNull();
    });

    it("groups and sorts from the View menu and remembers the choices", async () => {
      lists.pending = finish();
      renderPage("/inaturalist?tab=pending");
      await screen.findByRole("option", { name: "Merlin" });
      fireEvent.click(screen.getByRole("button", { name: /^View/ }));
      fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), { target: { value: "count" } });
      expect(cards().map((o) => o.getAttribute("aria-label"))).toEqual(["Merlin", "Kestrel"]);
      fireEvent.change(screen.getByRole("combobox", { name: "Group" }), { target: { value: "none" } });
      expect(cards()).toHaveLength(3);
      expect(localStorage.getItem("lifer:inaturalist-view-group")).toBe('"none"');
    });

    it("searches species names, and the open species' observations", async () => {
      lists.pending = finish();
      renderPage("/inaturalist?tab=pending");
      await screen.findByRole("option", { name: "Merlin" });
      const search = () => screen.getByRole("textbox", { name: "Search species" });
      fireEvent.change(search(), { target: { value: "kes" } });
      expect(cards().map((o) => o.getAttribute("aria-label"))).toEqual(["Kestrel"]);
      fireEvent.change(search(), { target: { value: "" } });
      // Filters apply to the observations, and species cards count only the matching ones.
      openFilters();
      fireEvent.change(screen.getByRole("combobox", { name: "Needs" }), { target: { value: "date" } });
      expect(cards().map((o) => o.getAttribute("aria-label"))).toEqual(["Kestrel"]);
    });

    it("sends every sighting of the selected species, one observation each", async () => {
      lists.sightings = [
        sighting("Osprey", [capture("c1")]),
        sighting("Osprey", [capture("c2")], { latestTakenAt: "2026-06-01T10:00:00.000Z" }),
        sighting("Loon", [capture("c3")]),
      ];
      renderPage("/inaturalist?tab=import");
      fireEvent.click(await screen.findByRole("option", { name: "Osprey" }), { metaKey: true });
      expect(screen.getByText("1 species, 2 sightings selected")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Send 2 sightings" }));
      await waitFor(() =>
        expect(sendBatch).toHaveBeenCalledWith(
          { groups: [["c1"], ["c2"]] },
          expect.objectContaining({ ignoreExistingGuard: false }),
        ),
      );
    });
  });
});
