// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetOnlinePlaces } from "../lib/onlinePlaces";

const get = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a) },
}));

const { default: PlacePicker } = await import("./PlacePicker");

const spot = (name: string, group: "nearby" | "recent" | "all", extra: object = {}) => ({
  kind: "spot",
  id: `id-${name}`,
  name,
  detail: "British Columbia",
  lat: 53.9,
  lon: -122.75,
  regionId: null,
  bbox: null,
  group,
  locality: "Prince George, British Columbia, Canada",
  geoprivacy: "open",
  radiusM: 100,
  distanceM: null,
  recognised: false,
  ...extra,
});
const LONG = "A very long place name that goes on and on past the edge of any narrow window ".repeat(2).trim();
const fetchMock = vi.fn();
const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => spot(`Place ${from + i}`, "all"));

beforeEach(() => {
  resetOnlinePlaces();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ features: [] }) });
  get.mockImplementation((url: string) =>
    Promise.resolve(
      url.includes("offset=50")
        ? { places: page(50, 50), nextOffset: null }
        : {
            places: [
              spot("King Fisher Pond", "nearby", { distanceM: 40, recognised: true }),
              spot("Cottonwood Park", "nearby", { distanceM: 2400, geoprivacy: "obscured" }),
              spot("Tofino mudflats", "recent"),
              spot(LONG, "all"),
              ...page(1, 49),
            ],
            nextOffset: 50,
          },
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  localStorage.clear();
  setOnline(true);
});

async function openPicker(props: Partial<Parameters<typeof PlacePicker>[0]> = {}) {
  const onPick = vi.fn();
  const onNewPlace = vi.fn();
  render(
    <PlacePicker
      placeholder="Choose a place"
      near={{ lat: 53.9, lon: -122.75 }}
      onPick={onPick}
      onNewPlace={onNewPlace}
      {...props}
    />,
  );
  const input = screen.getByRole("combobox");
  await act(async () => {
    fireEvent.focus(input);
  });
  return { input, onPick, onNewPlace };
}

describe("PlacePicker", () => {
  it("lists Nearby, Recent and All with nothing typed, the place the photos are in first", async () => {
    await openPicker();
    expect(get.mock.calls[0][0]).toContain("near=53.9%2C-122.75");
    const options = screen.getAllByRole("option");
    expect(options[0].textContent).toContain("This looks like King Fisher Pond");
    expect(options[0].textContent).toContain("40 m");
    expect(options[1].textContent).toContain("2.4 km");
    expect(options[1].textContent).toContain("Hidden on iNaturalist");
    expect(screen.getByText("Nearby")).toBeTruthy();
    expect(screen.getByText("Recent")).toBeTruthy();
    expect(screen.getByText("All places")).toBeTruthy();
    // Distance only in Nearby; a long name wraps, never cut off.
    expect(options[2].textContent).not.toMatch(/\d m|km/);
    const long = screen.getByText(LONG);
    expect(long.className).toContain("break-words");
    expect(long.className).not.toContain("truncate");
    expect(options.at(-1)!.textContent).toBe("New place from the map");
  });

  it("moves with the arrows, picks with Enter, and closes on Escape keeping focus", async () => {
    const { input, onPick } = await openPicker();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[1].id);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ name: "Cottonwood Park" }));
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByRole("listbox")).toBeTruthy();
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    fireEvent(input, escape);
    document.removeEventListener("keydown", outer);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(outer).not.toHaveBeenCalled();
  });

  it("opens the list on the page's top layer, so a dialog's edge never clips it", async () => {
    const { input } = await openPicker();
    const dialog = input.closest("div")!.parentElement!;
    const box = screen.getByRole("listbox").closest("[data-place-list]")!;
    expect(box.parentElement).toBe(document.body);
    expect(dialog.contains(box)).toBe(false);
    expect(box.className).toContain("fixed");
    // Room below in jsdom's 768 px window: it opens under the field, kept inside the window.
    expect((box as HTMLElement).style.top).not.toBe("");
    expect(parseFloat((box as HTMLElement).style.maxHeight)).toBeLessThanOrEqual(320);
  });

  it("flips above the field when there's more room there", async () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: 700,
      bottom: 740,
      left: 10,
      right: 310,
      width: 300,
      height: 40,
      x: 10,
      y: 700,
    } as DOMRect);
    try {
      await openPicker();
      const box = screen.getByRole("listbox").closest("[data-place-list]") as HTMLElement;
      expect(box.style.bottom).not.toBe("");
      expect(box.style.top).toBe("");
    } finally {
      rect.mockRestore();
    }
  });

  it("reaches New place from the map with the arrows", async () => {
    const { input, onNewPlace } = await openPicker();
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onNewPlace).toHaveBeenCalled();
  });

  it("loads All places in pages of 50 as the list scrolls", async () => {
    await openPicker();
    // The scrolling box holds the list and the online footer.
    const list = screen.getByRole("listbox").parentElement!;
    await act(async () => {
      fireEvent.scroll(list);
    });
    expect(get.mock.calls.some(([url]) => String(url).includes("offset=50"))).toBe(true);
    expect(screen.getByText("Place 99")).toBeTruthy();
  });

  it("searches what's typed, with the photos' point to break ties", async () => {
    vi.useFakeTimers();
    try {
      const { input } = await openPicker();
      get.mockResolvedValueOnce({ places: [spot("King Fisher Pond", "nearby")], nextOffset: null });
      fireEvent.change(input, { target: { value: "k".repeat(300) } });
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
      const url = String(get.mock.calls.at(-1)![0]);
      expect(url).toContain("q=");
      expect(url).toContain("near=");
    } finally {
      vi.useRealTimers();
    }
  });
});

