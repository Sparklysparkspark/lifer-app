// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { useEffect } from "react";
import { Link, MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ settings: { tipsEnabled: true, tipsSeen: [] as string[] } }));
vi.mock("../hooks/useSettings", () => ({ useSettings: () => ({ settings: state.settings, setLocal: vi.fn() }) }));
vi.mock("../api/client", () => ({ api: { post: vi.fn(() => Promise.resolve({})) } }));

import Tour, { TOUR_STATE, placeTourCard } from "./Tour";
import { useHint } from "../hooks/useTip";

// jsdom lays nothing out, so every element counts as on screen.
const rects = HTMLElement.prototype.getClientRects;
beforeEach(() => {
  vi.useFakeTimers();
  HTMLElement.prototype.getClientRects = () => [{}] as unknown as DOMRectList;
  document.documentElement.removeAttribute("data-ready");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  HTMLElement.prototype.getClientRects = rects;
});

const nav = { go: (_to: string) => {} };
function Nav() {
  const navigate = useNavigate();
  useEffect(() => {
    nav.go = (to) => navigate(to);
  }, [navigate]);
  return null;
}

function setup({ review = false, key = "a" } = {}) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/", state: TOUR_STATE, key }]}>
      <Nav />
      <aside>
        <a data-tour="collection" href="/">
          Collection
        </a>
        <Link data-tour="gallery" to="/gallery">
          Gallery
        </Link>
        {review && <span data-tour="review">Review</span>}
      </aside>
      <span data-tour="import">Import</span>
      <Tour />
    </MemoryRouter>,
  );
}

const draw = () =>
  act(() => {
    document.documentElement.setAttribute("data-ready", "/");
    vi.advanceTimersByTime(100);
  });
const card = () => screen.queryByTestId("tour-card");

describe("Tour", () => {
  it("starts only once the Collection has drawn", () => {
    setup({ key: "draws" });
    act(() => vi.advanceTimersByTime(500));
    expect(card()).toBeNull();
    draw();
    expect(card()).not.toBeNull();
    expect(screen.getByRole("dialog", { name: "Import photos" })).toBeTruthy();
  });

  it("skips steps whose control isn't on screen, but keeps search in the middle of the window", () => {
    setup({ key: "skips" });
    draw();
    // import, collection, gallery, search, versions
    expect(screen.getByText("1 of 5")).toBeTruthy();
    setup({ review: true, key: "review" });
    draw();
    expect(screen.getAllByText("1 of 6").length).toBeGreaterThan(0);
  });

  it("moves with Next, Back and the arrow keys, and ends on Done", () => {
    setup({ key: "keys" });
    draw();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("2 of 5")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText("3 of 5")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("1 of 5")).toBeTruthy();
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole("button", { name: "Next" }));
    // Versions come last, pointed at from the Gallery, where their stack badge shows.
    expect(screen.getByRole("dialog", { name: "Photo versions" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(card()).toBeNull();
  });

  it("ends on Esc and on Skip", () => {
    setup({ key: "esc" });
    draw();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(card()).toBeNull();
    cleanup();
    setup({ key: "skip" });
    draw();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(card()).toBeNull();
  });

  it("ends when the user goes to another page, and a link still navigates", () => {
    setup({ key: "nav" });
    draw();
    fireEvent.click(screen.getByText("Gallery"));
    expect(card()).toBeNull();
    cleanup();
    setup({ key: "nav2" });
    draw();
    act(() => nav.go("/stats"));
    expect(card()).toBeNull();
  });

  it("hides contextual hints while it runs", () => {
    setup({ key: "hints" });
    const hint = renderHook(() => useHint("smart-album", true));
    expect(hint.result.current.show).toBe(true);
    draw();
    expect(hint.result.current.show).toBe(false);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(hint.result.current.show).toBe(true);
  });
});

describe("placeTourCard", () => {
  const view = { width: 1000, height: 800 };
  const card = { width: 300, height: 120 };
  it("sits beside a sidebar item", () => {
    expect(placeTourCard({ top: 100, left: 8, width: 200, height: 32 }, true, card, view)).toEqual({
      top: 56,
      left: 220,
    });
  });
  it("sits below a top-bar item, or above it near the bottom, inside the window", () => {
    expect(placeTourCard({ top: 10, left: 950, width: 40, height: 30 }, false, card, view)).toEqual({
      top: 52,
      left: 692,
    });
    expect(placeTourCard({ top: 760, left: 0, width: 40, height: 30 }, false, card, view).top).toBe(628);
  });
  it("centres with no control to point at", () => {
    expect(placeTourCard(null, false, card, view)).toEqual({ top: 340, left: 350 });
  });
});
