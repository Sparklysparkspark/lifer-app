// @vitest-environment jsdom
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ToastContext, type ToastApi } from "../hooks/useToast";
import Lightbox, { type LightboxSlide } from "./Lightbox";
import TagEditor from "./TagEditor";
import BackToCollectionLink from "./BackToCollectionLink";

const toast: ToastApi = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

const slides: LightboxSlide[] = [
  { url: "/a.jpg", caption: "Great Blue Heron" },
  { url: "/b.jpg", caption: "Snowy Egret" },
  { url: "/c.jpg", caption: "Green Heron" },
];

// Owns the index like a real caller, so the shown slide follows onIndexChange.
function Harness({ onIndexChange, onClose }: { onIndexChange: (i: number) => void; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  return (
    <Lightbox
      slides={slides}
      index={index}
      onIndexChange={(i) => {
        onIndexChange(i);
        setIndex(i);
      }}
      onClose={onClose}
    />
  );
}

function renderLightbox() {
  const onIndexChange = vi.fn();
  const onClose = vi.fn();
  render(
    <MemoryRouter>
      <ToastContext.Provider value={toast}>
        <Harness onIndexChange={onIndexChange} onClose={onClose} />
      </ToastContext.Provider>
    </MemoryRouter>,
  );
  return { onIndexChange, onClose };
}

describe("Lightbox keyboard", () => {
  it("moves between slides with the arrow keys, wrapping at the ends", () => {
    const { onIndexChange } = renderLightbox();
    expect(screen.getByText("Great Blue Heron")).toBeTruthy();
    expect(screen.getByText("1 / 3")).toBeTruthy();

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onIndexChange).toHaveBeenLastCalledWith(1);
    expect(screen.getByText("Snowy Egret")).toBeTruthy();
    expect(screen.getByText("2 / 3")).toBeTruthy();

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(onIndexChange).toHaveBeenLastCalledWith(2);
    expect(screen.getByText("Green Heron")).toBeTruthy();
  });

  it("closes on Escape", () => {
    const { onClose, onIndexChange } = renderLightbox();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onIndexChange).not.toHaveBeenCalled();
  });
});

describe("Lightbox open photo leaving the list", () => {
  it("closes once instead of showing an empty overlay", () => {
    const onClose = vi.fn();
    const view = (list: LightboxSlide[]) => (
      <MemoryRouter>
        <ToastContext.Provider value={toast}>
          <Lightbox slides={list} index={2} onIndexChange={() => {}} onClose={onClose} />
        </ToastContext.Provider>
      </MemoryRouter>
    );
    const { rerender } = render(view(slides));
    expect(onClose).not.toHaveBeenCalled();
    rerender(view(slides.slice(0, 2)));
    rerender(view(slides.slice(0, 1)));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("TagEditor", () => {
  it("drops the half-typed tag on Escape and saves it on a click-away", () => {
    const onChange = vi.fn();
    render(<TagEditor tags={[]} onChange={onChange} />);
    const input = screen.getByPlaceholderText("Add a tag");

    fireEvent.change(input, { target: { value: "juv" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "adult" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(["adult"]);
  });
});

function GalleryLocation() {
  const { pathname, search } = useLocation();
  return (
    <>
      <p>at {pathname + search}</p>
      <Lightbox
        slides={[{ url: "/a.jpg", caption: "Osprey", speciesId: "sp1" }]}
        index={0}
        onIndexChange={() => {}}
        onClose={() => {}}
      />
    </>
  );
}

describe("Lightbox species link", () => {
  it("lets the species page return to the Gallery with its search", () => {
    render(
      <MemoryRouter initialEntries={["/gallery?q=water"]}>
        <ToastContext.Provider value={toast}>
          <Routes>
            <Route path="/gallery" element={<GalleryLocation />} />
            <Route path="/species/:id" element={<BackToCollectionLink />} />
          </Routes>
        </ToastContext.Provider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("link", { name: /View species/ }));
    // MemoryRouter keeps no browser history, so this exercises the no-history fallback.
    fireEvent.click(screen.getByRole("button", { name: "← Gallery" }));

    expect(screen.getByText("at /gallery?q=water")).toBeTruthy();
  });

  it("plays a recording under its waveform", () => {
    render(
      <MemoryRouter>
        <ToastContext.Provider value={toast}>
          <Lightbox
            slides={[{ url: "/wave.webp", audioUrl: "/api/photos/p1/audio", caption: "Barred Owl" }]}
            index={0}
            onIndexChange={vi.fn()}
            onClose={vi.fn()}
          />
        </ToastContext.Provider>
      </MemoryRouter>,
    );
    expect(document.querySelector("audio")?.getAttribute("src")).toBe("/api/photos/p1/audio");
    expect(document.querySelector("video")).toBeNull();
  });
});

describe("Lightbox photo", () => {
  it("shows the thumbnail in the full photo's box until the full photo has decoded", async () => {
    render(
      <MemoryRouter>
        <ToastContext.Provider value={toast}>
          <Lightbox
            slides={[{ url: "/full.webp", thumbUrl: "/thumb.webp", width: 6000, height: 4000 }]}
            index={0}
            onIndexChange={() => {}}
            onClose={() => {}}
          />
        </ToastContext.Provider>
      </MemoryRouter>,
    );
    const img = () => document.querySelector('[role="dialog"] img')!;
    expect(img().getAttribute("src")).toBe("/thumb.webp");
    // In the fixed zoom frame, whose size doesn't depend on the image, so nothing moves when it swaps.
    expect(img().closest("[data-zoom-pane]")).toBeTruthy();
    await waitFor(() => expect(img().getAttribute("src")).toBe("/full.webp"));
  });
});
