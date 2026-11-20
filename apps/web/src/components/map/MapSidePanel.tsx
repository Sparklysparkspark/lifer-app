import { useRef, type ReactNode } from "react";
import { matches } from "../../lib/keymap";
import { useTranslation } from "react-i18next";
import { IconButton } from "../Button";

export const SIDE_MIN = 280;
export const SIDE_MAX = 640;
const clamp = (w: number) => Math.round(Math.min(SIDE_MAX, Math.max(SIDE_MIN, w)));

/** The map's side column: one panel at a time beside the map, resizable from its left edge. Under
 *  900 pixels it sits under the map at full width instead. */
export default function MapSidePanel({
  title,
  detail,
  width,
  onWidthChange,
  onClose,
  children,
}: {
  title: string;
  /** A muted line under the title (a count, a date range). */
  detail?: ReactNode;
  width: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const drag = useRef<{ x: number; width: number } | null>(null);
  return (
    <aside
      aria-label={title}
      data-testid="map-side-panel"
      style={{ "--side-w": `${width}px` } as React.CSSProperties}
      // design-token: the plan's 900 px breakpoint, where the column moves under the map
      className="relative flex max-h-[70vh] min-h-0 w-full flex-col rounded-panel border border-line bg-surface min-[900px]:h-[var(--map-h,36rem)] min-[900px]:max-h-none min-[900px]:w-(--side-w) min-[900px]:shrink-0"
    >
      {/* raw-control: a resize handle, with arrow keys for the keyboard. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("gallery.map.resizePanel")}
        aria-valuenow={width}
        aria-valuemin={SIDE_MIN}
        aria-valuemax={SIDE_MAX}
        tabIndex={0}
        // design-token: the same 900 px breakpoint
        className="absolute inset-y-0 -left-1.5 hidden w-3 cursor-col-resize rounded-control focus-visible:outline-2 focus-visible:outline-accent min-[900px]:block"
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, width };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => drag.current && onWidthChange(clamp(drag.current.width + drag.current.x - e.clientX))}
        onPointerUp={() => (drag.current = null)}
        onKeyDown={(e) => {
          if (matches(e, "stepDown") || matches(e, "stepUp")) {
            e.preventDefault();
            onWidthChange(clamp(width + (matches(e, "stepDown") ? 24 : -24)));
          }
        }}
      />
      <header className="flex shrink-0 items-start gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-headline font-semibold text-ink">{title}</h2>
          {detail && <p className="text-footnote text-muted">{detail}</p>}
        </div>
        <IconButton
          tone="plain"
          onClick={onClose}
          aria-label={t("gallery.map.closePanel")}
          className="text-title-3 leading-none hover:bg-surface-muted"
        >
          ×
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
    </aside>
  );
}
