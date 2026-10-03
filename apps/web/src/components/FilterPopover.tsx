import { useEffect, useRef, useState } from "react";
import Pill from "./Pill";

// The Filters button and panel shared by every grid page. Callers supply the sections.
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
        // A click inside (which may re-render the panel) must not reach the outside-click listener.
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
