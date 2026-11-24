/** Disclosure chevron: points right when the group is closed, down when open. Use it for every
 *  expand and collapse control rather than a "›" or "▸" glyph. */
export default function Chevron({ open, className = "" }: { open: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`h-4 w-4 shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""} ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export { Chevron };
