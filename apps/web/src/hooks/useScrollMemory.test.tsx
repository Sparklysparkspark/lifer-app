// @vitest-environment jsdom
// Back returns to the saved spot even when the page is too short at first, and holds it while the
// page settles.
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter, useNavigate, type NavigateFunction } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScrollMemory } from "./useScrollMemory";

// jsdom has no layout: the page's height is `maxScroll`, and scrolling clamps to it.
let maxScroll = 0;
let observers: Set<() => void>;
const scrollY = () => window.scrollY;
const setScroll = (y: number) => Object.defineProperty(window, "scrollY", { value: y, configurable: true });
// The page changing size, as a ResizeObserver on the body sees it.
const resize = () => act(() => observers.forEach((cb) => cb()));

function Page({ ready }: { ready: boolean }) {
  useScrollMemory(ready);
  return null;
}
const renderPage = (ready: boolean) =>
  render(
    <MemoryRouter initialEntries={[{ pathname: "/gallery", search: "?q=bird", key: "entry" }]}>
      <Page ready={ready} />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.useFakeTimers();
  observers = new Set();
  maxScroll = 0;
  setScroll(0);
  window.scrollTo = ((_x: number, y: number) => {
    setScroll(Math.max(0, Math.min(y, maxScroll)));
  }) as typeof window.scrollTo;
  window.scrollBy = ((_x: number, y: number) => window.scrollTo(0, scrollY() + y)) as typeof window.scrollBy;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      cb = () => {};
      constructor(cb: () => void) {
        this.cb = () => cb();
      }
      observe() {
        observers.add(this.cb);
      }
      disconnect() {
        observers.delete(this.cb);
      }
    },
  );
  sessionStorage.setItem("lifer:scroll:entry", JSON.stringify({ y: 900 }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("useScrollMemory", () => {
  it("keeps trying while the page is too short, and lands once it grows", () => {
    renderPage(true);
    act(() => vi.advanceTimersByTime(100));
    expect(scrollY()).toBe(0);
    // Longer than the settle time: a page still loading must not end the hold.
    act(() => vi.advanceTimersByTime(5000));
    maxScroll = 50_000;
    resize();
    expect(scrollY()).toBe(900);
  });

  it("returns to the top when the page was left at the top, even if its first card moved", () => {
    maxScroll = 50_000;
    sessionStorage.setItem("lifer:scroll:entry", JSON.stringify({ y: 0, anchor: { id: "card", top: 500 } }));
    // The map above came back taller: the card now sits 212 px lower than when the page was left.
    const card = document.createElement("div");
    card.dataset.scrollAnchor = "card";
    card.getBoundingClientRect = () => ({ top: 712 - scrollY() }) as DOMRect;
    document.body.append(card);
    renderPage(true);
    act(() => vi.advanceTimersByTime(100));
    expect(scrollY()).toBe(0);
    card.remove();
  });

  it("holds the spot through a late layout change, then lets go once the page is still", () => {
    maxScroll = 50_000;
    renderPage(true);
    act(() => vi.advanceTimersByTime(100));
    expect(scrollY()).toBe(900);
    // Tiles change after the restore (badges, folded bursts): the page shrinks for a moment.
    maxScroll = 400;
    resize();
    expect(scrollY()).toBe(400);
    maxScroll = 50_000;
    resize();
    expect(scrollY()).toBe(900);
    act(() => vi.advanceTimersByTime(5000));
    setScroll(1200);
    resize();
    expect(scrollY()).toBe(1200);
  });

  it("keeps holding through a swipe's sideways momentum, but stops when the user scrolls", () => {
    renderPage(true);
    act(() => vi.advanceTimersByTime(100));
    window.dispatchEvent(new WheelEvent("wheel", { deltaX: 40 }));
    maxScroll = 50_000;
    resize();
    expect(scrollY()).toBe(900);

    maxScroll = 0;
    resize();
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: 40 }));
    maxScroll = 50_000;
    resize();
    expect(scrollY()).toBe(0);
  });

  it("gives up on a page that never grows tall enough", () => {
    renderPage(true);
    act(() => vi.advanceTimersByTime(31_000));
    maxScroll = 50_000;
    resize();
    expect(scrollY()).toBe(0);
  });

  it("returns to each entry's own spot on Back and Forward within the same page", () => {
    maxScroll = 50_000;
    sessionStorage.setItem("lifer:scroll:b", JSON.stringify({ y: 300 }));
    const nav: { go: NavigateFunction } = { go: () => {} };
    function Nav() {
      const navigate = useNavigate();
      useEffect(() => {
        nav.go = navigate;
      });
      return null;
    }
    render(
      <MemoryRouter
        initialIndex={0}
        initialEntries={[
          { pathname: "/explore", key: "entry" },
          { pathname: "/explore", search: "?focus=x", key: "b" },
        ]}
      >
        <Page ready />
        <Nav />
      </MemoryRouter>,
    );
    act(() => vi.advanceTimersByTime(100));
    expect(scrollY()).toBe(900);
    // A browser reports the restore as a scroll, which saves the spot for its own entry.
    window.history.replaceState({ key: "entry" }, "");
    act(() => void window.dispatchEvent(new Event("scroll")));
    act(() => vi.advanceTimersByTime(20));
    act(() => void nav.go(1));
    act(() => vi.advanceTimersByTime(100));
    expect(scrollY()).toBe(300);
    act(() => void nav.go(-1));
    act(() => vi.advanceTimersByTime(100));
    expect(scrollY()).toBe(900);
  });
});
