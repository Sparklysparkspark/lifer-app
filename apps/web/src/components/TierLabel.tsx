// The one way a rarity tier is shown: a quiet pill. Cards, tree rows and the detail pane all use it
// so a tier never changes shape between views. Swatch is only for the rarity scale's legend.
import type { ReactNode } from "react";

/** A legend dot on the rarity scale. */
export function Swatch({ className }: { className: string }) {
  return <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-full ${className}`} />;
}

/** The one way a tier reads: a quiet pill with plain wording and an optional scope ("here", "worldwide"). */
export default function TierLabel({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-block max-w-full rounded-badge bg-surface-muted px-1.5 py-0.5 text-footnote break-words text-muted"
    >
      {children}
    </span>
  );
}
