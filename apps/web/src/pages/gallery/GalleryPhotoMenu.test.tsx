// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import { ToastProvider } from "../../components/ToastProvider";
import { GalleryPhotoMenu } from "./GalleryPhotoMenu";
import type { GalleryEdits } from "./useGalleryEdits";
import type { GalleryItem } from "./types";

vi.mock("../../hooks/useInatStatus", () => ({ useInatStatus: () => null }));
vi.mock("../../hooks/useOpenInEditors", () => ({ useOpenInEditors: () => ({ editors: [], openIn: () => {} }) }));
vi.mock("../../hooks/useRevealOriginal", () => ({ useRevealOriginal: () => () => null }));

afterEach(cleanup);

describe("GalleryPhotoMenu", () => {
  it("opens the coordinates dialog for this photo from its one Location item", () => {
    const edits = { setPlacingCaptureId: vi.fn(), setEditing: vi.fn() };
    render(
      <MemoryRouter>
        <ToastProvider>
          <GalleryPhotoMenu
            item={
              {
                captureId: "c1",
                photoId: "p1",
                speciesId: "s1",
                locationLabel: "Burnaby Lake",
                regionName: "British Columbia",
                kind: "image",
              } as GalleryItem
            }
            edits={edits as unknown as GalleryEdits}
            closeMenu={() => {}}
          />
        </ToastProvider>
      </MemoryRouter>,
    );
    const item = screen.getByRole("menuitem", { name: /^Location/ });
    expect(item.textContent).toBe("LocationBurnaby Lake, British Columbia");
    fireEvent.click(item);
    expect(edits.setPlacingCaptureId).toHaveBeenCalledWith("c1");
    expect(screen.queryByRole("menuitem", { name: /Place name and region/ })).toBeNull();
  });
});
