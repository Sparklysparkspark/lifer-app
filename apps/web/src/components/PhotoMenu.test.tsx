// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../i18n";
import { ToastProvider } from "./ToastProvider";
import PhotoMenu, { type PhotoMenuPhoto } from "./PhotoMenu";

vi.mock("../hooks/useInatStatus", () => ({ useInatStatus: () => ({ available: true, connected: true }) }));
vi.mock("../hooks/useSendToInat", () => ({ useSendToInat: () => async () => true }));
vi.mock("../hooks/useOpenInEditors", () => ({ useOpenInEditors: () => ({ editors: [], openIn: () => {} }) }));
vi.mock("../hooks/useRevealOriginal", () => ({
  useRevealOriginal: () => (ref: string | null) => (ref ? { kind: "reveal", label: "Show in Finder", run: () => {} } : null),
  useRevealFiles: (refs: Array<string | null | undefined>) => {
    const files = [...new Set(refs.filter(Boolean))] as string[];
    return files.map((ref) => ({
      kind: "reveal",
      label: files.length > 1 ? `Show in Finder: ${ref.split("/").pop()}` : "Show in Finder",
      run: () => {},
    }));
  },
}));

afterEach(cleanup);

const photo: PhotoMenuPhoto = {
  captureId: "c1",
  photoId: "p1",
  speciesId: "s1",
  rating: 3,
  originalRef: "/Volumes/A/IMG_1.CR3",
  originalKind: "jpeg",
  originalManaged: false,
  hasRaw: true,
  inatObservationId: null,
};

function items(): string[] {
  return screen.getAllByRole("menuitem").map((el) => el.textContent ?? "");
}

function renderMenu(props: Partial<Parameters<typeof PhotoMenu>[0]> = {}) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <PhotoMenu photo={photo} onClose={() => {}} {...props} />
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe("PhotoMenu", () => {
  it("lists every offered item in the one fixed order", () => {
    renderMenu({
      speciesLinkState: {},
      onRate: () => {},
      onToggleFeatured: () => {},
      coverItems: <button role="menuitem">Cover</button>,
      onAddToAlbum: () => {},
      onEditTags: () => {},
      onCorrectId: () => {},
      onTagSpecies: () => {},
      onSetLocation: () => {},
      location: "Burnaby Lake",
      onHide: () => {},
      endItems: <button role="menuitem">Remove from album</button>,
      onDelete: () => {},
    });
    expect(screen.getByRole("group", { name: "Rate" })).toBeTruthy();
    // Five sections here; the divider lines between them are CSS (index.css).
    expect(document.querySelectorAll("[data-menu-section]")).toHaveLength(5);
    expect(items()).toEqual([
      "View species",
      "Set as featured photo",
      "Cover",
      "Correct the ID",
      "Also features another species",
      "Add to album",
      "Edit tags",
      "LocationBurnaby Lake",
      "Similar photos",
      "Versions",
      "Download original",
      "Download RAW",
      "Show in Finder",
      "Copy file path",
      "Send to iNaturalist",
      "Hide photo",
      "Remove from album",
      "Delete photo",
    ]);
  });

  it("leaves out what the page doesn't offer or the photo lacks", () => {
    renderMenu({ photo: { ...photo, originalKind: "raw", originalManaged: true, inatObservationId: "9" } });
    expect(screen.queryByRole("group", { name: "Rate" })).toBeNull();
    expect(items()).toEqual([
      "Similar photos",
      "Versions",
      "Download RAW",
      "Show in Finder",
      "Copy file path",
      "View on iNaturalist",
    ]);
  });

  it("explains an unreachable original instead of offering its files", () => {
    renderMenu({ photo: { ...photo, originalAvailable: false, originalVolumeLabel: "Photos SSD" } });
    expect(screen.getByText('Connect "Photos SSD" to view this original')).toBeTruthy();
    expect(items()).toEqual(["Similar photos", "Versions", "Send to iNaturalist"]);
  });

  it("closes the menu before acting, and names the media kind", () => {
    const calls: string[] = [];
    renderMenu({
      photo: { ...photo, kind: "video" },
      onClose: () => calls.push("close"),
      onHide: () => calls.push("hide"),
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide video" }));
    expect(calls).toEqual(["close", "hide"]);
  });

  it("offers Delete with RAW files only beside an edited original", () => {
    const withRaw = vi.fn();
    const { unmount } = renderMenu({ onDelete: () => {}, onDeleteWithRaw: withRaw });
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete with RAW files" }));
    expect(withRaw).toHaveBeenCalled();
    unmount();
    renderMenu({ photo: { ...photo, originalKind: "raw" }, onDelete: () => {}, onDeleteWithRaw: withRaw });
    expect(screen.queryByRole("menuitem", { name: "Delete with RAW files" })).toBeNull();
  });

  it("offers Show in Finder and Copy file path for each file of a RAW and its edit, and the date editor", () => {
    const adjust = vi.fn();
    renderMenu({ photo: { ...photo, rawRef: "/Volumes/A/IMG_1.CR3", originalRef: "/Volumes/A/IMG_1.jpg" }, onAdjustTime: adjust });
    for (const name of [
      "Show in Finder: IMG_1.jpg",
      "Show in Finder: IMG_1.CR3",
      "Copy file path: IMG_1.jpg",
      "Copy file path: IMG_1.CR3",
    ])
      expect(screen.getByRole("menuitem", { name })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Adjust date and time" }));
    expect(adjust).toHaveBeenCalledTimes(1);
  });
});
