import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { hasEarlierPage } from "../hooks/useGoBack";
import { useLatest } from "../hooks/useLatest";

// Horizontal scroll, in pixels, that makes a swipe count.
const THRESHOLD = 160;
// A gap this long between wheel events ends the gesture, momentum included.
const GESTURE_END_MS = 200;
// After a swipe lands, its momentum can arrive in bursts behind the new page's first render;
// nothing counts until this long has passed.
const COOLDOWN_MS = 1000;

// Something under the pointer that scrolls sideways (a wide table, a strip of photos) keeps the
// swipe for itself.
function scrollsSideways(target: EventTarget | null): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== document.body; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth && /auto|scroll/.test(getComputedStyle(el).overflowX)) return true;
  }
  return false;
}

const historyIndex = () => (window.history.state as { idx?: number } | null)?.idx ?? 0;

/** The desktop app's two-finger swipe back and forward, like a browser's: the webview has its own,
 *  but that one can swipe past the app onto the shell's startup page. Only moves within Lifer, and
 *  never while a dialog or the photo viewer is open. */
export default function SwipeBack() {
  const navigate = useNavigate();
  const navigateRef = useLatest(navigate);
  // Positive while swiping back, negative while swiping forward, as a share of THRESHOLD.
  const [progress, setProgress] = useState(0);

  // History has no "is there a forward page" query, so track the furthest entry reached.
  const furthest = useRef(historyIndex());
  const { key } = useLocation();
  const navigationType = useNavigationType();
  useEffect(() => {
    // Only a new page drops what's ahead; a replace (search typing) keeps it, as the browser does.
    furthest.current = navigationType === "PUSH" ? historyIndex() : Math.max(furthest.current, historyIndex());
  }, [key, navigationType]);

  // Registered once: navigate changes with every page, and re-registering mid-swipe would reset
  // the gesture and let its momentum go back a second page.
  useEffect(() => {
    let travelled = 0;
    let fired = false;
    let firedAt = -Infinity;
    let lastEventAt = -Infinity;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;

    function onWheel(e: WheelEvent) {
      // The gesture ends at a pause in the events themselves, by their own timestamps: a page
      // opening can hold up the rest of a swipe, and a timer would then count it as a new one.
      if (performance.now() - firedAt < COOLDOWN_MS) {
        lastEventAt = e.timeStamp;
        return;
      }
      if (e.timeStamp - lastEventAt > GESTURE_END_MS) {
        travelled = 0;
        fired = false;
      }
      lastEventAt = e.timeStamp;
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => setProgress(0), GESTURE_END_MS);
      // ctrlKey is a pinch. Mostly vertical movement is ordinary scrolling.
      // defaultPrevented: something under the pointer used the scroll itself, like a map's pan.
      if (fired || e.ctrlKey || e.defaultPrevented || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      if (document.querySelector('[role="dialog"], [data-overlay]') || scrollsSideways(e.target)) return;
      // Fingers moving right means back, whichever way the system's scroll direction is set.
      const inverted = (e as WheelEvent & { webkitDirectionInvertedFromDevice?: boolean })
        .webkitDirectionInvertedFromDevice;
      travelled += inverted ? -e.deltaX : e.deltaX;
      if (travelled > 0 && !hasEarlierPage()) travelled = 0;
      if (travelled < 0 && historyIndex() >= furthest.current) travelled = 0;
      if (Math.abs(travelled) >= THRESHOLD) {
        fired = true;
        firedAt = performance.now();
        setProgress(0);
        navigateRef.current(travelled > 0 ? -1 : 1);
      } else {
        setProgress(travelled / THRESHOLD);
      }
    }

    window.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      window.removeEventListener("wheel", onWheel);
      clearTimeout(hideTimer);
    };
  }, [navigateRef]);

  if (progress === 0) return null;
  const back = progress > 0;
  const amount = Math.abs(progress);
  return (
    <div
      aria-hidden
      className={`pointer-events-none fixed top-1/2 z-50 flex h-10 w-10 items-center justify-center rounded-full border border-line bg-surface text-ink shadow-md ${
        back ? "left-3" : "right-3"
      }`}
      style={{ opacity: amount, transform: `translate(${(amount - 1) * (back ? 24 : -24)}px, -50%)` }}
    >
      <svg
        viewBox="0 0 20 20"
        className={`h-5 w-5 ${back ? "" : "rotate-180"}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path d="M12 4l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
