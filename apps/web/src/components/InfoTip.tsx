import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import { useAnchoredBox } from "../lib/anchoredBox";
import { useExclusiveOpen } from "../lib/exclusivePopover";

// Click-to-toggle help text, portaled so no clipping parent cuts it. `align="right"` grows leftward,
// for a button near the right edge; it flips above on its own near the bottom of the window.
export default function InfoTip({
  paragraphs,
  align = "left",
  className,
}: {
  paragraphs: string[];
  align?: "left" | "right";
  className?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const box = useAnchoredBox(open, buttonRef, boxRef, align === "right");

  useExclusiveOpen(open, () => setOpen(false));
  useEscapeToClose(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, open);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !boxRef.current?.contains(t)) setOpen(false);
    }
    document.addEventListener("click", onClickOutside);
    return () => document.removeEventListener("click", onClickOutside);
  }, [open]);

  return (
    <div ref={ref} className={`relative inline-flex items-center ${className ?? ""}`}>
      {/* raw-control: the info glyph itself is this shared component. */}
      <button
        ref={buttonRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        aria-label={t("ui.moreInfo")}
        aria-expanded={open}
        className="flex h-6 w-6 items-center justify-center rounded-full text-muted hover:text-ink focus-visible:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        {/* Same glyph and stroke as the map credits icon. */}
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5M12 8h.01" />
        </svg>
      </button>
      {open &&
        createPortal(
          <div
            ref={boxRef}
            role="note"
            style={box ?? { visibility: "hidden" }}
            className="fixed z-50 space-y-2 overflow-y-auto rounded-panel border border-line bg-surface p-3 text-left text-footnote leading-relaxed text-muted shadow-lg"
          >
            {paragraphs.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
