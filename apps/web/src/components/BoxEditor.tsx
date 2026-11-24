// Adapted from the companion app. A free rectangle over a photo, in the spirit of CardCropEditor but
// held in fractions of the photo (right at any zoom), with four corner handles and no dialog of its
// own: the caller confirms. A drag on open photo draws a new box; a click picks the numbered box under it.
import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { boxBetween, boxArea, insideBox, moveBox, placeBox, resizeBox, type Box, type Corner } from "../lib/box";

type Drag =
  | { mode: "move" | Corner; x: number; y: number; box: Box; w: number; h: number }
  | { mode: "draw"; x: number; y: number; fx: number; fy: number; w: number; h: number };

/** A press that moves less than this many screen pixels is a click. */
const CLICK_PX = 4;

const CORNERS: Array<{ c: Corner; at: string; cursor: string }> = [
  { c: "nw", at: "left-0 top-0 -translate-x-1/2 -translate-y-1/2", cursor: "cursor-nwse-resize" },
  { c: "ne", at: "right-0 top-0 translate-x-1/2 -translate-y-1/2", cursor: "cursor-nesw-resize" },
  { c: "sw", at: "left-0 bottom-0 -translate-x-1/2 translate-y-1/2", cursor: "cursor-nesw-resize" },
  { c: "se", at: "right-0 bottom-0 translate-x-1/2 translate-y-1/2", cursor: "cursor-nwse-resize" },
];

// Laid over the photo inside a zoom layer: positions come from the layer's on-screen rectangle, so a
// drag means the same share of the photo at any zoom, and `zoom` keeps lines and handles one size.
export default function BoxEditor({
  box,
  onChange,
  shortcuts,
  zoom = 1,
  label,
}: {
  box: Box;
  onChange: (box: Box) => void;
  /** The detector's boxes, numbered from 1; a click inside one moves the box to it. */
  shortcuts: Box[];
  zoom?: number;
  label: string;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  const start = (e: ReactPointerEvent, mode: "move" | Corner | "draw") => {
    if (e.button !== 0) return;
    // The zoom frame underneath would pan or open the photo.
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const r = layer.current!.getBoundingClientRect();
    drag.current =
      mode === "draw"
        ? {
            mode,
            x: e.clientX,
            y: e.clientY,
            fx: (e.clientX - r.left) / r.width,
            fy: (e.clientY - r.top) / r.height,
            w: r.width,
            h: r.height,
          }
        : { mode, x: e.clientX, y: e.clientY, box, w: r.width, h: r.height };
  };
  const move = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    e.stopPropagation();
    const dx = (e.clientX - d.x) / d.w;
    const dy = (e.clientY - d.y) / d.h;
    if (d.mode === "draw") {
      if (Math.abs(e.clientX - d.x) >= CLICK_PX || Math.abs(e.clientY - d.y) >= CLICK_PX)
        onChange(boxBetween(d.fx, d.fy, d.fx + dx, d.fy + dy));
    } else onChange(d.mode === "move" ? moveBox(d.box, dx, dy) : resizeBox(d.box, d.mode, dx, dy));
  };
  const end = (e: ReactPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    e.stopPropagation();
    if (d?.mode !== "draw" || Math.abs(e.clientX - d.x) >= CLICK_PX || Math.abs(e.clientY - d.y) >= CLICK_PX) return;
    // A click: the smallest numbered box under it.
    const hit = shortcuts.filter((s) => insideBox(s, d.fx, d.fy)).sort((a, b) => boxArea(a) - boxArea(b))[0];
    if (hit) onChange(hit);
  };
  const px = (n: number) => `${n / zoom}px`;
  return (
    <div
      ref={layer}
      role="application"
      aria-label={label}
      data-testid="box-editor"
      className="pointer-events-auto absolute inset-0 z-10 cursor-crosshair touch-none select-none"
      onPointerDown={(e) => start(e, "draw")}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={() => (drag.current = null)}
      // Not the zoom frame's open-on-click or zoom-on-double-click.
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {shortcuts.map((s, i) => (
        <div
          key={i}
          aria-hidden
          data-shortcut
          // design-token: a dashed line over the photo, white in both themes so it shows on any photo.
          className="pointer-events-none absolute border-dashed border-white/70"
          style={{ ...placeBox(s), borderWidth: px(1) }}
        >
          <span
            // design-token: the number's dark backing over the photo, as on the overlay pills.
            className="absolute left-0 top-0 origin-top-left bg-black/60 px-1 text-caption font-semibold tabular-nums text-white"
            style={{ transform: `scale(${1 / zoom})` }}
          >
            {i + 1}
          </span>
        </div>
      ))}
      <div
        data-testid="box-editor-box"
        onPointerDown={(e) => start(e, "move")}
        // design-token: the box and the dimmed photo round it, as in CardCropEditor.
        className="absolute cursor-move border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.4)]"
        style={{ ...placeBox(box), borderWidth: px(2) }}
      >
        {CORNERS.map(({ c, at, cursor }) => (
          <div
            key={c}
            data-corner={c}
            onPointerDown={(e) => start(e, c)}
            // design-token: the white handle with a dark rim, as in CardCropEditor.
            className={`absolute ${at} ${cursor} rounded-full border-black/80 bg-white`}
            style={{ width: px(16), height: px(16), borderWidth: px(2) }}
          />
        ))}
      </div>
    </div>
  );
}
