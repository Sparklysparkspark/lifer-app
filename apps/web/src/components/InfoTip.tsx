import { useEffect, useRef, useState } from "react";

// Small click-to-toggle explainer popover — same outside-click-dismiss pattern as the "⋯"
// menus on SpeciesCard/TripDetailPage, just for a plain block of help text instead of actions.
// `align` controls which side the popover grows from: "left" (the default) anchors its LEFT
// edge to the button and grows rightward, right for a button that sits near the left of the
// page; "right" anchors its right edge and grows leftward, right for a button near the right
// edge (e.g. TripsPage's, next to "New trip") so the popover doesn't run off the viewport.
export default function InfoTip({
  paragraphs,
  align = "left",
  className,
}: {
  paragraphs: string[];
  align?: "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("click", onClickOutside);
    return () => document.removeEventListener("click", onClickOutside);
  }, [open]);

  return (
    <div ref={ref} className={`relative inline-block ${className ?? ""}`}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        aria-label="More info"
        className="flex h-5 w-5 items-center justify-center rounded-full border border-line text-xs font-medium text-muted hover:bg-surface-muted"
      >
        i
      </button>
      {open && (
        <div
          className={`absolute z-20 mt-2 w-72 space-y-2 rounded-md border border-line bg-surface p-3 text-left text-xs leading-relaxed text-muted shadow-lg ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {paragraphs.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      )}
    </div>
  );
}