const TOFINO_SPOT = spot("Tofino", "all", { group: null, locality: null, detail: "British Columbia" });
const photon = (...features: Array<[string, number, number]>) => ({
  ok: true,
  status: 200,
  json: async () => ({
    features: features.map(([name, lon, lat], i) => ({
      geometry: { coordinates: [lon, lat] },
      properties: {
        osm_type: "N",
        osm_id: i + 1,
        name,
        osm_value: "town",
        state: "British Columbia",
        country: "Canada",
      },
    })),
  }),
});
function setOnline(on: boolean) {
  Object.defineProperty(navigator, "onLine", { value: on, configurable: true });
}

describe("PlacePicker online results", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    get.mockResolvedValue({ places: [{ ...TOFINO_SPOT, lat: 49.15, lon: -125.9 }], nextOffset: null });
    fetchMock.mockResolvedValue(photon(["Tofino", -125.91, 49.16], ["Tofino Inlet", -125.8, 49.2]));
  });

  function renderSearch(onPick = vi.fn()) {
    render(<PlacePicker placeholder="Search places" onPick={onPick} bias={() => ({ lat: 49.1234, lon: -125.678 })} />);
    fireEvent.focus(screen.getByRole("combobox"));
    return onPick;
  }
  async function type(text: string, ms = 400) {
    fireEvent.change(screen.getByRole("combobox"), { target: { value: text } });
    await act(() => vi.advanceTimersByTimeAsync(ms));
  }
  const rows = () => screen.queryAllByRole("option").map((o) => o.textContent);

  it("lists the user's places first, then deduped online results under their heading", async () => {
    const onPick = renderSearch();
    await type("tofino");
    expect(screen.getByText("Online results")).toBeTruthy();
    // The online "Tofino" repeats the user's own Tofino, so only the Inlet shows.
    expect(rows()).toEqual(["TofinoBritish Columbia", "Tofino InletTown, British Columbia, Canada"]);
    expect(screen.getByText(/Photon \(komoot\), © OpenStreetMap contributors/)).toBeTruthy();
    const sent = new URL(fetchMock.mock.calls[0][0] as string);
    expect(sent.searchParams.get("lat")).toBe("49.1");
    fireEvent.click(screen.getByRole("option", { name: /Tofino Inlet/ }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ kind: "online", name: "Tofino Inlet", lat: 49.2 }));
  });

  it("never sends the photos' point online, only the map's", async () => {
    render(<PlacePicker placeholder="Search places" onPick={vi.fn()} near={{ lat: 53.9, lon: -122.75 }} />);
    await type("tofino");
    const sent = new URL(fetchMock.mock.calls[0][0] as string);
    expect(sent.searchParams.get("lat")).toBeNull();
  });

  it("waits for typing to settle, needs three characters, and cancels a stale search", async () => {
    renderSearch();
    await type("to");
    expect(fetchMock).not.toHaveBeenCalled();
    await type("tof", 100);
    await type("tofi", 100);
    expect(fetchMock).not.toHaveBeenCalled();
    await type("tofin");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(fetchMock.mock.calls[0][0] as string).searchParams.get("q")).toBe("tofin");
  });

  it("never asks online with the setting Off, or while offline", async () => {
    localStorage.setItem("lifer:places-online", '"off"');
    renderSearch();
    await type("tofino");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rows()).toEqual(["TofinoBritish Columbia"]);
  });

  it("keeps offline results with one quiet line when online search fails", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    renderSearch();
    await type("tofino");
    expect(rows()[0]).toBe("TofinoBritish Columbia");
    expect(screen.getByText("Online search unavailable")).toBeTruthy();
  });

  it("shows nothing online when the device is offline", async () => {
    setOnline(false);
    renderSearch();
    await type("tofino");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains itself once: Got it hides the notice for good, Turn off stops online search", async () => {
    renderSearch();
    await type("tofino");
    expect(screen.getByTestId("online-places-notice").textContent).toMatch(/what you type goes to Photon/);
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByTestId("online-places-notice")).toBeNull();
    expect(localStorage.getItem("lifer:places-online-noted")).toBe("true");

    cleanup();
    localStorage.clear();
    renderSearch();
    await type("ucluelet");
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    expect(localStorage.getItem("lifer:places-online")).toBe('"off"');
  });
});

