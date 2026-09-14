import { useEffect, useRef, useState } from "react";
import Pill from "./Pill";

// The Filters button + dropdown panel shell — one shared shape (Pill trigger, panel width,
// section spacing, outside-click-to-close) used by every photo grid page (Gallery, Collection,
// Album, Trip) instead of each page hand-rolling its own slightly-different popover. Callers
// just supply the filter/display sections as children; this owns open/close and positioning.
export default function FilterPopover({ activeCount, children }: { activeCount: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeIfOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("click", closeIfOutside);
    return () => document.removeEventListener("click", closeIfOutside);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <Pill active={activeCount > 0} onClick={() => setOpen((v) => !v)}>
        Filters{activeCount > 0 ? ` (${activeCount})` : ""}
      </Pill>
      {open && (
        // stopPropagation: a click anywhere inside (e.g. a region pill re-rendering this panel
        // via a state update) must never reach the outside-click listener above, which would
        // close the panel the instant a filter is picked instead of leaving it open.
        <div
          className="absolute right-0 top-full z-20 mt-1 w-80 space-y-3 rounded-md border border-line bg-surface p-3 shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function FilterGroupLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{children}</p>;
}

export function FilterFieldLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-1 text-[11px] text-muted">{children}</p>;
}
