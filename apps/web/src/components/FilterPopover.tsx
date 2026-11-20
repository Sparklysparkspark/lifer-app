import { useEffect, useRef, useState } from "react";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import Pill from "./Pill";
import { IconButton } from "./Button";
import { useLatest } from "../hooks/useLatest";
import { useExclusiveOpen } from "../lib/exclusivePopover";

// The Filters button and panel shared by every grid page (and the collection's View options).
// Callers supply the sections.
export default function FilterPopover({
  activeCount,
  label = "Filters",
  active,
  icon,
  iconClassName,
  up,
  tooltip,
  open: openProp,
  onOpenChange,
  children,
}: {
  activeCount: number;
  label?: string;
  /** Highlights the button without a count, e.g. a mode that is on. */
  active?: boolean;
  /** An icon-only button instead of the labelled pill; `label` becomes its name and tooltip. */
  icon?: React.ReactNode;
  /** Extra classes for the icon button (e.g. a translucent map control). */
  iconClassName?: string;
  /** Opens above the trigger, for one at the bottom of its area. */
  up?: boolean;
  /** Hover text for the icon or link trigger. */
  tooltip?: string;
  /** Controlled open state, for a caller that also opens or closes it (hover, timers). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = openProp ?? ownOpen;
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setOwnOpen(next);
    onOpenChange?.(next);
  };
  const closeRef = useLatest(() => setOpen(false));
  const ref = useRef<HTMLDivElement>(null);
  // Opening this closes any other popover or menu that's open.
  useExclusiveOpen(open, () => closeRef.current());

  useEffect(() => {
    if (!open) return;
    const closeIfOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current();
    };
    document.addEventListener("click", closeIfOutside);
    return () => document.removeEventListener("click", closeIfOutside);
  }, [open, closeRef]);
  useEscapeToClose(() => closeRef.current(), open);

  return (
    <div className="relative" ref={ref}>
      {icon ? (
        // A neutral control: a mode that is on shows inside the icon, not as a filled button.
        <IconButton
          aria-label={label}
          aria-expanded={open}
          tooltip={tooltip ? { label: tooltip } : undefined}
          className={iconClassName}
          onClick={() => setOpen(!open)}
        >
          {icon}
        </IconButton>
      ) : (
        <Pill active={active ?? activeCount > 0} onClick={() => setOpen(!open)}>
          {label}
          {activeCount > 0 ? ` (${activeCount})` : ""}
        </Pill>
      )}
      {open && (
        // A click inside (which may re-render the panel) must not reach the outside-click listener.
        // On a phone it spans the window below its button, so a button near the left edge can't
        // push it off screen.
        <div
          className={
            up
              ? "absolute bottom-full right-0 z-20 mb-1 max-h-56 w-80 max-w-[calc(100vw-2rem)] space-y-3 overflow-y-auto rounded-panel border border-line bg-surface p-3 shadow-lg"
              : // As wide as its contents, within bounds, so a short menu isn't a wide panel.
                "absolute right-0 top-full z-20 mt-1 w-max min-w-56 max-w-80 space-y-3 rounded-panel border border-line bg-surface p-3 shadow-lg max-sm:fixed max-sm:inset-x-4 max-sm:top-auto max-sm:max-h-[70vh] max-sm:w-auto max-sm:overflow-y-auto"
          }
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function FilterGroupLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-footnote font-medium uppercase tracking-wide text-muted">{children}</p>;
}

/** A section's title in a popover with several sections: set above its fields' muted labels. */
export function FilterSectionHeading({ children }: { children: React.ReactNode }) {
  return <p className="mb-1.5 text-footnote font-semibold text-ink">{children}</p>;
}

export function FilterFieldLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-1 text-footnote text-muted">{children}</p>;
}
