// A short guided tour: an accent ring around one real control at a time, with a card beside it.
// Started by navigating to "/" with TOUR_STATE; it begins once the Collection has drawn, and any
// navigation the user makes afterwards ends it (navigation wins). It never covers or blocks the page.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import Button from "./Button";
import { setTourActive } from "../hooks/useTip";
import { isTypingTarget } from "../hooks/useKeyboardShortcuts";
import { matchAction, shortcutLabel } from "../lib/keymap";

/** Router state that starts the tour: `navigate("/", { state: TOUR_STATE })`. */
export const TOUR_STATE = { tour: true } as const;

interface Step {
  /** The `data-tour` value of the control it points at. */
  anchor: string;
  title: string;
  body: string;
  /** Shown in the middle of the window when the control isn't there (the web build has no search field). */
  optional?: true;
}

export const TOUR_STEPS: Step[] = [
  { anchor: "import", title: "tour.import.title", body: "tour.import.body" },
  { anchor: "collection", title: "tour.collection.title", body: "tour.collection.body" },
  { anchor: "gallery", title: "tour.gallery.title", body: "tour.gallery.body" },
  { anchor: "map", title: "tour.map.title", body: "tour.map.body" },
  { anchor: "albums", title: "tour.albums.title", body: "tour.albums.body" },
  { anchor: "stats", title: "tour.stats.title", body: "tour.stats.body" },
  { anchor: "review", title: "tour.review.title", body: "tour.review.body" },
  { anchor: "search", title: "tour.search.title", body: "tour.search.body", optional: true },
];

// How long to wait for the Collection's ready marker before starting anyway (an error or empty state).
const READY_TIMEOUT_MS = 3000;
const POLL_MS = 50;

