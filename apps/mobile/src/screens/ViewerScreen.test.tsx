import { describe, expect, it, jest } from "@jest/globals";
import "@testing-library/react-native/matchers";
import { AccessibilityInfo, ActionSheetIOS, Dimensions, FlatList } from "react-native";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { applyCaptureChanges } from "../store/library";
import { filmstripSide } from "../photos/viewerChrome";
import { harness, nav, renderApp } from "../testing/harness";
import { capture } from "../testing/seed";
import { ViewerScreen } from "./ViewerScreen";

const IDS = ["p-1", "p-2", "p-3"];
const open = async (opts: { reduceMotion?: boolean } = {}) => {
  if (opts.reduceMotion) jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
  const h = await harness({
    paired: true,
    seed: async (db) =>
      applyCaptureChanges(db, [capture("1", "Cygnus olor", "2026-09-02T10:00:00Z", { locationLabel: "X" })], []),
  });
  await renderApp(<ViewerScreen route={{ params: { ids: IDS, index: 0 } }} />, h);
  await screen.findByText("Cygnus olor");
  return h;
};
const controlsShown = () => screen.queryByRole("button", { name: "Close" }) !== null;
const photo = () => screen.getByRole("imagebutton", { name: /of 3/ });
const statusBar = () => {
  const find = (n: unknown): Record<string, unknown> | null => {
    const x = n as { type?: string; props?: Record<string, unknown>; children?: unknown[] } | string | null;
    if (!x || typeof x === "string") return null;
    if (x.type === "StatusBar") return x.props ?? {};
    for (const c of x.children ?? []) {
      const r = find(c);
      if (r) return r;
    }
    return null;
  };
  return find(screen.toJSON());
};
const swipeTo = (i: number) =>
  act(() => screen.getByTestId("viewer-pager").props.onViewableItemsChanged({ viewableItems: [{ index: i }] }));

describe("ViewerScreen immersive mode", () => {
  it("opens with the controls shown, a tap hides them, another tap brings them back", async () => {
    await open();
    expect(controlsShown()).toBe(true);
    await fireEvent.press(photo());
    expect(controlsShown()).toBe(false);
    await fireEvent.press(photo());
    expect(controlsShown()).toBe(true);
  });

  it("zooming in hides the controls and zooming out restores them", async () => {
    await open();
    const zoom = screen.getByTestId("viewer-zoom");
    await fireEvent.scroll(zoom, { nativeEvent: { zoomScale: 2 } });
    expect(controlsShown()).toBe(false);
    await fireEvent.scroll(zoom, { nativeEvent: { zoomScale: 1 } });
    expect(controlsShown()).toBe(true);
  });

  it("zooming in does not bring back controls the person hid before zooming", async () => {
    await open();
    await fireEvent.press(photo());
    const zoom = screen.getByTestId("viewer-zoom");
    await fireEvent.scroll(zoom, { nativeEvent: { zoomScale: 2 } });
    await fireEvent.scroll(zoom, { nativeEvent: { zoomScale: 1 } });
    expect(controlsShown()).toBe(false);
  });

  it("keeps the controls state when swiping to another photo", async () => {
    await open();
    await fireEvent.press(photo());
    await swipeTo(1);
    expect(controlsShown()).toBe(false);
    await fireEvent.press(screen.getByRole("imagebutton", { name: /2 of 3/ }));
    await swipeTo(2);
    expect(controlsShown()).toBe(true);
  });

  it("with Reduce Motion the controls go at once and the status bar does not animate", async () => {
    await open({ reduceMotion: true });
    await act(async () => undefined);
    await fireEvent.press(photo());
    expect(controlsShown()).toBe(false);
    expect(statusBar()).toMatchObject({
      hidden: true,
      animated: false,
      hideTransitionAnimation: "none",
    });
  });

  it("offers Show controls / Hide controls as a screen reader action on the photo", async () => {
    await open();
    expect(photo().props.accessibilityActions).toEqual([{ name: "toggleControls", label: "Hide controls" }]);
    await fireEvent(photo(), "accessibilityAction", { nativeEvent: { actionName: "toggleControls" } });
    expect(controlsShown()).toBe(false);
    expect(photo().props.accessibilityActions).toEqual([{ name: "toggleControls", label: "Show controls" }]);
  });

  it("closes from the button even after the controls were hidden and shown again", async () => {
    await open();
    await fireEvent.press(photo());
    await fireEvent.press(photo());
    await fireEvent.press(screen.getByRole("button", { name: "Close" }));
    expect(nav().goBack).toHaveBeenCalled();
  });
});

describe("ViewerScreen photo menu", () => {
  it("has one More button; its menu lists View species and Info with the desktop names", async () => {
    await open();
    expect(screen.getAllByRole("button", { name: "More" })).toHaveLength(1);
    const sheet = jest.spyOn(ActionSheetIOS, "showActionSheetWithOptions").mockImplementation(() => undefined);
    await fireEvent.press(screen.getByRole("button", { name: "More" }));
    const options = sheet.mock.calls[0]![0].options;
    expect(options.slice(0, 2)).toEqual(["View species", "View full size"]);
    expect(options).toContain("Info");
  });
});

describe("ViewerScreen window changes", () => {
  it("scrolls back to the same photo when the window width changes", async () => {
    await open();
    await swipeTo(1);
    const scrollTo = jest.spyOn(FlatList.prototype, "scrollToIndex").mockImplementation(() => undefined);
    const { width, height } = Dimensions.get("window");
    await act(async () => Dimensions.set({ window: { width: width * 2, height, scale: 2, fontScale: 1 } }));
    expect(scrollTo).toHaveBeenCalledWith({ index: 1, animated: false });
  });
});

describe("filmstripSide", () => {
  it("shows up to three each side with 44 pt targets, fewer on narrow windows, none when only one fits", () => {
    expect(filmstripSide(393, 44, 4, 3)).toBe(3);
    expect(filmstripSide(320, 44, 4, 3)).toBe(2);
    expect(filmstripSide(90, 44, 4, 3)).toBe(0);
  });
});
