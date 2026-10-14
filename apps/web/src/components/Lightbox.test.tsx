// @vitest-environment jsdom
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ToastContext, type ToastApi } from "../hooks/useToast";
import Lightbox, { type LightboxSlide } from "./Lightbox";
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
});
