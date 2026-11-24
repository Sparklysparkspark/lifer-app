// @vitest-environment jsdom
import { useMemo, useState } from "react";
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
  // The caller owns the index; the slides change under it, as after a rating re-sorts the list.
  function ListHarness({ list, start, onClose }: { list: LightboxSlide[]; start: number; onClose: () => void }) {
    const [index, setIndex] = useState(start);
    return <Lightbox slides={list} index={index} onIndexChange={setIndex} onClose={onClose} />;
  }
  const view = (list: LightboxSlide[], start: number, onClose = vi.fn()) => (
    <MemoryRouter>
      <ToastContext.Provider value={toast}>
        <ListHarness list={list} start={start} onClose={onClose} />
      </ToastContext.Provider>
    </MemoryRouter>
  );
  const [a, b, c] = slides;

  it("stays on the shown photo when the list reorders", () => {
    const { rerender } = render(view(slides, 1));
    expect(screen.getByText("Snowy Egret")).toBeTruthy();
    rerender(view([b, a, c], 1));
    expect(screen.getByText("Snowy Egret")).toBeTruthy();
    expect(screen.getByText("1 / 3")).toBeTruthy();
  });

  it("shows the next photo when the shown one leaves, and the last when it was last", () => {
    const { rerender } = render(view(slides, 1));
    rerender(view([a, c], 1));
    expect(screen.getByText("Green Heron")).toBeTruthy();
    rerender(view([a], 1));
    expect(screen.getByText("Great Blue Heron")).toBeTruthy();
  });

  it("follows the photo it moved to when a rate-and-next re-sorts the list", () => {
    function RatingHarness() {
      const [order, setOrder] = useState([0, 1, 2]);
      const [index, setIndex] = useState(0);
      // Rating sorts the rated photo to the end, in the same update as the move.
      const list = useMemo(
        () => order.map((i) => ({ ...slides[i], onRate: () => setOrder((o) => [...o.filter((x) => x !== i), i]) })),
        [order],
      );
      return <Lightbox slides={list} index={index} onIndexChange={setIndex} onClose={() => {}} />;
    }
    render(
      <MemoryRouter>
        <ToastContext.Provider value={toast}>
          <RatingHarness />
        </ToastContext.Provider>
      </MemoryRouter>,
    );
    expect(screen.getByText("Great Blue Heron")).toBeTruthy();
    fireEvent.keyDown(window, { key: "#", code: "Digit3", shiftKey: true });
    expect(screen.getByText("Snowy Egret")).toBeTruthy();
  });

  it("closes once instead of showing an empty overlay", () => {
    const onClose = vi.fn();
    const { rerender } = render(view(slides, 2, onClose));
    expect(onClose).not.toHaveBeenCalled();
    rerender(view(slides.slice(0, 1), 2, onClose));
    expect(onClose).not.toHaveBeenCalled();
    rerender(view([], 2, onClose));
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