describe("PlacePicker room and towns", () => {
  it("keeps room under the field for the open list, except over a map", async () => {
    await openPicker();
    expect(document.querySelector("[data-place-room]")).toBeTruthy();
    cleanup();
    await openPicker({ overlay: true });
    expect(document.querySelector("[data-place-room]")).toBeNull();
  });

  it("searches towns and areas only, each as one line, and keeps the text the caller holds", async () => {
    vi.useFakeTimers();
    const onPick = vi.fn();
    const onValueChange = vi.fn();
    get.mockResolvedValue({
      places: [
        spot("Prince Pond", null as never, { group: null }),
        {
          ...spot("Prince George", null as never, { group: null }),
          kind: "town",
          id: "6113335",
          detail: "British Columbia, Canada",
          locality: "Prince George, British Columbia, Canada",
        },
      ],
      nextOffset: null,
    });
    render(<PlacePicker towns value="prince" onValueChange={onValueChange} placeholder="Town" onPick={onPick} />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(get.mock.calls.every(([url]) => String(url).includes("q=prince"))).toBe(true);
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options[0]).toBe("Prince George, British Columbia, Canada");
    expect(options).not.toContain("Prince Pond");
    fireEvent.click(screen.getAllByRole("option")[0]);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ kind: "town" }));
    expect(onValueChange).not.toHaveBeenCalledWith("");
  });
});

describe("PlacePicker adding a typed name", () => {
  it("offers a name that isn't a place yet as a new place, first, and hands the name over", async () => {
    vi.useFakeTimers();
    const { input, onNewPlace } = await openPicker();
    get.mockResolvedValue({ places: [spot("King Fisher Marsh", null as never, { group: null })], nextOffset: null });
    fireEvent.change(input, { target: { value: "King Fisher Pond" } });
    await act(() => vi.advanceTimersByTimeAsync(400));
    const options = screen.getAllByRole("option");
    expect(options[0].textContent).toBe("Add “King Fisher Pond” as a new place");
    // The map row isn't repeated at the bottom while typing.
    expect(options.at(-1)!.textContent).not.toBe("New place from the map");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onNewPlace).toHaveBeenCalledWith("King Fisher Pond");
  });

  it("doesn't offer a name that is already one of the user's places", async () => {
    vi.useFakeTimers();
    const { input } = await openPicker();
    get.mockResolvedValue({ places: [spot("King Fisher Pond", null as never, { group: null })], nextOffset: null });
    fireEvent.change(input, { target: { value: "king fisher pond" } });
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(screen.queryByText(/as a new place/)).toBeNull();
  });
});