function findAnchor(name: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`)) {
    if (el.getClientRects().length > 0) return el;
  }
  return null;
}

/** The steps whose control is on screen now, in order. */
export function availableSteps(steps: Step[] = TOUR_STEPS): Step[] {
  return steps.filter((s) => s.optional || findAnchor(s.anchor));
}

type Box = Pick<DOMRect, "top" | "left" | "width" | "height">;

/** Where the card goes: beside a sidebar item, below (or above) a top-bar one, centred with no
 *  anchor; always inside the window. */
export function placeTourCard(
  anchor: Box | null,
  beside: boolean,
  card: { width: number; height: number },
  view: { width: number; height: number },
  gap = 12,
  edge = 8,
): { top: number; left: number } {
  const x = (v: number) => Math.max(edge, Math.min(v, view.width - card.width - edge));
  const y = (v: number) => Math.max(edge, Math.min(v, view.height - card.height - edge));
  if (!anchor) return { top: y((view.height - card.height) / 2), left: x((view.width - card.width) / 2) };
  const right = anchor.left + anchor.width + gap;
  if (beside && right + card.width <= view.width - edge) {
    return { top: y(anchor.top + anchor.height / 2 - card.height / 2), left: right };
  }
  const bottom = anchor.top + anchor.height + gap;
  const top = bottom + card.height <= view.height - edge ? bottom : y(anchor.top - gap - card.height);
  return { top, left: x(anchor.left + anchor.width / 2 - card.width / 2) };
}

// History entries that already started a tour, so going Back to one doesn't start it again.
const consumed = new Set<string>();

export default function Tour() {
  const { t } = useTranslation();
  const location = useLocation();
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [index, setIndex] = useState(0);
  const [pending, setPending] = useState(false);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const onCollection = location.pathname === "/";

  const end = useCallback(() => {
    setSteps(null);
    const el = restoreFocus.current;
    restoreFocus.current = null;
    if (el?.isConnected) el.focus();
  }, []);

  // A request is remembered apart from the router state, which the Collection's own URL updates
  // (restoring the last region) replace.
  const [seenKey, setSeenKey] = useState<string | null>(null);
  const requested = (location.state as { tour?: boolean } | null)?.tour === true;
  if (requested && onCollection && location.key !== seenKey && !consumed.has(location.key)) {
    setSeenKey(location.key);
    setSteps(null);
    setPending(true);
  }
  useEffect(() => {
    if (seenKey) consumed.add(seenKey);
  }, [seenKey]);
  // The user going to another page ends it.
  if (!onCollection && (steps || pending)) {
    setSteps(null);
    setPending(false);
  }

  // Starts once the Collection has drawn, so its controls are the ones pointed at.
  useEffect(() => {
    if (!pending) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      const drawn = document.documentElement.getAttribute("data-ready") === "/";
      if (!drawn && Date.now() - started < READY_TIMEOUT_MS) return;
      clearInterval(timer);
      setPending(false);
      const found = availableSteps();
      if (found.length === 0) return;
      restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setIndex(0);
      setSteps(found);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [pending]);

  const active = steps !== null;
  useEffect(() => {
    setTourActive(active);
    return () => setTourActive(false);
  }, [active]);

  const next = useCallback(() => {
    if (!steps) return;
    if (index >= steps.length - 1) end();
    else setIndex(index + 1);
  }, [steps, index, end]);
  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      // A dialog opened on top (the palette, the shortcut sheet) owns the keys; Esc closes it first.
      // raw-control: looks for an open Modal, renders none.
      if (document.querySelector('[aria-modal="true"]') || isTypingTarget(e.target)) return;
      const action = matchAction(e, ["next", "previous", "close"] as const);
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      if (action === "next") next();
      else if (action === "previous") back();
      else end();
    };
    // Any link, the sidebar's included, just goes where it says, and the tour steps aside.
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target?.closest("a[href]") && !cardRef.current?.contains(target)) end();
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("click", onClick, true);
    };
  }, [active, next, back, end]);

  if (!steps) return null;
  const step = steps[Math.min(index, steps.length - 1)]!;
  return (
    <TourCard
      key={step.anchor}
      step={step}
      position={t("tour.position", { current: index + 1, total: steps.length })}
      first={index === 0}
      last={index === steps.length - 1}
      cardRef={cardRef}
      onNext={next}
      onBack={back}
      onSkip={end}
      labels={{
        title: t(step.title),
        body: t(step.body, { palette: shortcutLabel("palette"), shortcuts: shortcutLabel("shortcuts") }),
        next: t(index === steps.length - 1 ? "tour.done" : "tour.next"),
        back: t("tour.back"),
        skip: t("tour.skip"),
      }}
    />
  );
}

function TourCard({
  step,
  position,
  first,
  last,
  cardRef,
  onNext,
  onBack,
  onSkip,
  labels,
}: {
  step: Step;
  position: string;
  first: boolean;
  last: boolean;
  cardRef: React.RefObject<HTMLDivElement | null>;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
  labels: { title: string; body: string; next: string; back: string; skip: string };
}) {
  const titleId = useId();
  const bodyId = useId();
  const nextRef = useRef<HTMLButtonElement>(null);
  const [ring, setRing] = useState<Box | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Follows the control through scrolling and resizing.
  useLayoutEffect(() => {
    const measure = () => {
      const el = findAnchor(step.anchor);
      const box = el?.getBoundingClientRect() ?? null;
      setRing(box ? { top: box.top, left: box.left, width: box.width, height: box.height } : null);
      const card = cardRef.current?.getBoundingClientRect();
      if (!card) return;
      setPos(
        placeTourCard(box, !!el?.closest("aside"), card, { width: window.innerWidth, height: window.innerHeight }),
      );
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [step.anchor, cardRef]);

  useEffect(() => nextRef.current?.focus({ preventScroll: true }), []);

  return (
    <>
      {ring && (
        <div
          aria-hidden="true"
          style={{ top: ring.top - 4, left: ring.left - 4, width: ring.width + 8, height: ring.height + 8 }}
          className="pointer-events-none fixed z-50 rounded-control ring-2 ring-accent"
        />
      )}
      <div
        ref={cardRef}
        // raw-control: a non-modal coach mark beside the control it explains; the page stays usable.
        role="dialog"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-testid="tour-card"
        style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden" }}
        className="fixed z-50 w-80 max-w-[calc(100vw-1rem)] rounded-panel border border-line bg-surface p-4 text-ink shadow-lg"
      >
        <h2 id={titleId} className="text-headline font-semibold">
          {labels.title}
        </h2>
        <p id={bodyId} className="mt-1 text-callout text-muted">
          {labels.body}
        </p>
        <div className="mt-4 flex items-center gap-2">
          <span className="mr-auto text-footnote tabular-nums text-muted">{position}</span>
          {!last && (
            <Button variant="ghost" size="sm" onClick={onSkip}>
              {labels.skip}
            </Button>
          )}
          {!first && (
            <Button variant="secondary" size="sm" onClick={onBack}>
              {labels.back}
            </Button>
          )}
          <Button ref={nextRef} size="sm" onClick={onNext}>
            {labels.next}
          </Button>
        </div>
      </div>
    </>
  );
}
