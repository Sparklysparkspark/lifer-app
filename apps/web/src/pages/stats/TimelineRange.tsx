import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { sliderMove } from "../../lib/keymap";
import { binLabel, type TimelineBin } from "./timeline";

type Drag = { kind: "start" | "end" } | { kind: "move"; offset: number } | { kind: "draw"; anchor: number };

const HANDLES = ["start", "end"] as const;

const pct = (n: number, of: number) => `${(n / of) * 100}%`;

/** The strip under the timeline: every bin as a faint bar, the picked span as a green window. Drag the
 *  window to move it, its handles to resize it, or the strip to draw a new span; the handles also take
 *  the arrow keys, Home and End. */
export default function TimelineRange({
  bins,
  start,
  end,
  onChange,
}: {
  bins: ReadonlyArray<TimelineBin>;
  start: number;
  end: number;
  onChange: (start: number, end: number) => void;
}) {
  const { t } = useTranslation();
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const n = bins.length;
  const last = n - 1;
  const max = Math.max(1, ...bins.map((b) => b.total));

  function indexAt(clientX: number) {
    const rect = track.current!.getBoundingClientRect();
    return Math.min(last, Math.max(0, Math.floor(((clientX - rect.left) / rect.width) * n)));
  }

  function apply(d: Drag, i: number) {
    if (d.kind === "start") onChange(Math.min(i, end), end);
    else if (d.kind === "end") onChange(start, Math.max(i, start));
    else if (d.kind === "draw") onChange(Math.min(d.anchor, i), Math.max(d.anchor, i));
    else if (d.kind === "move") {
      const s = Math.min(Math.max(0, i - d.offset), last - (end - start));
      onChange(s, s + end - start);
    }
  }

  function begin(e: PointerEvent, d: Drag) {
    e.stopPropagation();
    e.preventDefault();
    track.current!.setPointerCapture(e.pointerId);
    drag.current = d;
    if (d.kind === "draw") apply(d, d.anchor);
  }

  function key(which: "start" | "end", e: KeyboardEvent) {
    const value = which === "start" ? start : end;
    const lo = which === "start" ? 0 : start;
    const hi = which === "start" ? end : last;
    const move = sliderMove(e);
    if (!move) return;
    const next = "step" in move ? value + move.step : move.end === "min" ? lo : hi;
    e.preventDefault();
    const clamped = Math.min(hi, Math.max(lo, next));
    if (which === "start") onChange(clamped, end);
    else onChange(start, clamped);
  }

  const handle = (which: "start" | "end") => {
    const value = which === "start" ? start : end;
    return (
      <div
        key={which}
        role="slider"
        tabIndex={0}
        aria-label={t(which === "start" ? "stats.timeline.rangeStart" : "stats.timeline.rangeEnd")}
        aria-valuemin={which === "start" ? 0 : start}
        aria-valuemax={which === "start" ? end : last}
        aria-valuenow={value}
        aria-valuetext={binLabel(bins[value].key, true)}
        onKeyDown={(e) => key(which, e)}
        onPointerDown={(e) => begin(e, { kind: which })}
        // A wide, invisible hit area around a slim grip on the window's edge.
        className="absolute inset-y-0 z-10 flex w-4 -translate-x-1/2 cursor-ew-resize touch-none items-center justify-center rounded-full"
        style={{ left: pct(which === "start" ? start : end + 1, n) }}
      >
        <span aria-hidden className="h-4 w-1 rounded-full bg-accent ring-2 ring-surface" />
      </div>
    );
  };

  return (
    // The inset leaves room for the grips at either end.
    <div className="mx-2">
      <div
        ref={track}
        className="relative h-9 cursor-crosshair touch-none select-none rounded-control bg-surface-muted"
        onPointerDown={(e) => begin(e, { kind: "draw", anchor: indexAt(e.clientX) })}
        onPointerMove={(e) => drag.current && apply(drag.current, indexAt(e.clientX))}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        <div aria-hidden className="absolute inset-x-0 bottom-1.5 top-1.5 flex items-end">
          {bins.map((b) => (
            <div key={b.key} className="flex h-full flex-1 items-end justify-center">
              {b.total > 0 && (
                <div
                  className="rounded-t-badge bg-muted opacity-40"
                  // A floor keeps a month with a single photo visible next to a busy one.
                  style={{ width: "min(60%, 6px)", height: `${Math.max(10, (b.total / max) * 100)}%` }}
                />
              )}
            </div>
          ))}
        </div>
        {/* The months left out fade back; the picked ones keep their full ink. */}
        <div className="absolute inset-y-0 left-0 rounded-l-control bg-surface/60" style={{ width: pct(start, n) }} />
        <div
          className="absolute inset-y-0 right-0 rounded-r-control bg-surface/60"
          style={{ width: pct(last - end, n) }}
        />
        <div
          className="absolute inset-y-0 cursor-grab rounded-control border border-accent/50 bg-accent/10 active:cursor-grabbing"
          style={{ left: pct(start, n), width: pct(end - start + 1, n) }}
          onPointerDown={(e) => begin(e, { kind: "move", offset: indexAt(e.clientX) - start })}
        />
        {HANDLES.map(handle)}
      </div>
      <div aria-hidden className="mt-1 flex justify-between text-caption tabular-nums text-muted">
        <span>{binLabel(bins[0].key)}</span>
        <span>{binLabel(bins[last].key)}</span>
      </div>
    </div>
  );
}
