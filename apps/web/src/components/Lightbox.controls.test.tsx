// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastContext, type ToastApi } from "../hooks/useToast";
import { librarySlide, type LibraryPhoto } from "../lib/librarySlide";
import Lightbox, { type LightboxSlide } from "./Lightbox";

const post = vi.fn().mockResolvedValue({});
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: { ...actual.api, get: vi.fn(() => new Promise(() => {})), post: (...a: unknown[]) => post(...a) },
  };
});

const toast: ToastApi = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

afterEach(() => vi.clearAllMocks());

function show(slides: LightboxSlide[]) {
  render(
    <MemoryRouter>
      <ToastContext.Provider value={toast}>
        <Lightbox slides={slides} index={0} onIndexChange={() => {}} onClose={() => {}} />
      </ToastContext.Provider>
    </MemoryRouter>,
  );
  return screen.getByRole("dialog", { name: "Photo viewer" });
}

const photo: LibraryPhoto = {
  photoId: "p1",
  captureId: "c1",
  speciesId: "s1",
  qualityRating: 3,
  takenAt: "2026-11-17T19:42:05.000Z",
  takenAtZoned: false,
  lat: 49,
  lon: -123,
  regionId: "r1",
  originalRef: "/photos/IMG_1.jpg",
};

describe("the viewer's controls", () => {
  it("gives a map photo fullscreen, the standard photo menu and close", async () => {
    const actions = { rate: vi.fn(), reassign: vi.fn(), changed: vi.fn(), deleted: vi.fn() };
    const viewer = show([librarySlide(photo, "Bald Eagle", actions)]);
    for (const name of ["Enter fullscreen", "More options", "Close"])
      expect(within(viewer).getByRole("button", { name })).toBeTruthy();

    fireEvent.click(within(viewer).getByRole("button", { name: "More options" }));
    for (const name of ["Correct the ID", "Add to album", "Location", "Adjust date and time"])
      expect(screen.getByRole("menuitem", { name: new RegExp(`^${name}`) })).toBeTruthy();

    // Delete is instant, with Undo on the toast, and the page drops the photo.
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete photo" }));
    await waitFor(() => expect(actions.deleted).toHaveBeenCalledWith("c1"));
    expect(post).toHaveBeenCalledWith("/captures/batch-delete", { captureIds: ["c1"], deleteRaw: false });
    expect(toast.show).toHaveBeenCalled();
  });

  it("shows when it was taken as shot, with the seconds on hover", () => {
    const viewer = show([librarySlide(photo, "Bald Eagle", { rate() {}, reassign() {}, changed() {}, deleted() {} })]);
    expect(within(viewer).getByText("Bald Eagle", { exact: false })).toBeTruthy();
    const taken = within(viewer).getByText(/^Nov 17, 2026, 7:42\W/);
    expect(taken.getAttribute("title")).toMatch(/7:42:05/);
  });

  it("says No date for a library photo without one", () => {
    const viewer = show([
      librarySlide({ ...photo, takenAt: null }, "Bald Eagle", { rate() {}, reassign() {}, changed() {}, deleted() {} }),
    ]);
    expect(within(viewer).getByText("No date")).toBeTruthy();
  });

  it("keeps a shared page read-only: fullscreen, Download when allowed, and close", () => {
    const viewer = show([
      { url: "/api/share/t/photos/p1/display", caption: "Bald Eagle", download: { url: "/d", filename: "a.jpg" } },
    ]);
    for (const name of ["Download", "Enter fullscreen", "Close"])
      expect(within(viewer).getByRole("button", { name })).toBeTruthy();
    expect(within(viewer).queryByRole("button", { name: "More options" })).toBeNull();
    expect(within(viewer).queryByText("No date")).toBeNull();
  });

  it("puts the corner buttons on a dark chip that reads on any photo, 44px to touch on a phone", () => {
    const viewer = show([{ url: "/a.jpg", caption: "Heron" }]);
    const close = within(viewer).getByRole("button", { name: "Close" });
    expect(close.className).toMatch(/bg-black\/\d+/);
    expect(close.className).toMatch(/ring-white\/\d+/);
    expect(close.className).toMatch(/\bh-11 w-11\b/);
  });
});
